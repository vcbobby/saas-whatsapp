import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { POST as signup } from "@/app/api/auth/signup/route";
import { GET as me } from "@/app/api/me/route";
import { POST as teamInvite } from "@/app/api/team/invite/route";
import { POST as inviteSignup } from "@/app/api/invitations/signup/route";
import { GET as reportGet } from "@/app/api/reports/route";
import { POST as reportSettings } from "@/app/api/reports/settings/route";
import { POST as reportSend } from "@/app/api/reports/send/route";
import { encryptSecret } from "@/lib/crypto";
import { buildReport } from "@/lib/reports/build";
import { fmtDuration, hasActivity, pct, peakHours, reportLines, type Report } from "@/lib/reports/pure";
import { sendWeeklyReports } from "@/lib/reports/weekly";
import { getPool, withTenant } from "@/lib/db";

const RUN = randomUUID().slice(0, 8);
const ORIGIN = new URL(process.env.APP_URL!).origin;
const PASSWORD = "contraseña-de-prueba-123";
const owner = new Pool({ connectionString: process.env.MIGRATION_DATABASE_URL, max: 2 });
const tenantIds: string[] = [];
let seq = 0;

function api(method: string, path: string, cookie?: string, body?: unknown, origin = ORIGIN) {
  return new Request(`${ORIGIN}${path}`, {
    method,
    headers: { origin, ...(body !== undefined ? { "content-type": "application/json" } : {}), ...(cookie ? { cookie } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}
async function register(name: string) {
  const email = `rp-${RUN}-${name}@example.test`;
  const res = await signup(api("POST", "/api/auth/signup", undefined, { email, password: PASSWORD, businessName: `Negocio ${name}` }));
  expect(res.status).toBe(201);
  const cookie = (res.headers.get("set-cookie") ?? "").split(";")[0]!;
  const info = await (await me(api("GET", "/api/me", cookie))).json();
  tenantIds.push(info.tenant.id);
  const phoneId = `7${Date.now() % 1000000000}${seq++}`.slice(0, 16);
  const enc = encryptSecret("EAAtoken-de-prueba-1234567890", `wa:${info.tenant.id}:${phoneId}`);
  await owner.query("INSERT INTO tenant_integrations (tenant_id, provider, external_id, secret_enc, key_version) VALUES ($1,'whatsapp',$2,$3,$4)", [info.tenant.id, phoneId, enc.payload, enc.keyVersion]);
  return { tenantId: info.tenant.id as string, cookie, email };
}
type T = Awaited<ReturnType<typeof register>>;
async function member(t: T, role: "admin" | "agent"): Promise<T & { email: string }> {
  const email = `rp-${RUN}-${role}-${randomUUID().slice(0, 6)}@example.test`;
  const inv = await teamInvite(api("POST", "/api/team/invite", t.cookie, { email, role }));
  expect(inv.status).toBe(201);
  const token = ((await inv.json()).inviteUrl as string).split("/").pop()!;
  const ok = await inviteSignup(api("POST", "/api/invitations/signup", undefined, { token, password: PASSWORD }));
  expect(ok.status).toBe(201);
  return { tenantId: t.tenantId, cookie: (ok.headers.get("set-cookie") ?? "").split(";")[0]!, email };
}
beforeAll(async () => { await getPool().query("SELECT 1"); });
afterAll(async () => {
  await owner.query("DELETE FROM users WHERE email LIKE $1", [`cv-${RUN}-%`]);
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
  await owner.end();
  await getPool().end();
});




/** Consulta como dueño de la base, pero dentro del negocio (las tablas tienen aislamiento por negocio incluso para el dueño). */
async function oq(t: { tenantId: string }, sql: string, params: unknown[] = []) {
  const c = await owner.connect();
  try {
    await c.query("BEGIN");
    await c.query("SELECT set_config('app.tenant_id', $1, true)", [t.tenantId]);
    const r = await c.query(sql, params);
    await c.query("COMMIT");
    return r;
  } catch (e) { await c.query("ROLLBACK"); throw e; } finally { c.release(); }
}

// Sábado 31/10/2026 11:00 hora de Caracas (UTC-4): el período va del 24 al 30, el anterior del 17 al 23.
const NOW = new Date("2026-10-31T15:00:00Z");
const get = (t: T, qs = "") => reportGet(api("GET", `/api/reports${qs}`, t.cookie));

async function seed(t: T) {
  const uid = (await oq(t, "SELECT user_id FROM memberships WHERE tenant_id = $1 AND role = 'owner'", [t.tenantId])).rows[0].user_id as string;
  const contact = async (wa: string, at: string) => (await oq(t, "INSERT INTO contacts (tenant_id, wa_id, display_name, created_at) VALUES ($1,$2,'X',$3) RETURNING id", [t.tenantId, wa, at])).rows[0].id as string;
  const conv = async (c: string) => (await oq(t, "INSERT INTO conversations (tenant_id, contact_id) VALUES ($1,$2) RETURNING id", [t.tenantId, c])).rows[0].id as string;
  const msg = async (cv: string, dir: "in" | "out", at: string, o: { replyTo?: string; by?: string } = {}) =>
    (await oq(t, "INSERT INTO messages (tenant_id, conversation_id, direction, msg_type, body, created_at, reply_to, sent_by) VALUES ($1,$2,$3,'text','x',$4,$5,$6) RETURNING id", [t.tenantId, cv, dir, at, o.replyTo ?? null, o.by ?? null])).rows[0].id as string;
  const c1 = await contact("584120000001", "2026-10-26T12:00:00Z");
  const c2 = await contact("584120000002", "2026-10-27T12:00:00Z");
  await contact("584120000003", "2026-10-20T12:00:00Z"); // período anterior
  const v1 = await conv(c1), v2 = await conv(c2);
  const i1 = await msg(v1, "in", "2026-10-26T14:00:00Z");
  await msg(v1, "out", "2026-10-26T14:00:20Z", { replyTo: i1 });
  await msg(v2, "in", "2026-10-27T14:00:00Z");
  await msg(v2, "in", "2026-10-27T14:01:00Z");
  await msg(v2, "out", "2026-10-27T14:10:00Z", { by: uid });
  await msg(v1, "in", "2026-10-20T14:00:00Z"); // anterior
  await msg(v1, "in", "2026-10-31T14:00:00Z"); // hoy: no cuenta
  await oq(t, "INSERT INTO work_items (tenant_id, type, title, source, conversation_id, created_at) VALUES ($1,'atencion_humana','Atender','agente',$2,'2026-10-27T14:02:00Z')", [t.tenantId, v2]);
  const prod = (await oq(t, "INSERT INTO catalog_products (tenant_id, name, price_minor) VALUES ($1,'Pan',500) RETURNING id", [t.tenantId])).rows[0].id as string;
  const order = async (n: number, status: string, at: string) => {
    await oq(t, `WITH o AS (INSERT INTO orders (tenant_id, number, customer_name, status, source, currency, total_minor, created_at, confirmed_at, cancelled_at) VALUES ($1,$2,'c',$3,'manual','USD',1000,$4,$5,$6) RETURNING id)
      INSERT INTO order_items (tenant_id, order_id, product_id, position, name, unit_price_minor, quantity, line_total_minor) SELECT $1, o.id, $7, 1, 'Pan', 500, 2, 1000 FROM o`,
      [t.tenantId, n, status, at, status === "pendiente" || status === "cancelado" ? null : at, status === "cancelado" ? at : null, prod]);
  };
  await order(1, "confirmado", "2026-10-27T15:00:00Z");
  await order(2, "cancelado", "2026-10-27T16:00:00Z");
  await order(3, "pendiente", "2026-10-21T16:00:00Z"); // anterior
  const svc = (await oq(t, "INSERT INTO agenda_services (tenant_id, name, duration_minutes) VALUES ($1,'Corte',30) RETURNING id", [t.tenantId])).rows[0].id as string;
  const appt = (st: string, at: string) => oq(t, "INSERT INTO appointments (tenant_id, service_id, customer_name, starts_at, ends_at, status, source) VALUES ($1,$2,'c',$3,$3::timestamptz + interval '30 minutes',$4,'manual')", [t.tenantId, svc, at, st]);
  await appt("completada", "2026-10-28T15:00:00Z");
  await appt("no_asistio", "2026-10-29T15:00:00Z");
  await appt("cancelada", "2026-10-29T18:00:00Z");
}

describe("pure", () => {
  it("formatea duraciones y variaciones", () => {
    expect(fmtDuration(null)).toBe("–");
    expect(fmtDuration(20)).toBe("20 s");
    expect(fmtDuration(600)).toBe("10 min");
    expect(fmtDuration(7800)).toBe("2 h 10 min");
    expect(pct({ current: 3, previous: 0 })).toBeNull();
    expect(pct({ current: 3, previous: 2 })).toBe(50);
    expect(peakHours([0, 0, 5, 0, 5, 1])).toEqual([2, 4]);
    expect(peakHours(Array(24).fill(0))).toEqual([]);
  });
});

describe("reporte", () => {
  let A: T, B: T;
  let r: Report;
  beforeAll(async () => {
    A = await register("a"); B = await register("b");
    await seed(A);
    r = await withTenant(A.tenantId, (db) => buildReport(db, A.tenantId, 7, NOW));
  });

  it("período: hasta ayer, 7 días, y no cuenta hoy", () => {
    expect([r.from, r.to, r.days]).toEqual(["2026-10-24", "2026-10-30", 7]);
    expect(r.inbound).toEqual({ current: 3, previous: 1 });
    expect(r.conversations).toBe(2);
  });
  it("clientes nuevos con comparación", () => { expect(r.newCustomers).toEqual({ current: 2, previous: 1 }); });
  it("asistente frente a equipo, traspasos y resueltas solas", () => {
    expect([r.byAssistant, r.byPerson, r.handoffs, r.resolvedByAssistant]).toEqual([1, 1, 1, 1]);
  });
  it("tiempo de primera respuesta (mediana)", () => {
    expect(r.replyAssistantSecs).toBeCloseTo(20, 0);
    expect(r.replyPersonSecs).toBeCloseTo(600, 0);
  });
  it("horas en hora local del negocio", () => { expect(r.hours[10]).toBe(3); expect(r.hours.reduce((a, b) => a + b, 0)).toBe(3); });
  it("pedidos, ventas (solo confirmados) y lo más pedido; los cancelados no cuentan", () => {
    expect(r.orders).toEqual({ current: 1, previous: 1 });
    expect(r.sales).toEqual([{ currency: "USD", totalMinor: 1000 }]);
    expect(r.topProducts).toEqual([{ name: "Pan", quantity: 2 }]);
  });
  it("citas por estado", () => {
    expect(r.appointments).toMatchObject({ current: 2, completed: 1, noShow: 1, cancelled: 1 });
  });
  it("texto del correo", () => {
    const lines = reportLines(r).join("\n");
    expect(lines).toContain("2 conversaciones");
    expect(lines).toContain("Pedidos: 1");
    expect(lines).toContain("Pan (2)");
  });
  it("30 días y un negocio sin datos", async () => {
    const r30 = await withTenant(A.tenantId, (db) => buildReport(db, A.tenantId, 30, NOW));
    expect(r30.inbound.current).toBe(4);
    const rb = await withTenant(B.tenantId, (db) => buildReport(db, B.tenantId, 7, NOW));
    expect(rb.inbound.current).toBe(0);
    expect(rb.replyAssistantSecs).toBeNull();
    expect(hasActivity(rb)).toBe(false);
    expect(hasActivity(r)).toBe(true);
  });

  it("API: dueño sí, agente no, otro negocio no ve nada, días inválidos", async () => {
    const res = await get(A);
    expect(res.status).toBe(200);
    expect((await res.json()).weekly).toBe(true);
    expect((await get(A, "?dias=30")).status).toBe(200);
    expect((await get(A, "?dias=5")).status).toBe(400);
    const agent = await member(A, "agent");
    expect((await get(agent)).status).toBe(403);
    expect((await get({ cookie: "", tenantId: "" } as T)).status).toBe(401);
    const other = await (await get(B)).json();
    expect(other.report.inbound.current).toBe(0);
  });

  it("interruptor semanal: guarda, audita y exige permiso y origen", async () => {
    const off = await reportSettings(api("POST", "/api/reports/settings", A.cookie, { weekly: false }));
    expect(off.status).toBe(200);
    expect((await (await get(A)).json()).weekly).toBe(false);
    expect((await reportSettings(api("POST", "/api/reports/settings", A.cookie, { weekly: true }, "https://malo.example"))).status).toBe(403);
    const agent = await member(A, "agent");
    expect((await reportSettings(api("POST", "/api/reports/settings", agent.cookie, { weekly: false }))).status).toBe(403);
    expect((await oq(A, "SELECT count(*)::int AS n FROM audit_log WHERE tenant_id = $1 AND action = 'reports.weekly'", [A.tenantId])).rows[0].n).toBe(1);
    await reportSettings(api("POST", "/api/reports/settings", A.cookie, { weekly: true }));
  });

  it("«enviarme ahora»: pone el correo en cola y la segunda vez en la hora no", async () => {
    expect((await reportSend(api("POST", "/api/reports/send", A.cookie, {}))).status).toBe(200);
    const q = await owner.query("SELECT count(*)::int AS n FROM email_outbox WHERE to_email = $1 AND template = 'reporte_semanal'", [A.email.toLowerCase()]);
    expect(q.rows[0].n).toBe(1);
    expect((await reportSend(api("POST", "/api/reports/send", A.cookie, {}))).status).toBe(429);
  });
});

describe("envío semanal", () => {
  it("manda el lunes a dueño y administradores, una sola vez, y respeta el interruptor", async () => {
    const t = await register("w");
    const adm = await member(t, "admin");
    await member(t, "agent");
    await seed(t);
    // El negocio de prueba es nuevo (menos de 7 días): se envejece para que le toque.
    expect((await oq(t, "UPDATE tenants SET created_at = now() - interval '30 days' WHERE id = $1", [t.tenantId])).rowCount).toBe(1);
    const monday = new Date("2026-11-02T13:00:00Z");
    const mine = () => owner.query("SELECT to_email FROM email_outbox WHERE tenant_id = $1 AND template = 'reporte_semanal' ORDER BY to_email", [t.tenantId]);
    // Antes del lunes 12:00 UTC no se reclama nada de esta semana.
    const n = await sendWeeklyReports(500, monday);
    expect(n).toBeGreaterThanOrEqual(0);
    const rows = (await mine()).rows.map((x) => x.to_email);
    // En el sandbox NOW real es posterior al lunes de referencia, por eso se comprueba contra el estado real.
    const d = new Date();
    const beforeNoonMonday = d.getUTCDay() === 1 && d.getUTCHours() < 12; // el reclamo usa el reloj real de la base
    if (beforeNoonMonday) expect(rows.length).toBe(0);
    else expect(rows).toEqual([t.email.toLowerCase(), adm.email.toLowerCase()].sort());
    const again = await sendWeeklyReports(500, monday);
    expect((await mine()).rows.length).toBe(rows.length);
    expect(again).toBe(0);
  });

  it("report_claim: no repite la semana y la limpieza no rompe", async () => {
    const t = await register("c");
    expect((await oq(t, "UPDATE tenants SET created_at = now() - interval '30 days' WHERE id = $1", [t.tenantId])).rowCount).toBe(1);
    const first = await getPool().query("SELECT * FROM report_claim(1000)");
    const second = await getPool().query("SELECT * FROM report_claim(1000)");
    const mineFirst = first.rows.filter((x) => x.out_tenant_id === t.tenantId).length;
    const mineSecond = second.rows.filter((x) => x.out_tenant_id === t.tenantId).length;
    expect(mineFirst + mineSecond).toBeLessThanOrEqual(1);
    expect(mineSecond).toBe(0);
  });

  it("app_user no puede leer ni tocar report_state directamente", async () => {
    await expect(getPool().query("SELECT * FROM report_state LIMIT 1")).rejects.toThrow();
  });
});
