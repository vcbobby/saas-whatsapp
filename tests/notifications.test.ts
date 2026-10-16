import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { POST as signup } from "@/app/api/auth/signup/route";
import { GET as me } from "@/app/api/me/route";
import { createOrder, transitionOrder } from "@/lib/orders/service";
import { getPool, withTenant } from "@/lib/db";
import { encryptSecret } from "@/lib/crypto";
import { MAX_ATTEMPTS, RETRY_SECONDS, optOutIntent, sendDue, sendOne } from "@/lib/notifications/send";
import type { SendResult } from "@/lib/whatsapp/graph";
import { ingestBatch } from "@/lib/whatsapp/ingest";

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
  const email = `nt-${RUN}-${name}@example.test`;
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
import { actionError } from "@/lib/automations/rules";

beforeAll(async () => { await getPool().query("SELECT 1"); });
afterAll(async () => {
  await owner.query("DELETE FROM users WHERE email LIKE $1", [`nt-${RUN}-%`]);
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



const rcreate = (t: T, body: Record<string, unknown> = {}) => post(createRule, "/api/automations", t, { name: "Aviso", triggerEvent: "order.status_changed", onlyStatus: "confirmado", actionType: "mensaje", messageTemplate: "Hola {cliente}, tu pedido #{numero} fue {estado}. Total: {total}.", taskTitle: "Avisar a {cliente} del pedido {numero}", ...body });
const rupdate = (t: T, body: Record<string, unknown>) => post(updateRule, "/api/automations/update", t, body);
async function mkRule(t: T, o: Record<string, unknown> = {}) {
  const r = await rcreate(t, o);
  expect(r.status).toBe(201);
  return (await r.json()).id as string;
}
const notes = (t: T) => withTenant(t.tenantId, async (db) => (await db.query("SELECT * FROM customer_notifications ORDER BY created_at, id")).rows);
const tasks = (t: T) => withTenant(t.tenantId, async (db) => (await db.query("SELECT * FROM work_items WHERE dedupe_key LIKE 'auto:%' ORDER BY created_at, id")).rows);
const outMsgs = (t: T) => withTenant(t.tenantId, async (db) => (await db.query("SELECT * FROM messages WHERE direction = 'out' ORDER BY created_at, id")).rows);
const okSend = (log: { to: string; body: string }[] = []) => async (_p: string, _t: string, to: string, body: string): Promise<SendResult> => { log.push({ to, body }); return { kind: "sent", waMessageId: `wamid.T.${randomUUID()}` }; };

/** Cliente con conversación y, si se pide, un mensaje entrante reciente (abre la ventana de 24 h). */
async function customer(t: T, o: { inboundAgoHours?: number | null; name?: string } = {}) {
  const waId = `58414${String(Math.random()).slice(2, 9)}`;
  return withTenant(t.tenantId, async (db) => {
    const c = (await db.query("INSERT INTO contacts (tenant_id, wa_id, display_name) VALUES ($1,$2,$3) RETURNING id", [t.tenantId, waId, o.name ?? "Ana"])).rows[0].id as string;
    const cv = (await db.query("INSERT INTO conversations (tenant_id, contact_id, status) VALUES ($1,$2,'bot') RETURNING id", [t.tenantId, c])).rows[0].id as string;
    if (o.inboundAgoHours !== null) {
      await db.query("INSERT INTO messages (tenant_id, conversation_id, direction, msg_type, body, wa_message_id, created_at) VALUES ($1,$2,'in','text','hola',$3, now() - make_interval(hours => $4))", [t.tenantId, cv, `wamid.IN.${randomUUID()}`, o.inboundAgoHours ?? 1]);
    }
    return { contactId: c, conversationId: cv, waId };
  });
}
async function orderFor(t: T, c: { contactId: string; conversationId: string } | null, name = "Ana", phone: string | null = null) {
  return withTenant(t.tenantId, async (db) => {
    const p = (await db.query("INSERT INTO catalog_products (tenant_id, name, price_minor, stock) VALUES ($1,$2,250,NULL) RETURNING id", [t.tenantId, "Arroz " + randomUUID().slice(0, 6)])).rows[0].id as string;
    const r = await createOrder(db, { tenantId: t.tenantId, source: "agente", status: "pendiente", customerName: name, customerPhone: phone, contactId: c?.contactId ?? null, conversationId: c?.conversationId ?? null, items: [{ productId: p, quantity: 2 }] });
    if (r.kind !== "ok") throw new Error("pedido");
    return r;
  });
}
const confirm = (t: T, id: string) => withTenant(t.tenantId, (db) => transitionOrder(db, t.tenantId, id, "confirm"));

describe("creación del aviso (en la base)", () => {
  it("al confirmar un pedido nace UN aviso pendiente con el texto rellenado y entra a la cola", async () => {
    const t = await register("n-basic");
    const ruleId = await mkRule(t);
    const c = await customer(t);
    const o = await orderFor(t, c);
    expect(await notes(t)).toHaveLength(0); // pendiente → no coincide con «confirmado»
    await confirm(t, o.id);
    const [n, ...more] = await notes(t);
    expect(more).toHaveLength(0);
    expect(n).toMatchObject({ rule_id: ruleId, status: "pendiente", contact_id: c.contactId, conversation_id: c.conversationId, customer_name: "Ana", attempts: 0, finished_at: null });
    expect(n.body).toBe(`Hola Ana, tu pedido #${o.number} fue confirmado. Total: 5.00 ${(await withTenant(t.tenantId, async (db) => (await db.query("SELECT currency FROM orders WHERE id = $1", [o.id])).rows[0].currency))}.`);
    expect(n.fallback_title).toBe(`Avisar a Ana del pedido ${o.number}`);
    expect(await owner.query("SELECT 1 FROM notification_queue WHERE notification_id = $1", [n.id]).then((r) => r.rowCount)).toBe(1);
    expect(await tasks(t)).toHaveLength(0);
    expect((await ruleRowOf(t, ruleId)).run_count).toBe(1);
  });
  it("cita: {servicio} y {fecha} en la hora del negocio", async () => {
    const t = await register("n-appt");
    await mkRule(t, { triggerEvent: "appointment.created", onlyStatus: null, messageTemplate: "Cita de {servicio} el {fecha}." });
    const c = await customer(t);
    await withTenant(t.tenantId, async (db) => {
      await db.query("INSERT INTO agenda_settings (tenant_id, timezone, min_notice_minutes, max_days_ahead, slot_step_minutes) VALUES ($1,'America/Caracas',0,60,30) ON CONFLICT DO NOTHING", [t.tenantId]);
      const svc = (await db.query("INSERT INTO agenda_services (tenant_id, name, duration_minutes) VALUES ($1,'Corte',30) RETURNING id", [t.tenantId])).rows[0].id as string;
      await db.query("INSERT INTO appointments (tenant_id, service_id, contact_id, conversation_id, customer_name, customer_phone, starts_at, ends_at, status, source) VALUES ($1,$2,$3,$4,'Luis','+584120000000','2026-11-05T14:00:00Z','2026-11-05T14:30:00Z','pendiente','manual')", [t.tenantId, svc, c.contactId, c.conversationId]);
    });
    expect((await notes(t))[0].body).toBe("Cita de Corte el 05/11/2026 a las 10:00.");
  });
  it("la hora de la tarde se escribe en 24 h", async () => {
    const t = await register("n-pm");
    await mkRule(t, { triggerEvent: "appointment.created", onlyStatus: null, messageTemplate: "Te esperamos el {fecha}." });
    const c = await customer(t);
    await withTenant(t.tenantId, async (db) => {
      const svc = (await db.query("INSERT INTO agenda_services (tenant_id, name, duration_minutes) VALUES ($1,'Corte',30) RETURNING id", [t.tenantId])).rows[0].id as string;
      await db.query("INSERT INTO appointments (tenant_id, service_id, contact_id, conversation_id, customer_name, starts_at, ends_at, status, source) VALUES ($1,$2,$3,$4,'Luis','2026-11-05T18:30:00Z','2026-11-05T19:00:00Z','pendiente','manual')", [t.tenantId, svc, c.contactId, c.conversationId]);
    });
    expect((await notes(t))[0].body).toBe("Te esperamos el 05/11/2026 a las 14:30.");
  });
  it("se encuentra al cliente por su teléfono cuando el pedido no trae conversación", async () => {
    const t = await register("n-phone");
    await mkRule(t);
    const c = await customer(t);
    const o = await orderFor(t, null, "Ana", `+${c.waId.slice(0, 2)} ${c.waId.slice(2, 5)}-${c.waId.slice(5)}`);
    await confirm(t, o.id);
    expect((await notes(t))[0]).toMatchObject({ status: "pendiente", contact_id: c.contactId, conversation_id: c.conversationId });
  });
  it("sin conversación ni contacto: queda «omitido» y se crea la tarea para avisar a mano", async () => {
    const t = await register("n-none");
    await mkRule(t);
    const o = await orderFor(t, null, "Pedro", "+58 999 000");
    await confirm(t, o.id);
    const [n] = await notes(t);
    expect(n).toMatchObject({ status: "omitido", reason: "sin_conversacion" });
    expect(n.finished_at).not.toBeNull();
    expect(await owner.query("SELECT 1 FROM notification_queue WHERE notification_id = $1", [n.id]).then((r) => r.rowCount)).toBe(0);
    const [w] = await tasks(t);
    expect(w.title).toBe(`Avisar a Pedro del pedido ${o.number}`);
    expect(w.detail).toContain("Mensaje sugerido: Hola Pedro");
  });
  it("cliente que pidió la baja: omitido SIN tarea", async () => {
    const t = await register("n-off");
    await mkRule(t);
    const c = await customer(t);
    await withTenant(t.tenantId, (db) => db.query("UPDATE contacts SET notifications_off = true WHERE id = $1", [c.contactId]));
    const o = await orderFor(t, c);
    await confirm(t, o.id);
    expect((await notes(t))[0]).toMatchObject({ status: "omitido", reason: "baja" });
    expect(await tasks(t)).toHaveLength(0);
  });
  it("tope: máximo 5 avisos por cliente cada 24 h; el 6.º queda omitido con tarea", async () => {
    const t = await register("n-cap");
    await mkRule(t);
    const c = await customer(t);
    for (let i = 0; i < 6; i++) { const o = await orderFor(t, c); await confirm(t, o.id); }
    const ns = await notes(t);
    expect(ns.filter((n) => n.status === "pendiente")).toHaveLength(5);
    expect(ns.filter((n) => n.reason === "limite_24h")).toHaveLength(1);
    expect(await tasks(t)).toHaveLength(1);
  });
  it("el tope de 5 cuenta también los avisos ya ENVIADOS", async () => {
    const t = await register("n-cap2");
    await mkRule(t);
    const c = await customer(t);
    for (let i = 0; i < 5; i++) { const o = await orderFor(t, c); await confirm(t, o.id); }
    for (const n of await notes(t)) expect(await sendOne(t.tenantId, n.id, { send: okSend() })).toBe("sent");
    await confirm(t, (await orderFor(t, c)).id);
    const ns = await notes(t);
    expect(ns.filter((n) => n.status === "enviado")).toHaveLength(5);
    expect(ns[5]).toMatchObject({ status: "omitido", reason: "limite_24h" });
  });
  it("una conversación cerrada no sirve para avisar (se busca otra abierta o se omite)", async () => {
    const t = await register("n-closed");
    await mkRule(t);
    const c = await customer(t);
    await withTenant(t.tenantId, (db) => db.query("UPDATE conversations SET status = 'closed' WHERE id = $1", [c.conversationId]));
    await confirm(t, (await orderFor(t, null, "Ana", `+${c.waId}`)).id);
    expect((await notes(t))[0]).toMatchObject({ status: "omitido", reason: "sin_conversacion" });
  });
  it("cola llena (2000 avisos pendientes): el nuevo se omite con tarea", async () => {
    const t = await register("n-full");
    await mkRule(t);
    const c = await customer(t);
    await withTenant(t.tenantId, (db) => db.query("INSERT INTO customer_notifications (tenant_id, rule_id, event_id, body, fallback_title) SELECT $1, gen_random_uuid(), gen_random_uuid(), 'x', 'x' FROM generate_series(1, 2000)", [t.tenantId]));
    await confirm(t, (await orderFor(t, c)).id);
    const ns = await withTenant(t.tenantId, async (db) => (await db.query("SELECT status, reason FROM customer_notifications WHERE body <> 'x'")).rows);
    expect(ns).toEqual([{ status: "omitido", reason: "cola_llena" }]);
    // limpieza: que estos 2000 de relleno no los tome el envío de otras pruebas
    await owner.query("DELETE FROM notification_queue WHERE tenant_id = $1", [t.tenantId]);
  });
  it("el mismo evento procesado dos veces no duplica el aviso", async () => {
    const t = await register("n-idem");
    await mkRule(t);
    const c = await customer(t);
    const o = await orderFor(t, c);
    const ev = randomUUID();
    const data = JSON.stringify({ order: { id: o.id, number: o.number, status: "confirmado", customer_name: "Ana", total_minor: 500, currency: "USD" } });
    await withTenant(t.tenantId, async (db) => {
      await db.query("SELECT run_automations($1, 'order.status_changed', $2::jsonb, $3)", [t.tenantId, data, ev]);
      await db.query("SELECT run_automations($1, 'order.status_changed', $2::jsonb, $3)", [t.tenantId, data, ev]);
    });
    expect(await notes(t)).toHaveLength(1);
  });
  it("si el pedido se deshace, el aviso también", async () => {
    const t = await register("n-rb");
    await mkRule(t);
    const c = await customer(t);
    const o = await orderFor(t, c);
    await expect(withTenant(t.tenantId, async (db) => { await transitionOrder(db, t.tenantId, o.id, "confirm"); throw new Error("se deshace"); })).rejects.toThrow("se deshace");
    expect(await notes(t)).toHaveLength(0);
  });
  it("los avisos de un negocio no se ven en otro", async () => {
    const a = await register("n-iso-a");
    const b = await register("n-iso-b");
    await mkRule(a);
    const c = await customer(a);
    await confirm(a, (await orderFor(a, c)).id);
    expect(await notes(b)).toHaveLength(0);
    expect(await notes(a)).toHaveLength(1);
  });
});
async function ruleRowOf(t: T, id: string) { return withTenant(t.tenantId, async (db) => (await db.query("SELECT * FROM automation_rules WHERE id = $1", [id])).rows[0]); }

async function pendingNote(t: T, o: { inboundAgoHours?: number | null } = {}) {
  await mkRule(t);
  const c = await customer(t, o);
  const ord = await orderFor(t, c);
  await confirm(t, ord.id);
  return { n: (await notes(t))[0], c, ord };
}

describe("envío del aviso (worker)", () => {
  it("dentro de la ventana: se envía al número del cliente, se guarda el mensaje y el aviso queda «enviado»", async () => {
    const t = await register("s-ok");
    const { n, c } = await pendingNote(t);
    const log: { to: string; body: string }[] = [];
    expect(await sendOne(t.tenantId, n.id, { send: okSend(log) })).toBe("sent");
    expect(log).toEqual([{ to: c.waId, body: n.body }]);
    const [m] = await outMsgs(t);
    expect(m).toMatchObject({ send_state: "sent", body: n.body, conversation_id: c.conversationId, client_key: n.id, sent_by: null });
    expect(m.wa_message_id).toMatch(/^wamid\.T\./);
    const [after] = await notes(t);
    expect(after).toMatchObject({ status: "enviado", message_id: m.id, attempts: 1, reason: null });
    expect(after.finished_at).not.toBeNull();
    expect(await owner.query("SELECT 1 FROM notification_queue WHERE notification_id = $1", [n.id]).then((r) => r.rowCount)).toBe(0);
    expect(await tasks(t)).toHaveLength(0);
  });
  it("repetir el envío del mismo aviso NO manda otro mensaje", async () => {
    const t = await register("s-twice");
    const { n } = await pendingNote(t);
    const log: { to: string; body: string }[] = [];
    await sendOne(t.tenantId, n.id, { send: okSend(log) });
    expect(await sendOne(t.tenantId, n.id, { send: okSend(log) })).toBe("skipped");
    expect(log).toHaveLength(1);
    expect(await outMsgs(t)).toHaveLength(1);
  });
  it("dos workers a la vez: solo uno envía", async () => {
    const t = await register("s-race");
    const { n } = await pendingNote(t);
    const log: { to: string; body: string }[] = [];
    const rs = await Promise.all([sendOne(t.tenantId, n.id, { send: okSend(log) }), sendOne(t.tenantId, n.id, { send: okSend(log) })]);
    expect(rs.sort()).toEqual(["sent", "skipped"]);
    expect(log).toHaveLength(1);
  });
  it("ventana cerrada (último mensaje hace más de 24 h): no se envía, queda omitido y hay tarea con el mensaje sugerido", async () => {
    const t = await register("s-window");
    const { n } = await pendingNote(t, { inboundAgoHours: 30 });
    const log: { to: string; body: string }[] = [];
    expect(await sendOne(t.tenantId, n.id, { send: okSend(log) })).toBe("omitted");
    expect(log).toHaveLength(0);
    expect((await notes(t))[0]).toMatchObject({ status: "omitido", reason: "ventana_cerrada" });
    expect(await outMsgs(t)).toHaveLength(0);
    const [w] = await tasks(t);
    expect(w.detail).toContain("24 horas");
    expect(w.detail).toContain(n.body);
  });
  it("el cliente nunca escribió: ventana cerrada", async () => {
    const t = await register("s-never");
    const { n } = await pendingNote(t, { inboundAgoHours: null });
    expect(await sendOne(t.tenantId, n.id, { send: okSend() })).toBe("omitted");
    expect((await notes(t))[0].reason).toBe("ventana_cerrada");
  });
  it("los tiempos de reintento son los acordados", () => {
    expect([...RETRY_SECONDS]).toEqual([60, 300]);
    expect(MAX_ATTEMPTS).toBe(3);
  });
  it("justo dentro de la ventana (23 h) sí se envía", async () => {
    const t = await register("s-23h");
    const { n } = await pendingNote(t, { inboundAgoHours: 23 });
    expect(await sendOne(t.tenantId, n.id, { send: okSend() })).toBe("sent");
  });
  it("si el cliente pidió la baja DESPUÉS de crearse el aviso, no se envía", async () => {
    const t = await register("s-late-off");
    const { n, c } = await pendingNote(t);
    await withTenant(t.tenantId, (db) => db.query("UPDATE contacts SET notifications_off = true WHERE id = $1", [c.contactId]));
    const log: { to: string; body: string }[] = [];
    expect(await sendOne(t.tenantId, n.id, { send: okSend(log) })).toBe("omitted");
    expect(log).toHaveLength(0);
    expect((await notes(t))[0].reason).toBe("baja");
    expect(await tasks(t)).toHaveLength(0);
  });
  it("sin WhatsApp conectado: omitido con tarea", async () => {
    const t = await register("s-nowa");
    const { n } = await pendingNote(t);
    await owner.query("DELETE FROM tenant_integrations WHERE tenant_id = $1", [t.tenantId]);
    expect(await sendOne(t.tenantId, n.id, { send: okSend() })).toBe("omitted");
    expect((await notes(t))[0].reason).toBe("sin_whatsapp");
    expect(await tasks(t)).toHaveLength(1);
  });
  it("negocio suspendido: no se envía", async () => {
    const t = await register("s-susp");
    const { n } = await pendingNote(t);
    await withTenant(t.tenantId, (db) => db.query("UPDATE tenants SET status = 'suspended' WHERE id = $1", [t.tenantId]));
    expect(await sendOne(t.tenantId, n.id, { send: okSend() })).toBe("omitted");
    expect((await notes(t))[0].reason).toBe("negocio_inactivo");
  });
  it("falla de conexión: se reintenta con espera creciente y no queda mensaje fantasma; al tercer fallo → fallido con tarea", async () => {
    const t = await register("s-retry");
    const { n } = await pendingNote(t);
    const bad = async (): Promise<SendResult> => ({ kind: "retry", reason: "ENOTFOUND" });
    for (let i = 1; i < MAX_ATTEMPTS; i++) {
      expect(await sendOne(t.tenantId, n.id, { send: bad })).toBe("retry");
      expect(await outMsgs(t)).toHaveLength(0);
      const q = await owner.query("SELECT extract(epoch from next_attempt_at - now()) AS wait FROM notification_queue WHERE notification_id = $1", [n.id]);
      expect(Number(q.rows[0].wait)).toBeGreaterThan(RETRY_SECONDS[i - 1]! - 15);
      expect(Number(q.rows[0].wait)).toBeLessThanOrEqual(RETRY_SECONDS[i - 1]! + 1);
      expect((await notes(t))[0]).toMatchObject({ status: "pendiente", attempts: i });
    }
    expect(await sendOne(t.tenantId, n.id, { send: bad })).toBe("failed");
    expect((await notes(t))[0]).toMatchObject({ status: "fallido", attempts: MAX_ATTEMPTS });
    expect((await notes(t))[0].reason).toContain("sin_conexion");
    expect(await tasks(t)).toHaveLength(1);
    expect((await outMsgs(t))[0].send_state).toBe("failed");
  });
  it("después de un reintento fallido, un envío bueno lo deja «enviado» con un solo mensaje", async () => {
    const t = await register("s-retry-ok");
    const { n } = await pendingNote(t);
    expect(await sendOne(t.tenantId, n.id, { send: async () => ({ kind: "retry", reason: "x" }) })).toBe("retry");
    expect(await sendOne(t.tenantId, n.id, { send: okSend() })).toBe("sent");
    expect(await outMsgs(t)).toHaveLength(1);
    expect((await notes(t))[0]).toMatchObject({ status: "enviado", attempts: 2 });
  });
  it("Meta rechaza (131047): fallido por ventana, con tarea; otro código: fallido con el código", async () => {
    const t = await register("s-rej");
    const { n } = await pendingNote(t);
    expect(await sendOne(t.tenantId, n.id, { send: async () => ({ kind: "rejected", status: 400, code: 131047, message: "x" }) })).toBe("failed");
    expect((await notes(t))[0].reason).toContain("ventana_cerrada");
    expect((await outMsgs(t))[0].send_state).toBe("failed");
    expect(await tasks(t)).toHaveLength(1);
    const t2 = await register("s-rej2");
    const p2 = await pendingNote(t2);
    await sendOne(t2.tenantId, p2.n.id, { send: async () => ({ kind: "rejected", status: 401, code: 190, message: "token vencido" }) });
    expect((await notes(t2))[0].reason).toContain("190");
  });
  it("respuesta incierta de Meta: NO se reintenta (podría duplicarse); fallido «incierto» con tarea", async () => {
    const t = await register("s-unk");
    const { n } = await pendingNote(t);
    const calls: number[] = [];
    expect(await sendOne(t.tenantId, n.id, { send: async () => { calls.push(1); return { kind: "unknown", reason: "tiempo agotado" }; } })).toBe("failed");
    expect(await sendOne(t.tenantId, n.id, { send: async () => { calls.push(1); return { kind: "sent", waMessageId: "wamid.X1234" }; } })).toBe("skipped");
    expect(calls).toHaveLength(1);
    expect((await notes(t))[0].reason).toContain("incierto");
    expect((await outMsgs(t))[0].send_state).toBe("unknown");
    expect((await tasks(t))[0].detail).toContain("No se sabe si el aviso salió");
  });
  it("el worker se cayó a medias (mensaje «sending» sin resultado): no se reenvía y se pide revisar", async () => {
    const t = await register("s-crash");
    const { n, c } = await pendingNote(t);
    await withTenant(t.tenantId, (db) => db.query("INSERT INTO messages (tenant_id, conversation_id, direction, msg_type, body, send_state, client_key, received_at) VALUES ($1,$2,'out','text','x','sending',$3, now() - interval '10 minutes')", [t.tenantId, c.conversationId, n.id]));
    const log: { to: string; body: string }[] = [];
    expect(await sendOne(t.tenantId, n.id, { send: okSend(log) })).toBe("failed");
    expect(log).toHaveLength(0);
    expect((await notes(t))[0].reason).toContain("incierto");
    expect(await tasks(t)).toHaveLength(1);
  });
  it("otro worker lo está enviando ahora mismo (mensaje «sending» reciente): no se toca ni se crea tarea", async () => {
    const t = await register("s-inflight");
    const { n, c } = await pendingNote(t);
    await withTenant(t.tenantId, (db) => db.query("INSERT INTO messages (tenant_id, conversation_id, direction, msg_type, body, send_state, client_key) VALUES ($1,$2,'out','text','x','sending',$3)", [t.tenantId, c.conversationId, n.id]));
    const log: { to: string; body: string }[] = [];
    expect(await sendOne(t.tenantId, n.id, { send: okSend(log) })).toBe("skipped");
    expect(log).toHaveLength(0);
    expect((await notes(t))[0].status).toBe("pendiente");
    expect(await tasks(t)).toHaveLength(0);
    expect(await owner.query("SELECT 1 FROM notification_queue WHERE notification_id = $1", [n.id]).then((r) => r.rowCount)).toBe(1);
  });
  it("mensaje ya enviado pero aviso sin cerrar: se cierra como enviado sin reenviar", async () => {
    const t = await register("s-closeonly");
    const { n, c } = await pendingNote(t);
    await withTenant(t.tenantId, (db) => db.query("INSERT INTO messages (tenant_id, conversation_id, direction, msg_type, body, send_state, wa_message_id, client_key) VALUES ($1,$2,'out','text','x','sent','wamid.DONE12345',$3)", [t.tenantId, c.conversationId, n.id]));
    const log: { to: string; body: string }[] = [];
    expect(await sendOne(t.tenantId, n.id, { send: okSend(log) })).toBe("sent");
    expect(log).toHaveLength(0);
    expect((await notes(t))[0].status).toBe("enviado");
  });
  it("sendDue toma de la cola solo lo vencido y lo envía", async () => {
    const t = await register("s-due");
    const { n, c } = await pendingNote(t);
    await owner.query("UPDATE notification_queue SET next_attempt_at = now() + interval '1 hour' WHERE notification_id = $1", [n.id]);
    const log: { to: string; body: string }[] = [];
    await sendDue(50, { send: okSend(log) });
    expect((await notes(t))[0].status).toBe("pendiente");
    expect(log.some((l) => l.to === c.waId)).toBe(false);
    await owner.query("UPDATE notification_queue SET next_attempt_at = now() WHERE notification_id = $1", [n.id]);
    await sendDue(50, { send: okSend(log) });
    expect((await notes(t))[0].status).toBe("enviado");
    expect(log.filter((l) => l.to === c.waId)).toHaveLength(1);
  });
  it("la cola no es accesible directamente por la aplicación", async () => {
    await expect(getPool().query("SELECT * FROM notification_queue")).rejects.toThrow(/permission denied/);
  });
});

describe("baja y alta pedidas por el cliente", () => {
  it.each([["BAJA", "off"], ["baja", "off"], [" Stop. ", "off"], ["no más avisos", "off"], ["No quiero más mensajes!", "off"], ["ALTA", "on"], ["start", "on"], ["quiero avisos", "on"]])("«%s» → %s", (txt, r) => {
    expect(optOutIntent(txt)).toBe(r);
  });
  it.each([["hola"], [""], [null], [undefined], ["dame de baja mi pedido"], ["no stop"], ["la baja de mi cita por favor"], ["start de las 5"]])("«%s» no es una orden de baja/alta", (txt) => {
    expect(optOutIntent(txt as string)).toBeNull();
  });
});

describe("la baja llega por WhatsApp (ingesta)", () => {
  const say = (t: T, waId: string, body: string | null, type = "text") =>
    ingestBatch({ phoneNumberId: t.phoneId, messages: [{ waId, name: "Ana", waMessageId: `wamid.B.${randomUUID()}`, at: new Date(), type, body }], statuses: [] });
  const off = (t: T, c: { contactId: string }) => withTenant(t.tenantId, async (db) => (await db.query("SELECT notifications_off FROM contacts WHERE id = $1", [c.contactId])).rows[0].notifications_off as boolean);
  it("BAJA apaga los avisos; ALTA los vuelve a encender; una frase normal no cambia nada", async () => {
    const t = await register("i-off");
    const c = await customer(t);
    await say(t, c.waId, "Hola, quiero un pedido");
    expect(await off(t, c)).toBe(false);
    await say(t, c.waId, "BAJA");
    expect(await off(t, c)).toBe(true);
    await say(t, c.waId, "gracias, buen día");
    expect(await off(t, c)).toBe(true);
    await say(t, c.waId, "alta");
    expect(await off(t, c)).toBe(false);
  });
  it("solo vale en mensajes de texto, y la baja de un cliente no afecta a otro", async () => {
    const t = await register("i-off2");
    const a = await customer(t), b = await customer(t);
    await say(t, a.waId, "BAJA", "image");
    expect(await off(t, a)).toBe(false);
    await say(t, a.waId, "stop");
    expect(await off(t, a)).toBe(true);
    expect(await off(t, b)).toBe(false);
  });
  it("tras la baja, un pedido confirmado ya no genera aviso enviable", async () => {
    const t = await register("i-off3");
    await mkRule(t);
    const c = await customer(t);
    await say(t, c.waId, "BAJA");
    await confirm(t, (await orderFor(t, c)).id);
    expect((await notes(t))[0]).toMatchObject({ status: "omitido", reason: "baja" });
  });
});

describe("reglas con aviso al cliente (API)", () => {
  it("crea y lista la regla con su mensaje; el tipo «tarea» no guarda mensaje", async () => {
    const t = await register("a-ok");
    const id = await mkRule(t);
    const list = await (await listRules(api("GET", "/api/automations", t.cookie))).json();
    expect(list.rules[0]).toMatchObject({ id, actionType: "mensaje", messageTemplate: expect.stringContaining("{cliente}") });
    expect(list.notifications).toEqual([]);
    const id2 = await mkRule(t, { name: "T", actionType: "tarea", messageTemplate: "ignorado", triggerEvent: "order.created", onlyStatus: null });
    const r2 = (await (await listRules(api("GET", "/api/automations", t.cookie))).json()).rules.find((r: { id: string }) => r.id === id2);
    expect(r2).toMatchObject({ actionType: "tarea", messageTemplate: null });
  });
  it.each<[string, Record<string, unknown>]>([
    ["mensaje sin texto", { messageTemplate: "" }],
    ["mensaje solo espacios", { messageTemplate: "   " }],
    ["mensaje sin campo", { messageTemplate: null }],
    ["mensaje demasiado largo", { messageTemplate: "a".repeat(601) }],
    ["aviso sin cliente (pasa a una persona)", { triggerEvent: "conversation.handoff", onlyStatus: null }],
    ["acción desconocida", { actionType: "correo" }],
  ])("rechaza: %s", async (_n, body) => {
    const t = await register("a-bad" + Math.random().toString(36).slice(2, 8));
    const res = await rcreate(t, body);
    expect([400, 422]).toContain(res.status);
    expect(await withTenant(t.tenantId, async (db) => (await db.query("SELECT count(*)::int AS n FROM automation_rules")).rows[0].n)).toBe(0);
  });
  it("editar: de aviso a tarea limpia el mensaje; de tarea a aviso lo exige", async () => {
    const t = await register("a-edit");
    const id = await mkRule(t);
    const base = { action: "edit", id, name: "X", triggerEvent: "order.created", onlyStatus: null, taskTitle: "T", taskPriority: 2, taskDueMinutes: null };
    expect((await rupdate(t, { ...base, actionType: "tarea" })).status).toBe(200);
    expect((await ruleRowOf(t, id)).message_template).toBeNull();
    expect((await rupdate(t, { ...base, actionType: "mensaje" })).status).toBe(422);
    expect((await rupdate(t, { ...base, actionType: "mensaje", messageTemplate: "Hola {cliente}" })).status).toBe(200);
    expect((await ruleRowOf(t, id)).message_template).toBe("Hola {cliente}");
    expect((await rupdate(t, { ...base, actionType: "mensaje", messageTemplate: "Hola", triggerEvent: "conversation.handoff" })).status).toBe(422);
  });
  it("el registro de avisos aparece en la lista (sin datos de otros negocios)", async () => {
    const a = await register("a-log-a");
    const b = await register("a-log-b");
    await pendingNote(a);
    const la = await (await listRules(api("GET", "/api/automations", a.cookie))).json();
    expect(la.notifications).toHaveLength(1);
    expect(la.notifications[0]).toMatchObject({ status: "pendiente", customerName: "Ana", ruleName: "Aviso" });
    expect((await (await listRules(api("GET", "/api/automations", b.cookie))).json()).notifications).toEqual([]);
  });
  it("actionError", () => {
    expect(actionError({ actionType: "tarea", triggerEvent: "conversation.handoff" })).toBeNull();
    expect(actionError({ actionType: "mensaje", triggerEvent: "order.created", messageTemplate: "x" })).toBeNull();
    expect(actionError({ actionType: "mensaje", triggerEvent: "order.created", messageTemplate: " " })).not.toBeNull();
    expect(actionError({ actionType: "mensaje", triggerEvent: "conversation.handoff", messageTemplate: "x" })).not.toBeNull();
  });
});
