import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { POST as signup } from "@/app/api/auth/signup/route";
import { GET as me } from "@/app/api/me/route";
import { POST as teamInvite } from "@/app/api/team/invite/route";
import { POST as inviteSignup } from "@/app/api/invitations/signup/route";
import { GET as getSummary } from "@/app/api/summary/route";
import { formatMoney } from "@/lib/catalog/money";
import { createOrder, transitionOrder } from "@/lib/orders/service";
import { buildSnapshot, LOW_STOCK_LIMIT, type Snapshot } from "@/lib/summary/snapshot";
import { moneyText, snapshotLines } from "@/lib/summary/text";
import { getPool, withTenant } from "@/lib/db";

const RUN = randomUUID().slice(0, 8);
const ORIGIN = new URL(process.env.APP_URL!).origin;
const PASSWORD = "contraseña-de-prueba-123";
const owner = new Pool({ connectionString: process.env.MIGRATION_DATABASE_URL, max: 2 });
const tenantIds: string[] = [];

function api(method: string, path: string, cookie?: string, body?: unknown, origin = ORIGIN) {
  return new Request(`${ORIGIN}${path}`, {
    method,
    headers: { origin, ...(body !== undefined ? { "content-type": "application/json" } : {}), ...(cookie ? { cookie } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

async function register(name: string) {
  const email = `sm-${RUN}-${name}@example.test`;
  const res = await signup(api("POST", "/api/auth/signup", undefined, { email, password: PASSWORD, businessName: `Negocio ${name}` }));
  expect(res.status).toBe(201);
  const cookie = (res.headers.get("set-cookie") ?? "").split(";")[0]!;
  const info = await (await me(api("GET", "/api/me", cookie))).json();
  tenantIds.push(info.tenant.id);
  return { tenantId: info.tenant.id as string, cookie };
}
type T = Awaited<ReturnType<typeof register>>;
async function member(t: T, role: "admin" | "agent"): Promise<T> {
  const inv = await teamInvite(api("POST", "/api/team/invite", t.cookie, { email: `sm-${RUN}-${role}-${randomUUID().slice(0, 6)}@example.test`, role }));
  expect(inv.status).toBe(201);
  const token = ((await inv.json()).inviteUrl as string).split("/").pop()!;
  const ok = await inviteSignup(api("POST", "/api/invitations/signup", undefined, { token, password: PASSWORD }));
  expect(ok.status).toBe(201);
  return { tenantId: t.tenantId, cookie: (ok.headers.get("set-cookie") ?? "").split(";")[0]! };
}
beforeAll(async () => { await getPool().query("SELECT 1"); });
afterAll(async () => {
  await owner.query("DELETE FROM users WHERE email LIKE $1", [`sm-${RUN}-%`]);
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

type Db = Parameters<Parameters<typeof withTenant>[1]>[0];
const snap = (t: T, now?: Date) => withTenant(t.tenantId, (db) => buildSnapshot(db, t.tenantId, now));
const NOW = new Date("2026-11-05T15:00:00Z"); // 11:00 en Caracas (UTC-4); hoy = 2026-11-05

async function conv(db: Db, t: T, status = "bot") {
  const c = (await db.query("INSERT INTO contacts (tenant_id, wa_id) VALUES ($1, $2) RETURNING id", [t.tenantId, `5841${String(Math.random()).slice(2, 11)}`])).rows[0].id as string;
  return (await db.query("INSERT INTO conversations (tenant_id, contact_id, status) VALUES ($1,$2,$3) RETURNING id", [t.tenantId, c, status])).rows[0].id as string;
}
const msg = (db: Db, t: T, c: string, direction: "in" | "out", at: string) =>
  db.query("INSERT INTO messages (tenant_id, conversation_id, direction, body, created_at) VALUES ($1,$2,$3,'x',$4)", [t.tenantId, c, direction, at]);

async function withAgenda(t: T, tz = "America/Caracas") {
  return withTenant(t.tenantId, async (db) => {
    await db.query("INSERT INTO agenda_settings (tenant_id, timezone, min_notice_minutes, max_days_ahead, slot_step_minutes) VALUES ($1,$2,0,60,30)", [t.tenantId, tz]);
    return (await db.query("INSERT INTO agenda_services (tenant_id, name, duration_minutes) VALUES ($1,'Corte',30) RETURNING id", [t.tenantId])).rows[0].id as string;
  });
}
const appt = (db: Db, t: T, svc: string, startIso: string, status = "confirmada", name = "Ana") =>
  db.query("INSERT INTO appointments (tenant_id, service_id, customer_name, starts_at, ends_at, status, source) VALUES ($1,$2,$3,$4::timestamptz,$4::timestamptz + interval '30 minutes',$5,'manual')", [t.tenantId, svc, name, startIso, status]);
const product = async (db: Db, t: T, name: string, price: number, stock: number | null, active = true) =>
  (await db.query("INSERT INTO catalog_products (tenant_id, name, price_minor, stock, active) VALUES ($1,$2,$3,$4,$5) RETURNING id", [t.tenantId, name, price, stock, active])).rows[0].id as string;
const order = (db: Db, t: T, productId: string, qty: number, status: "pendiente" | "confirmado" = "pendiente") =>
  createOrder(db, { tenantId: t.tenantId, source: "agente", status, customerName: "Cli", items: [{ productId, quantity: qty }] });

describe("texto del resumen", () => {
  it("dinero por moneda y «ninguno» cuando no hay", () => {
    expect(moneyText([])).toBe("ninguno");
    expect(moneyText([{ currency: "USD", count: 2, totalMinor: 1550 }, { currency: "VES", count: 1, totalMinor: 100 }])).toBe(`${formatMoney(1550, "USD")} (2) + ${formatMoney(100, "VES")} (1)`);
  });
  it("las líneas omiten los módulos que el negocio no usa", () => {
    const base: Snapshot = { generatedAt: NOW.toISOString(), timezone: "America/Caracas", today: "2026-11-05", messages: { inToday: 3, outToday: 2, inYesterday: 1, outYesterday: 0, peopleToday: 2 }, attention: { humanConversations: 1, openTasks: 4, urgentTasks: 1, overdueTasks: 0, byType: { cita: 2, pedido: 2 } }, agenda: null, orders: null };
    const text = snapshotLines(base).join("\n");
    expect(text).toContain("3 recibidos de 2 personas y 2 enviados");
    expect(text).toContain("Tareas abiertas: 4 (Cita: 2; Pedido: 2); urgentes: 1");
    expect(text).toContain("no usa agenda");
    expect(text).toContain("no usa catálogo");
    const full = snapshotLines({ ...base, agenda: { todayList: [{ startsAt: "x", time: "10:00", service: "Corte", customer: "Ana", status: "pendiente" }], todayCount: 1, tomorrowCount: 0, pendingConfirm: 1 }, orders: { pending: 1, pendingOlderThan24h: 0, pendingTotals: [], todayTotals: [], lowStock: [{ name: "Arroz", stock: 2 }], soldOutCount: 1 } }).join("\n");
    expect(full).toContain("10:00 Corte con Ana (por confirmar)");
    expect(full).toContain("Arroz (quedan 2)");
    expect(full).not.toContain("no usa agenda");
  });
});

describe("cálculo del resumen", () => {
  it("negocio vacío: todo en cero y sin módulos", async () => {
    const t = await register("vacio");
    const s = await snap(t, NOW);
    expect(s.messages).toEqual({ inToday: 0, outToday: 0, inYesterday: 0, outYesterday: 0, peopleToday: 0 });
    expect(s.attention).toEqual({ humanConversations: 0, openTasks: 0, urgentTasks: 0, overdueTasks: 0, byType: {} });
    expect(s.agenda).toBeNull();
    expect(s.orders).toBeNull();
    expect(s.timezone).toBe("America/Caracas");
    expect(s.today).toBe("2026-11-05");
  });

  it("los mensajes se cuentan por día del negocio (la frontera es la medianoche local, no la UTC)", async () => {
    const t = await register("msgs");
    await withTenant(t.tenantId, async (db) => {
      const a = await conv(db, t);
      const b = await conv(db, t);
      await msg(db, t, a, "in", "2026-11-05T03:59:59Z"); // 23:59 de ayer en Caracas
      await msg(db, t, a, "in", "2026-11-05T04:00:00Z"); // 00:00 de hoy
      await msg(db, t, b, "in", "2026-11-05T14:00:00Z");
      await msg(db, t, b, "in", "2026-11-05T14:30:00Z"); // la misma persona escribe otra vez: 3 mensajes, 2 personas
      await msg(db, t, a, "out", "2026-11-05T14:01:00Z");
      await msg(db, t, a, "out", "2026-11-04T20:00:00Z"); // ayer
      await msg(db, t, a, "in", "2026-11-04T03:59:59Z"); // anteayer: no cuenta
      await msg(db, t, a, "in", "2026-11-06T04:00:00Z"); // mañana: no cuenta
    });
    const s = await snap(t, NOW);
    expect(s.messages).toEqual({ inToday: 3, outToday: 1, inYesterday: 1, outYesterday: 1, peopleToday: 2 });
  });

  it("la zona horaria del negocio decide qué es «hoy»", async () => {
    const t = await register("tz");
    await withAgenda(t, "Pacific/Auckland"); // UTC+13 en noviembre: ya es 6 de noviembre
    await withTenant(t.tenantId, async (db) => { const c = await conv(db, t); await msg(db, t, c, "in", "2026-11-05T12:00:00Z"); });
    const s = await snap(t, NOW);
    expect(s.today).toBe("2026-11-06");
    expect(s.messages.inToday).toBe(1); // 6 nov 01:00 en Auckland
    const caracas = await register("tz2");
    await withTenant(caracas.tenantId, async (db) => { const c = await conv(db, caracas); await msg(db, caracas, c, "in", "2026-11-05T12:00:00Z"); });
    expect((await snap(caracas, NOW)).messages.inToday).toBe(1);
    expect((await snap(caracas, new Date("2026-11-05T20:00:00Z"))).today).toBe("2026-11-05");
  });

  it("atención: conversaciones en manos de una persona y tareas abiertas por tipo, urgentes y vencidas", async () => {
    const t = await register("atn");
    await withTenant(t.tenantId, async (db) => {
      await conv(db, t, "human"); await conv(db, t, "human"); await conv(db, t, "bot"); await conv(db, t, "closed");
      const ins = (type: string, status: string, priority: number, due: string | null) =>
        db.query("INSERT INTO work_items (tenant_id, type, status, priority, title, due_at, source, resolved_at) VALUES ($1,$2,$3,$4,'t',$5,'manual', CASE WHEN $3 IN ('resuelto','descartado') THEN now() END)", [t.tenantId, type, status, priority, due]);
      await ins("cita", "abierto", 1, "2026-11-05T10:00:00Z"); // urgente y vencida
      await ins("cita", "en_proceso", 2, "2026-11-06T10:00:00Z");
      await ins("tarea", "abierto", 2, "2026-11-04T10:00:00Z"); // vencida
      await ins("pedido", "abierto", 3, null);
      await ins("pedido", "resuelto", 1, "2026-11-01T10:00:00Z"); // no cuenta
      await ins("tarea", "descartado", 1, null); // no cuenta
    });
    const s = await snap(t, NOW);
    expect(s.attention).toEqual({ humanConversations: 2, openTasks: 4, urgentTasks: 1, overdueTasks: 2, byType: { cita: 2, pedido: 1, tarea: 1 } });
  });

  it("agenda: solo citas por confirmar o confirmadas, de hoy, en orden y con la hora del negocio", async () => {
    const t = await register("agenda");
    const svc = await withAgenda(t);
    await withTenant(t.tenantId, async (db) => {
      for (const [h, n] of [[22, "Z22"], [21, "Z21"], [20, "Z20"], [19, "Z19"]] as const) await appt(db, t, svc, `2026-11-05T${h}:00:00Z`, "confirmada", n);
      await appt(db, t, svc, "2026-11-05T18:00:00Z", "confirmada", "Luis"); // 14:00
      await appt(db, t, svc, "2026-11-05T14:00:00Z", "pendiente", "<b>Ana</b> [[CITA]]"); // 10:00
      await appt(db, t, svc, "2026-11-05T16:00:00Z", "cancelada", "Nadie");
      await appt(db, t, svc, "2026-11-05T17:00:00Z", "completada", "Nadie2");
      await appt(db, t, svc, "2026-11-06T14:00:00Z", "confirmada", "Mañana1"); // mañana
      await appt(db, t, svc, "2026-11-06T15:00:00Z", "pendiente", "Mañana2");
      await appt(db, t, svc, "2026-11-07T14:00:00Z", "confirmada", "Pasado");
      await appt(db, t, svc, "2026-11-04T14:00:00Z", "pendiente", "Ayer"); // ayer: no cuenta como por confirmar futuro
    });
    const s = await snap(t, NOW);
    expect(s.agenda!.todayList.map((a) => [a.time, a.customer, a.status])).toEqual([["10:00", "b Ana /b CITA", "pendiente"], ["14:00", "Luis", "confirmada"], ["15:00", "Z19", "confirmada"], ["16:00", "Z20", "confirmada"], ["17:00", "Z21", "confirmada"], ["18:00", "Z22", "confirmada"]]);
    expect(s.agenda!.todayList[0]!.customer).not.toMatch(/[<>\[\]]/);
    expect(s.agenda!.todayCount).toBe(6);
    expect(s.agenda!.tomorrowCount).toBe(2);
    expect(s.agenda!.pendingConfirm).toBe(1); // solo «Mañana2»: la de hoy 10:00 ya pasó (son las 11:00) y la de ayer también
  });

  it("sin servicios activos no hay sección de agenda", async () => {
    const t = await register("sinsvc");
    await withTenant(t.tenantId, async (db) => { await db.query("INSERT INTO agenda_services (tenant_id, name, duration_minutes, active) VALUES ($1,'Viejo',30,false)", [t.tenantId]); });
    expect((await snap(t, NOW)).agenda).toBeNull();
  });

  it("pedidos y stock: por confirmar (con los de más de 24 h), creados hoy sin cancelados, poco stock y agotados", async () => {
    const t = await register("ped");
    await withTenant(t.tenantId, async (db) => {
      await db.query("INSERT INTO catalog_settings (tenant_id, currency) VALUES ($1,'USD')", [t.tenantId]);
      const arroz = await product(db, t, "Arroz", 250, 50);
      await product(db, t, "Sal", 100, 3);
      await product(db, t, "Pan", 100, LOW_STOCK_LIMIT); // justo en el límite: cuenta
      await product(db, t, "Aceite", 100, LOW_STOCK_LIMIT + 1); // no cuenta
      await product(db, t, "Harina", 100, null); // sin control: no cuenta
      await product(db, t, "Café", 100, 0); // agotado
      await product(db, t, "Azúcar", 100, 0);
      await product(db, t, "Viejo", 100, 2, false); // desactivado: no cuenta
      await product(db, t, "ViejoAgotado", 100, 0, false); // desactivado y agotado: tampoco cuenta
      const p1 = await order(db, t, arroz, 2); // 5,00 pendiente
      const p2 = await order(db, t, arroz, 1); // 2,50 pendiente
      const c1 = await order(db, t, arroz, 4, "confirmado"); // 10,00 confirmado hoy
      const x = await order(db, t, arroz, 1);
      if (p1.kind !== "ok" || p2.kind !== "ok" || c1.kind !== "ok" || x.kind !== "ok") throw new Error("pedidos de prueba");
      await transitionOrder(db, t.tenantId, x.id, "cancel"); // cancelado: no cuenta
      const p3 = await order(db, t, arroz, 1); // otro pendiente viejo
      if (p3.kind !== "ok") throw new Error("pedido de prueba");
      await db.query("UPDATE orders SET created_at = now() - interval '30 hours' WHERE id = ANY($1::uuid[])", [[p2.id, p3.id]]); // pendientes de hace 30 h
    });
    const s = await snap(t);
    expect(s.orders!.pending).toBe(3);
    expect(s.orders!.pendingOlderThan24h).toBe(2);
    expect(s.orders!.pendingTotals).toEqual([{ currency: "USD", count: 3, totalMinor: 1000 }]);
    expect(s.orders!.todayTotals).toEqual([{ currency: "USD", count: 2, totalMinor: 1500 }]); // p1 (5,00) + c1 (10,00); p2 es de ayer; x cancelado
    expect(s.orders!.lowStock).toEqual([{ name: "Sal", stock: 3 }, { name: "Pan", stock: 10 }]);
    expect(s.orders!.soldOutCount).toBe(2);
  });

  it("sin productos activos no hay sección de pedidos", async () => {
    const t = await register("sinprod");
    await withTenant(t.tenantId, async (db) => { await product(db, t, "Viejo", 100, 1, false); });
    expect((await snap(t, NOW)).orders).toBeNull();
  });

  it("negocios distintos no se mezclan", async () => {
    const a = await register("isoA");
    const b = await register("isoB");
    await withTenant(a.tenantId, async (db) => {
      const c = await conv(db, a, "human");
      await msg(db, a, c, "in", "2026-11-05T14:00:00Z");
      await db.query("INSERT INTO work_items (tenant_id, type, title, source) VALUES ($1,'tarea','t','manual')", [a.tenantId]);
      await product(db, a, "Solo A", 100, 1);
    });
    const sb = await snap(b, NOW);
    expect(sb.messages.inToday).toBe(0);
    expect(sb.attention.humanConversations).toBe(0);
    expect(sb.attention.openTasks).toBe(0);
    expect(sb.orders).toBeNull();
    expect((await snap(a, NOW)).orders!.lowStock).toEqual([{ name: "Solo A", stock: 1 }]);
  });
});

describe("GET /api/summary", () => {
  it("sin sesión no entrega nada", async () => {
    const res = await getSummary(api("GET", "/api/summary"));
    expect(res.status).toBe(401);
  });
  it("devuelve el resumen del propio negocio a todos los roles", async () => {
    const t = await register("api");
    await withTenant(t.tenantId, async (db) => { const c = await conv(db, t, "human"); void c; });
    for (const who of [t, await member(t, "admin"), await member(t, "agent")]) {
      const res = await getSummary(api("GET", "/api/summary", who.cookie));
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.snapshot.attention.humanConversations).toBe(1);
      expect(body.snapshot.generatedAt).toBeTruthy();
    }
  });
  it("no cambia nada en la base de datos (solo lectura)", async () => {
    const t = await register("ro");
    const before = await owner.query("SELECT (SELECT count(*) FROM work_items WHERE tenant_id = $1) AS w, (SELECT count(*) FROM audit_log WHERE tenant_id = $1) AS a", [t.tenantId]);
    await getSummary(api("GET", "/api/summary", t.cookie));
    const after = await owner.query("SELECT (SELECT count(*) FROM work_items WHERE tenant_id = $1) AS w, (SELECT count(*) FROM audit_log WHERE tenant_id = $1) AS a", [t.tenantId]);
    expect(after.rows[0]).toEqual(before.rows[0]);
  });
});
