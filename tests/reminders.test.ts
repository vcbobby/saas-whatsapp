import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { POST as signup } from "@/app/api/auth/signup/route";
import { GET as me } from "@/app/api/me/route";
import { createOrder } from "@/lib/orders/service";
import { getPool, withTenant } from "@/lib/db";
import { encryptSecret } from "@/lib/crypto";
import { sendOne } from "@/lib/notifications/send";

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
  const email = `rm-${RUN}-${name}@example.test`;
  const res = await signup(api("POST", "/api/auth/signup", undefined, { email, password: PASSWORD, businessName: `Negocio ${name}` }));
  expect(res.status).toBe(201);
  const cookie = (res.headers.get("set-cookie") ?? "").split(";")[0]!;
  const info = await (await me(api("GET", "/api/me", cookie))).json();
  tenantIds.push(info.tenant.id);
  const phoneId = `7${Date.now() % 1000000000}${seq++}`.slice(0, 16);
  const enc = encryptSecret("EAAtoken-de-prueba-1234567890", `wa:${info.tenant.id}:${phoneId}`);
  await owner.query("INSERT INTO tenant_integrations (tenant_id, provider, external_id, secret_enc, key_version) VALUES ($1,'whatsapp',$2,$3,$4)", [info.tenant.id, phoneId, enc.payload, enc.keyVersion]);
  return { tenantId: info.tenant.id as string, cookie, phoneId };
}
type T = Awaited<ReturnType<typeof register>>;import { GET as listRules, POST as createRule } from "@/app/api/automations/route";
import { POST as updateRule } from "@/app/api/automations/update/route";
import { TICK_EVERY_SECONDS, tickAutomations } from "@/lib/automations/tick";
import { offsetFor, actionError, isTimeTrigger } from "@/lib/automations/rules";

