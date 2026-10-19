import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { POST as signup } from "@/app/api/auth/signup/route";
import { GET as me } from "@/app/api/me/route";
import { POST as teamInvite } from "@/app/api/team/invite/route";
import { POST as inviteSignup } from "@/app/api/invitations/signup/route";
import { GET as getDashboard } from "@/app/api/dashboard/route";
import { createOrder } from "@/lib/orders/service";
import { buildChecklist, buildDashboard, DASH_DAYS, fillDays, pctChange, sumDays, type DashboardData } from "@/lib/dashboard/stats";
import { niceMax, shortDay } from "@/components/DayChart";
import { getPool, withTenant } from "@/lib/db";

const RUN = randomUUID().slice(0, 8);
const ORIGIN = new URL(process.env.APP_URL!).origin;
const PASSWORD = "contraseña-de-prueba-123";
const owner = new Pool({ connectionString: process.env.MIGRATION_DATABASE_URL, max: 2 });
const tenantIds: string[] = [];
const planIds: string[] = [];

function api(method: string, path: string, cookie?: string, body?: unknown, origin = ORIGIN) {
  return new Request(`${ORIGIN}${path}`, {
    method,
    headers: { origin, ...(body !== undefined ? { "content-type": "application/json" } : {}), ...(cookie ? { cookie } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

async function register(name: string) {
  const email = `db-${RUN}-${name}@example.test`;
  const res = await signup(api("POST", "/api/auth/signup", undefined, { email, password: PASSWORD, businessName: `Negocio ${name}` }));
  expect(res.status).toBe(201);
  const cookie = (res.headers.get("set-cookie") ?? "").split(";")[0]!;
  const info = await (await me(api("GET", "/api/me", cookie))).json();
  tenantIds.push(info.tenant.id);
  return { tenantId: info.tenant.id as string, cookie };
}
type T = Awaited<ReturnType<typeof register>>;
async function member(t: T, role: "admin" | "agent"): Promise<T> {
  const inv = await teamInvite(api("POST", "/api/team/invite", t.cookie, { email: `db-${RUN}-${role}-${randomUUID().slice(0, 6)}@example.test`, role }));
  expect(inv.status).toBe(201);
  const token = ((await inv.json()).inviteUrl as string).split("/").pop()!;
  const ok = await inviteSignup(api("POST", "/api/invitations/signup", undefined, { token, password: PASSWORD }));
  expect(ok.status).toBe(201);
  return { tenantId: t.tenantId, cookie: (ok.headers.get("set-cookie") ?? "").split(";")[0]! };
}
beforeAll(async () => { await getPool().query("SELECT 1"); });
afterAll(async () => {
  await owner.query("DELETE FROM users WHERE email LIKE $1", [`db-${RUN}-%`]);
  for (const id of tenantIds) {
    const c = await owner.connect();
    try {
      await c.query("BEGIN");
      await c.query("SELECT set_config('app.tenant_id', $1, true)", [id]);
      await c.query("ALTER TABLE audit_log DISABLE TRIGGER audit_log_sin_cambios");
      await c.query("DELETE FROM audit_log WHERE tenant_id = $1", [id]);
      await c.query("ALTER TABLE audit_log ENABLE TRIGGER audit_log_sin_cambios");
      const del = await c.query("DELETE FROM tenants WHERE id = $1", [id]);
      if (del.rowCount !== 1) throw new Error("La limpieza no borró el negocio de prueba " + id);
      await c.query("COMMIT");
    } catch (e) {
      await c.query("ROLLBACK");
      throw e;
    } finally {
      c.release();
    }
  }
  for (const id of planIds) await owner.query("DELETE FROM plans WHERE id = $1", [id]);
  await owner.end();
  await getPool().end();
});


type Db = Parameters<Parameters<typeof withTenant>[1]>[0];
const NOW = new Date("2026-11-05T15:00:00Z"); // 11:00 en Caracas; hoy = 2026-11-05
const dash = (t: T, now = NOW) => withTenant(t.tenantId, (db) => buildDashboard(db, t.tenantId, now));

async function setModules(tenantId: string, modules: string[]) {
  const slug = `d-${RUN}-${planIds.length}`;
  const r = await owner.query<{ id: string }>("INSERT INTO plans (slug, name, position, max_replies_month, max_members, modules) VALUES ($1,$2,99,100,5,$3) RETURNING id", [slug, slug, modules]);
  planIds.push(r.rows[0]!.id);
  const c = await owner.connect();
  try {
    await c.query("BEGIN");
    await c.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
    await c.query("ALTER TABLE tenants DISABLE TRIGGER tenants_plan_guard");
    await c.query("UPDATE tenants SET plan_id = $2 WHERE id = $1", [tenantId, r.rows[0]!.id]);
    await c.query("ALTER TABLE tenants ENABLE TRIGGER tenants_plan_guard");
    await c.query("COMMIT");
  } catch (e) { await c.query("ROLLBACK"); throw e; } finally { c.release(); }
}
async function conv(db: Db, t: T) {
  const c = (await db.query("INSERT INTO contacts (tenant_id, wa_id) VALUES ($1, $2) RETURNING id", [t.tenantId, `5841${String(Math.random()).slice(2, 11)}`])).rows[0].id as string;
  return (await db.query("INSERT INTO conversations (tenant_id, contact_id, status) VALUES ($1,$2,'bot') RETURNING id", [t.tenantId, c])).rows[0].id as string;
}
const msg = (db: Db, t: T, c: string, direction: "in" | "out", at: string) =>
  db.query("INSERT INTO messages (tenant_id, conversation_id, direction, body, created_at) VALUES ($1,$2,$3,'x',$4)", [t.tenantId, c, direction, at]);
const day = (d: DashboardData, ymd: string) => d.days.find((x) => x.day === ymd)!;

describe("funciones puras del panel", () => {
  it("fillDays: 14 días seguidos hasta hoy, con ceros donde no hay datos", () => {
    const d = fillDays("2026-03-02", new Map([["2026-03-01", { inbound: 4 }], ["2026-02-28", { outbound: 2 }]]));
    expect(d).toHaveLength(DASH_DAYS);
    expect(d[0]!.day).toBe("2026-02-17");
    expect(d.at(-1)!.day).toBe("2026-03-02");
    expect(d.find((x) => x.day === "2026-03-01")).toEqual({ day: "2026-03-01", inbound: 4, outbound: 0, appointments: 0, orders: 0 });
    expect(d.find((x) => x.day === "2026-02-28")!.outbound).toBe(2);
    expect(new Set(d.map((x) => x.day)).size).toBe(DASH_DAYS);
  });
  it("sumDays suma solo el tramo pedido", () => {
    const d = fillDays("2026-03-14", new Map(Array.from({ length: 14 }, (_, i) => [`2026-03-${String(i + 1).padStart(2, "0")}`, { inbound: i + 1 }] as const)));
    expect(sumDays(d, "inbound", 7, 14)).toBe(8 + 9 + 10 + 11 + 12 + 13 + 14);
    expect(sumDays(d, "inbound", 0, 7)).toBe(28);
  });
  it("pctChange: sin base no inventa un porcentaje", () => {
    expect(pctChange({ current: 5, previous: 0 })).toBeNull();
    expect(pctChange({ current: 0, previous: 0 })).toBeNull();
    expect(pctChange({ current: 15, previous: 10 })).toBe(50);
    expect(pctChange({ current: 5, previous: 10 })).toBe(-50);
    expect(pctChange({ current: 10, previous: 10 })).toBe(0);
  });
  it("niceMax y etiquetas de día", () => {
    expect([0, 1, 4, 5, 9, 11, 23, 51, 101, 999].map(niceMax)).toEqual([4, 4, 4, 5, 10, 20, 50, 100, 200, 1000]);
    expect(shortDay("2026-11-05")).toBe("5/11");
  });
  it("checklist: seis pasos, cada uno con enlace y estado", () => {
    const none = buildChecklist({ whatsapp: false, agent: false, kb: false, catalog: false, team: false, message: false });
    expect(none).toHaveLength(6);
    expect(none.every((c) => !c.done && c.href.startsWith("/"))).toBe(true);
    expect(buildChecklist({ whatsapp: true, agent: false, kb: false, catalog: false, team: false, message: true }).filter((c) => c.done).map((c) => c.key)).toEqual(["whatsapp", "mensaje"]);
  });
});

describe("cálculo del panel", () => {
  it("negocio nuevo: ceros, 14 días y ningún paso hecho", async () => {
    const t = await register("vacio");
    const d = await dash(t);
    expect(d.days).toHaveLength(14);
    expect(d.today).toBe("2026-11-05");
    expect(d.days.every((x) => x.inbound === 0 && x.outbound === 0 && x.appointments === 0 && x.orders === 0)).toBe(true);
    expect(d.checklist.filter((c) => c.done)).toEqual([]);
    expect(d.week.sales).toEqual([]);
    expect(d.week.people).toEqual({ current: 0, previous: 0 });
    expect(d.onboarding).toBe("pending");
    await withTenant(t.tenantId, (db) => db.query("UPDATE tenants SET onboarding_state = 'skipped' WHERE id = $1", [t.tenantId]));
    expect((await dash(t)).onboarding).toBe("skipped");
  });

  it("los mensajes caen en el día del negocio (medianoche local, no UTC) y se comparan semanas", async () => {
    const t = await register("msgs");
    await withTenant(t.tenantId, async (db) => {
      const a = await conv(db, t);
      const b = await conv(db, t);
      await msg(db, t, a, "in", "2026-11-05T03:59:59Z"); // 23:59 del 4 en Caracas
      await msg(db, t, a, "in", "2026-11-05T04:00:00Z"); // 00:00 del 5
      await msg(db, t, b, "in", "2026-11-05T14:00:00Z");
      await msg(db, t, a, "out", "2026-11-05T14:05:00Z");
      await msg(db, t, a, "in", "2026-10-30T15:00:00Z"); // semana actual (hace 6 días)
      await msg(db, t, b, "in", "2026-10-29T15:00:00Z"); // semana anterior
      await msg(db, t, b, "in", "2026-10-23T15:00:00Z"); // primer día visible (hace 13)
      await msg(db, t, b, "in", "2026-10-22T15:00:00Z"); // fuera de la ventana: no cuenta
      await msg(db, t, b, "in", "2026-11-06T04:00:00Z"); // mañana: no cuenta
    });
    const d = await dash(t);
    expect(day(d, "2026-11-04").inbound).toBe(1);
    expect(day(d, "2026-11-05")).toMatchObject({ inbound: 2, outbound: 1 });
    expect(day(d, "2026-10-23").inbound).toBe(1);
    expect(d.days.reduce((s, x) => s + x.inbound, 0)).toBe(6);
    expect(d.week.inbound).toEqual({ current: 4, previous: 2 });
    // personas distintas que escribieron: esta semana a y b; la anterior solo b
    expect(d.week.people).toEqual({ current: 2, previous: 1 });
  });

  it("la zona horaria del negocio mueve los mensajes de día", async () => {
    const t = await register("tz");
    await withTenant(t.tenantId, async (db) => {
      await db.query("INSERT INTO agenda_settings (tenant_id, timezone, min_notice_minutes, max_days_ahead, slot_step_minutes) VALUES ($1,'Pacific/Auckland',0,60,30)", [t.tenantId]);
      const c = await conv(db, t);
      await msg(db, t, c, "in", "2026-11-05T12:00:00Z"); // en Auckland ya es 6 de noviembre
    });
    const d = await dash(t);
    expect(d.today).toBe("2026-11-06");
    expect(day(d, "2026-11-06").inbound).toBe(1);
    expect(day(d, "2026-11-05").inbound).toBe(0);
  });

  it("citas y pedidos por día; los cancelados no cuentan; ventas por moneda", async () => {
    const t = await register("mods");
    await withTenant(t.tenantId, async (db) => {
      const svc = (await db.query("INSERT INTO agenda_services (tenant_id, name, duration_minutes) VALUES ($1,'Corte',30) RETURNING id", [t.tenantId])).rows[0].id as string;
      const ap = (iso: string, status: string) => db.query("INSERT INTO appointments (tenant_id, service_id, customer_name, starts_at, ends_at, status, source) VALUES ($1,$2,'Ana',$3::timestamptz,$3::timestamptz + interval '30 minutes',$4,'manual')", [t.tenantId, svc, iso, status]);
      await ap("2026-11-05T14:00:00Z", "confirmada");
      await ap("2026-11-05T15:00:00Z", "completada");
      await ap("2026-11-05T16:00:00Z", "cancelada");
      await ap("2026-11-03T14:00:00Z", "pendiente");
      const p = (await db.query("INSERT INTO catalog_products (tenant_id, name, price_minor, stock) VALUES ($1,'Arroz',1000,NULL) RETURNING id", [t.tenantId])).rows[0].id as string;
      const o1 = await createOrder(db, { tenantId: t.tenantId, source: "agente", status: "pendiente", customerName: "Cli", items: [{ productId: p, quantity: 2 }] });
      const o2 = await createOrder(db, { tenantId: t.tenantId, source: "agente", status: "pendiente", customerName: "Cli", items: [{ productId: p, quantity: 1 }] });
      for (const o of [o1, o2]) await db.query("UPDATE orders SET created_at = $2 WHERE tenant_id = $3 AND id = $1", [(o as { id: string }).id, "2026-11-05T14:00:00Z", t.tenantId]);
      await db.query("UPDATE orders SET status = 'cancelado', cancelled_at = now() WHERE tenant_id = $1 AND id = $2", [t.tenantId, (o2 as { id: string }).id]);
    });
    const d = await dash(t);
    expect(day(d, "2026-11-05").appointments).toBe(2);
    expect(day(d, "2026-11-03").appointments).toBe(1);
    expect(day(d, "2026-11-05").orders).toBe(1);
    expect(d.week.appointments.current).toBe(3);
    expect(d.week.sales).toEqual([{ currency: expect.any(String), totalMinor: 2000 }]);
  });

  it("un plan sin agenda ni catálogo no calcula ni muestra esos módulos", async () => {
    const t = await register("plan");
    await withTenant(t.tenantId, async (db) => {
      const svc = (await db.query("INSERT INTO agenda_services (tenant_id, name, duration_minutes) VALUES ($1,'Corte',30) RETURNING id", [t.tenantId])).rows[0].id as string;
      await db.query("INSERT INTO appointments (tenant_id, service_id, customer_name, starts_at, ends_at, status, source) VALUES ($1,$2,'Ana','2026-11-05T14:00:00Z','2026-11-05T14:30:00Z','confirmada','manual')", [t.tenantId, svc]);
    });
    expect((await dash(t)).week.appointments.current).toBe(1);
    await setModules(t.tenantId, ["copiloto"]);
    const d = await dash(t);
    expect(d.modules).toEqual(["copiloto"]);
    expect(d.days.every((x) => x.appointments === 0 && x.orders === 0)).toBe(true);
    expect(d.week.sales).toEqual([]);
  });

  it("primeros pasos: se marcan solos con lo que el negocio ya hizo", async () => {
    const t = await register("pasos");
    const phone = `9${RUN}${Math.floor(Math.random() * 1e6)}`;
    await owner.query("INSERT INTO tenant_integrations (tenant_id, provider, external_id, secret_enc, key_version) VALUES ($1,'whatsapp',$2,'x',1)", [t.tenantId, phone]);
    await withTenant(t.tenantId, async (db) => {
      await db.query("INSERT INTO tenant_agents (tenant_id, enabled) VALUES ($1, true) ON CONFLICT (tenant_id) DO UPDATE SET enabled = true", [t.tenantId]);
      await db.query("INSERT INTO kb_documents (tenant_id, title, content, status) VALUES ($1,'Horario','Abrimos de 8 a 5','ready')", [t.tenantId]);
      await db.query("INSERT INTO catalog_products (tenant_id, name, price_minor) VALUES ($1,'Arroz',100)", [t.tenantId]);
      const c = await conv(db, t);
      await msg(db, t, c, "in", "2026-11-05T14:00:00Z");
    });
    const done = (await dash(t)).checklist.filter((c) => c.done).map((c) => c.key);
    expect(done.sort()).toEqual(["agente", "catalogo", "conocimiento", "mensaje", "whatsapp"]);
    await member(t, "agent");
    expect((await dash(t)).checklist.find((c) => c.key === "equipo")!.done).toBe(true);
  });

  it("una invitación pendiente cuenta como equipo; un documento aún sin indexar no cuenta como conocimiento", async () => {
    const t = await register("inv");
    await withTenant(t.tenantId, (db) => db.query("INSERT INTO kb_documents (tenant_id, title, content, status) VALUES ($1,'Horario','Abrimos','pending')", [t.tenantId]));
    expect((await dash(t)).checklist.filter((c) => c.done).map((c) => c.key)).toEqual([]);
    const inv = await teamInvite(api("POST", "/api/team/invite", t.cookie, { email: `db-${RUN}-pend-${randomUUID().slice(0, 6)}@example.test`, role: "agent" }));
    expect(inv.status).toBe(201);
    expect((await dash(t)).checklist.filter((c) => c.done).map((c) => c.key)).toEqual(["equipo"]);
  });

  it("aislamiento: un negocio no ve los mensajes de otro", async () => {
    const a = await register("iso-a");
    const b = await register("iso-b");
    await withTenant(a.tenantId, async (db) => { const c = await conv(db, a); await msg(db, a, c, "in", "2026-11-05T14:00:00Z"); });
    expect((await dash(a)).week.inbound.current).toBe(1);
    expect((await dash(b)).week.inbound.current).toBe(0);
  });
});

describe("GET /api/dashboard", () => {
  it("sin sesión: 401; con sesión: solo las cifras de su negocio", async () => {
    expect((await getDashboard(api("GET", "/api/dashboard"))).status).toBe(401);
    const t = await register("api");
    const res = await getDashboard(api("GET", "/api/dashboard", t.cookie));
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toMatch(/no-store/);
    const j = await res.json();
    expect(j.dashboard.days).toHaveLength(14);
    expect(JSON.stringify(j)).not.toContain(t.tenantId);
  });
  it("un agente del negocio también puede verlo", async () => {
    const t = await register("rol");
    const ag = await member(t, "agent");
    expect((await getDashboard(api("GET", "/api/dashboard", ag.cookie))).status).toBe(200);
  });
});