beforeAll(async () => { await getPool().query("SELECT 1"); });
afterAll(async () => {
  await owner.query("DELETE FROM users WHERE email LIKE $1", [`rm-${RUN}-%`]);
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



afterEach(() => { vi.unstubAllEnvs(); });
const post = (h: (r: Request) => Promise<Response>, path: string, t: T | null, body: unknown, origin = ORIGIN) => h(api("POST", path, t?.cookie, body, origin));




const rcreate = (t: T, body: Record<string, unknown> = {}) => post(createRule, "/api/automations", t, { name: "Recordatorio", triggerEvent: "appointment.upcoming", offsetMinutes: 1440, actionType: "tarea", taskTitle: "Cita de {cliente} ({servicio}) {fecha}", ...body });
const rupdate = (t: T, body: Record<string, unknown>) => post(updateRule, "/api/automations/update", t, body);
async function mkRule(t: T, o: Record<string, unknown> = {}) {
  const r = await rcreate(t, o);
  expect(r.status).toBe(201);
  return (await r.json()).id as string;
}
const notes = (t: T) => withTenant(t.tenantId, async (db) => (await db.query("SELECT * FROM customer_notifications ORDER BY created_at, id")).rows);
const tasks = (t: T) => withTenant(t.tenantId, async (db) => (await db.query("SELECT * FROM work_items WHERE dedupe_key LIKE 'auto:%' ORDER BY created_at, id")).rows);
const tick = (t: T) => withTenant(t.tenantId, async (db) => Number((await db.query("SELECT run_time_automations($1) AS n", [t.tenantId])).rows[0].n));
const ruleRow = (t: T, id: string) => withTenant(t.tenantId, async (db) => (await db.query("SELECT * FROM automation_rules WHERE id = $1", [id])).rows[0]);
const inIndex = (t: T) => owner.query("SELECT 1 FROM automation_time_index WHERE tenant_id = $1", [t.tenantId]).then((r) => (r.rowCount ?? 0) === 1);

async function customer(t: T, o: { name?: string } = {}) {
  const waId = `58414${String(Math.random()).slice(2, 9)}`;
  return withTenant(t.tenantId, async (db) => {
    const c = (await db.query("INSERT INTO contacts (tenant_id, wa_id, display_name) VALUES ($1,$2,$3) RETURNING id", [t.tenantId, waId, o.name ?? "Ana"])).rows[0].id as string;
    const cv = (await db.query("INSERT INTO conversations (tenant_id, contact_id, status) VALUES ($1,$2,'bot') RETURNING id", [t.tenantId, c])).rows[0].id as string;
    await db.query("INSERT INTO messages (tenant_id, conversation_id, direction, msg_type, body, wa_message_id, created_at) VALUES ($1,$2,'in','text','hola',$3, now() - interval '1 hour')", [t.tenantId, cv, `wamid.IN.${randomUUID()}`]);
    return { contactId: c, conversationId: cv, waId };
  });
}
const svcCache = new Map<string, string>();
/** Cita que empieza dentro de `inHours` horas y que «se creó» hace `createdAgoHours` horas. */
async function appointment(t: T, o: { inHours: number; createdAgoHours?: number; status?: string; contact?: { contactId: string; conversationId: string } }) {
  return withTenant(t.tenantId, async (db) => {
    let svc = svcCache.get(t.tenantId);
    if (!svc) {
      svc = (await db.query("INSERT INTO agenda_services (tenant_id, name, duration_minutes) VALUES ($1,'Corte',30) RETURNING id", [t.tenantId])).rows[0].id as string;
      svcCache.set(t.tenantId, svc);
    }
    return (await db.query(
      `INSERT INTO appointments (tenant_id, service_id, contact_id, conversation_id, customer_name, starts_at, ends_at, status, source, created_at)
       VALUES ($1,$2,$3,$4,'Luis', now() + make_interval(mins => $5::int), now() + make_interval(mins => $5::int) + interval '30 minutes', $6, 'manual', now() - make_interval(hours => $7)) RETURNING id`,
      [t.tenantId, svc, o.contact?.contactId ?? null, o.contact?.conversationId ?? null, Math.round(o.inHours * 60), o.status ?? "confirmada", o.createdAgoHours ?? 72],
    )).rows[0].id as string;
  });
}
async function orderAged(t: T, hoursAgo: number, c: { contactId: string; conversationId: string } | null = null, status: "pendiente" | "confirmado" = "pendiente") {
  return withTenant(t.tenantId, async (db) => {
    const p = (await db.query("INSERT INTO catalog_products (tenant_id, name, price_minor, stock) VALUES ($1,$2,250,NULL) RETURNING id", [t.tenantId, "Arroz " + randomUUID().slice(0, 6)])).rows[0].id as string;
    const r = await createOrder(db, { tenantId: t.tenantId, source: "agente", status, customerName: "Ana", contactId: c?.contactId ?? null, conversationId: c?.conversationId ?? null, items: [{ productId: p, quantity: 2 }] });
    if (r.kind !== "ok") throw new Error("pedido");
    await db.query("UPDATE orders SET created_at = now() - make_interval(hours => $2) WHERE id = $1", [r.id, hoursAgo]);
    return r;
  });
}

describe("recordatorio de cita (24 h antes)", () => {
  it("una cita que empieza dentro de la ventana crea la tarea UNA sola vez, aunque el reloj corra varias veces", async () => {
    const t = await register("u-task");
    await mkRule(t);
    await appointment(t, { inHours: 20 });
    expect(await tick(t)).toBe(1);
    expect(await tick(t)).toBe(1); // vuelve a encontrarla, pero no duplica
    const ws = await tasks(t);
    expect(ws).toHaveLength(1);
    expect(ws[0].title).toMatch(/^Cita de Luis \(Corte\) \d\d\/\d\d\/\d{4} a las \d\d:\d\d$/);
  });
  it("todavía falta mucho (30 h): no hace nada", async () => {
    const t = await register("u-far");
    await mkRule(t);
    await appointment(t, { inHours: 30 });
    expect(await tick(t)).toBe(0);
    expect(await tasks(t)).toHaveLength(0);
  });
  it("cita ya pasada, cancelada, completada o no asistió: no se recuerda", async () => {
    const t = await register("u-states");
    await mkRule(t);
    await appointment(t, { inHours: -2 });
    for (const status of ["cancelada", "completada", "no_asistio"]) await appointment(t, { inHours: 5 + (status.length % 3), status });
    expect(await tick(t)).toBe(0);
  });
  it("pendiente y confirmada sí", async () => {
    const t = await register("u-ok");
    await mkRule(t);
    await appointment(t, { inHours: 5, status: "pendiente" });
    await appointment(t, { inHours: 6, status: "confirmada" });
    expect(await tick(t)).toBe(2);
    expect(await tasks(t)).toHaveLength(2);
  });
  it("una cita hecha hace 3 h para dentro de 20 h NO recibe «24 h antes» (no existía a esa hora)", async () => {
    const t = await register("u-late");
    await mkRule(t);
    await appointment(t, { inHours: 20, createdAgoHours: 3 });
    expect(await tick(t)).toBe(0);
  });
  it("si la cita se reprograma, se recuerda de nuevo para la hora nueva (y no para la vieja otra vez)", async () => {
    const t = await register("u-move");
    await mkRule(t);
    const id = await appointment(t, { inHours: 20 });
    await tick(t);
    await withTenant(t.tenantId, (db) => db.query("UPDATE appointments SET starts_at = starts_at + interval '2 hours', ends_at = ends_at + interval '2 hours' WHERE id = $1", [id]));
    await tick(t); await tick(t);
    expect(await tasks(t)).toHaveLength(2);
  });
  it("otro tiempo (2 h antes) solo actúa cuando falta ese tiempo", async () => {
    const t = await register("u-2h");
    await mkRule(t, { offsetMinutes: 120 });
    await appointment(t, { inHours: 5 });
    expect(await tick(t)).toBe(0);
    await appointment(t, { inHours: 1.5 });
    expect(await tick(t)).toBe(1);
  });
  it("dos reglas de tiempo distintas: cada una actúa solo cuando le toca (la de 1 h no se activa por la de 24 h)", async () => {
    const t = await register("u-two");
    await mkRule(t, { name: "24h", taskTitle: "Aviso 24h" });
    await mkRule(t, { name: "1h", offsetMinutes: 60, taskTitle: "Aviso 1h" });
    await appointment(t, { inHours: 5 });
    await tick(t); await tick(t);
    expect((await tasks(t)).map((w) => w.title)).toEqual(["Aviso 24h"]);
  });
  it("regla desactivada: no recuerda; los negocios no se mezclan", async () => {
    const a = await register("u-iso-a");
    const b = await register("u-iso-b");
    const off = await mkRule(a);
    await rupdate(a, { action: "toggle", id: off, active: false });
    await mkRule(b);
    await appointment(a, { inHours: 5 });
    await appointment(b, { inHours: 5 });
    expect(await tick(a)).toBe(0);
    expect(await tasks(a)).toHaveLength(0);
    expect(await tick(b)).toBe(1);
    expect(await tasks(b)).toHaveLength(1);
    expect(await tasks(a)).toHaveLength(0);
  });
  it("con una segunda regla de otro tipo, solo se dispara la de tiempo (no se activan otras)", async () => {
    const t = await register("u-only");
    await mkRule(t, { name: "Tiempo" });
    await mkRule(t, { name: "Creada", triggerEvent: "appointment.created", offsetMinutes: null, taskTitle: "No debe salir" });
    await appointment(t, { inHours: 5 });
    await tick(t);
    expect((await tasks(t)).map((w) => w.title).some((x) => x === "No debe salir")).toBe(true); // esta sí nace al CREAR la cita
    const before = (await tasks(t)).length;
    await tick(t);
    expect((await tasks(t)).length).toBe(before + 0); // el reloj no vuelve a activarla
    expect(before).toBe(2);
  });
});

describe("recordatorio por WhatsApp", () => {
  it("crea el aviso con {fecha} y se envía dentro de la ventana", async () => {
    const t = await register("w-ok");
    await mkRule(t, { actionType: "mensaje", messageTemplate: "Hola {cliente}, te esperamos el {fecha} para {servicio}.", taskTitle: "Recordar a {cliente}" });
    const c = await customer(t);
    await appointment(t, { inHours: 20, contact: c });
    expect(await tick(t)).toBe(1);
    const [n] = await notes(t);
    expect(n).toMatchObject({ status: "pendiente", contact_id: c.contactId, conversation_id: c.conversationId });
    expect(n.body).toMatch(/^Hola Luis, te esperamos el \d\d\/\d\d\/\d{4} a las \d\d:\d\d para Corte\.$/);
    const log: { to: string; body: string }[] = [];
    expect(await sendOne(t.tenantId, n.id, { send: async (_p, _t, to, body) => { log.push({ to, body }); return { kind: "sent", waMessageId: `wamid.T.${randomUUID()}` }; } })).toBe("sent");
    expect(log).toEqual([{ to: c.waId, body: n.body }]);
    await tick(t);
    expect(await notes(t)).toHaveLength(1); // no se repite
  });
  it("sin conversación con el cliente: omitido y queda la tarea para avisar a mano", async () => {
    const t = await register("w-none");
    await mkRule(t, { actionType: "mensaje", messageTemplate: "Recordatorio", taskTitle: "Avisar a {cliente}" });
    await appointment(t, { inHours: 20 });
    await tick(t);
    expect((await notes(t))[0]).toMatchObject({ status: "omitido", reason: "sin_conversacion" });
    expect((await tasks(t))[0].title).toBe("Avisar a Luis");
  });
});

describe("pedido sin confirmar", () => {
  it("un pedido pendiente que pasó el tiempo crea la tarea una sola vez; uno reciente o ya confirmado no", async () => {
    const t = await register("p-stale");
    await mkRule(t, { name: "Sin confirmar", triggerEvent: "order.pending_stale", offsetMinutes: 120, taskTitle: "Confirmar pedido {numero} de {cliente}" });
    await withTenant(t.tenantId, (db) => db.query("UPDATE automation_rules SET created_at = now() - interval '10 days'"));
    const old = await orderAged(t, 3);
    await orderAged(t, 1);
    await orderAged(t, 5, null, "confirmado");
    expect(await tick(t)).toBe(1);
    expect(await tick(t)).toBe(1);
    const ws = await tasks(t);
    expect(ws).toHaveLength(1);
    expect(ws[0].title).toBe(`Confirmar pedido ${old.number} de Ana`);
  });
  it("no es retroactivo: pedidos viejos de antes de crear la regla no se reclaman", async () => {
    const t = await register("p-retro");
    await orderAged(t, 100);
    await mkRule(t, { name: "Sin confirmar", triggerEvent: "order.pending_stale", offsetMinutes: 120 });
    expect(await tick(t)).toBe(0);
  });
  it("si se confirma antes de tiempo, ya no se reclama", async () => {
    const t = await register("p-conf");
    await mkRule(t, { name: "S", triggerEvent: "order.pending_stale", offsetMinutes: 120 });
    await withTenant(t.tenantId, (db) => db.query("UPDATE automation_rules SET created_at = now() - interval '10 days'"));
    const o = await orderAged(t, 1);
    await withTenant(t.tenantId, (db) => db.query("UPDATE orders SET confirmed_at = now(), status = 'confirmado' WHERE id = $1", [o.id]));
    await withTenant(t.tenantId, (db) => db.query("UPDATE orders SET created_at = now() - interval '5 hours' WHERE id = $1", [o.id]));
    expect(await tick(t)).toBe(0);
  });
});

describe("reloj del worker", () => {
  it("el índice de negocios con reglas de tiempo se mantiene solo", async () => {
    const t = await register("k-index");
    expect(await inIndex(t)).toBe(false);
    await mkRule(t, { triggerEvent: "appointment.created", offsetMinutes: null });
    expect(await inIndex(t)).toBe(false); // una regla normal no entra
    const id = await mkRule(t);
    expect(await inIndex(t)).toBe(true);
    await rupdate(t, { action: "toggle", id, active: false });
    expect(await inIndex(t)).toBe(false);
    await rupdate(t, { action: "toggle", id, active: true });
    expect(await inIndex(t)).toBe(true);
    await rupdate(t, { action: "delete", id });
    expect(await inIndex(t)).toBe(false);
  });
  it("tickAutomations revisa el negocio y no lo vuelve a revisar antes de tiempo", async () => {
    const t = await register("k-tick");
    await mkRule(t);
    await appointment(t, { inHours: 5 });
    await tickAutomations(50, TICK_EVERY_SECONDS);
    expect(await tasks(t)).toHaveLength(1);
    await owner.query("UPDATE automation_time_index SET last_tick_at = now() WHERE tenant_id = $1", [t.tenantId]);
    await appointment(t, { inHours: 6 });
    await tickAutomations(50, TICK_EVERY_SECONDS);
    expect(await tasks(t)).toHaveLength(1); // aún no tocaba
    await owner.query("UPDATE automation_time_index SET last_tick_at = now() - interval '5 minutes' WHERE tenant_id = $1", [t.tenantId]);
    await tickAutomations(50, TICK_EVERY_SECONDS);
    expect(await tasks(t)).toHaveLength(2);
  });
  it("el índice no es accesible directamente por la aplicación", async () => {
    await expect(getPool().query("SELECT * FROM automation_time_index")).rejects.toThrow(/permission denied/);
  });
});

describe("reglas por tiempo (API)", () => {
  it("crea con su tiempo, lo lista y lo edita; los avisos normales ignoran el tiempo", async () => {
    const t = await register("a-ok");
    const id = await mkRule(t, { offsetMinutes: 1440 });
    const list = await (await listRules(api("GET", "/api/automations", t.cookie))).json();
    expect(list.rules[0]).toMatchObject({ id, triggerEvent: "appointment.upcoming", offsetMinutes: 1440 });
    const base = { action: "edit", id, name: "X", triggerEvent: "appointment.upcoming", onlyStatus: null, actionType: "tarea", taskTitle: "T", taskPriority: 2, taskDueMinutes: null };
    expect((await rupdate(t, { ...base, offsetMinutes: 60 })).status).toBe(200);
    expect((await ruleRow(t, id)).offset_minutes).toBe(60);
    expect((await rupdate(t, { ...base, triggerEvent: "order.created", offsetMinutes: 60 })).status).toBe(200);
    expect((await ruleRow(t, id)).offset_minutes).toBeNull();
    expect((await rupdate(t, { ...base, offsetMinutes: null })).status).toBe(422);
  });
  it.each<[string, Record<string, unknown>]>([
    ["sin tiempo", { offsetMinutes: null }],
    ["tiempo 0", { offsetMinutes: 0 }],
    ["tiempo negativo", { offsetMinutes: -5 }],
    ["tiempo enorme", { offsetMinutes: 43201 }],
    ["tiempo decimal", { offsetMinutes: 1.5 }],
    ["tiempo en un aviso que lo admite pero vacío", { triggerEvent: "order.pending_stale", offsetMinutes: null }],
    ["estado en un aviso por tiempo", { onlyStatus: "confirmada" }],
  ])("rechaza: %s", async (_n, body) => {
    const t = await register("a-bad" + Math.random().toString(36).slice(2, 8));
    const res = await rcreate(t, body);
    expect([400, 422]).toContain(res.status);
    expect(await withTenant(t.tenantId, async (db) => (await db.query("SELECT count(*)::int AS n FROM automation_rules")).rows[0].n)).toBe(0);
  });
  it("un aviso normal con tiempo de sobra se guarda sin tiempo", async () => {
    const t = await register("a-ign");
    const id = await mkRule(t, { triggerEvent: "order.created", offsetMinutes: 90 });
    expect((await ruleRow(t, id)).offset_minutes).toBeNull();
  });
  it("helpers", () => {
    expect(isTimeTrigger("appointment.upcoming")).toBe(true);
    expect(isTimeTrigger("order.created")).toBe(false);
    expect(offsetFor({ triggerEvent: "order.created", offsetMinutes: 5 })).toBeNull();
    expect(offsetFor({ triggerEvent: "order.pending_stale", offsetMinutes: 5 })).toBe(5);
    expect(actionError({ actionType: "tarea", triggerEvent: "appointment.upcoming", offsetMinutes: null })).not.toBeNull();
    expect(actionError({ actionType: "mensaje", triggerEvent: "appointment.upcoming", offsetMinutes: 60, messageTemplate: "x" })).toBeNull();
  });
});
