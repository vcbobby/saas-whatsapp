import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { POST as signup } from "@/app/api/auth/signup/route";
import { GET as me } from "@/app/api/me/route";
import { createOrder, transitionOrder } from "@/lib/orders/service";
import { getPool, withTenant } from "@/lib/db";
import { encryptSecret } from "@/lib/crypto";
import { sendOne } from "@/lib/notifications/send";
import type { SendResult } from "@/lib/whatsapp/graph";

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
  const email = `nq-${RUN}-${name}@example.test`;
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

beforeAll(async () => { await getPool().query("SELECT 1"); });
afterAll(async () => {
  await owner.query("DELETE FROM users WHERE email LIKE $1", [`nq-${RUN}-%`]);
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


const TPL_BODY = "Hola {{1}}, tu pedido {{2}} fue confirmado. ¡Gracias!";
async function mkTemplate(t: T, o: { status?: string; sendable?: boolean; name?: string; body?: string } = {}) {
  const r = await withTenant(t.tenantId, (db) => db.query("INSERT INTO whatsapp_templates (tenant_id, name, language, category, body, status, sendable) VALUES ($1,$2,'es','UTILITY',$3,$4,$5) RETURNING id", [t.tenantId, o.name ?? `pedido_${randomUUID().slice(0, 6).replace(/-/g, "")}`, o.body ?? TPL_BODY, o.status ?? "APPROVED", o.sendable ?? true]));
  return r.rows[0].id as string;
}
const withTpl = (templateId: string, templateParams: string[] = ["{cliente}", "{numero}"]) => ({ templateId, templateParams });
const okTpl = (log: { to: string; name: string; language: string; params: string[] }[] = []) => async (_p: string, _t: string, to: string, tpl: { name: string; language: string; params: string[] }): Promise<SendResult> => { log.push({ to, ...tpl }); return { kind: "sent", waMessageId: `wamid.TPL.${randomUUID()}` }; };
const failSend = async (): Promise<SendResult> => { throw new Error("no debe enviarse texto libre"); };

async function ruleRowOf(t: T, id: string) { return withTenant(t.tenantId, async (db) => (await db.query("SELECT * FROM automation_rules WHERE id = $1", [id])).rows[0]); }

describe("validación de la plantilla de respaldo de una regla", () => {
  it("exige plantilla aprobada, enviable y con un dato por variable", async () => {
    const t = await register("v1");
    const ok = await mkTemplate(t);
    expect((await rcreate(t, withTpl(ok))).status).toBe(201);
    expect((await rcreate(t, withTpl(ok, ["{cliente}"]))).status).toBe(422);
    expect((await rcreate(t, withTpl(ok, ["{cliente}", "  "]))).status).toBe(422);
    expect((await rcreate(t, withTpl(await mkTemplate(t, { status: "PENDING" })))).status).toBe(422);
    expect((await rcreate(t, withTpl(await mkTemplate(t, { sendable: false })))).status).toBe(422);
    expect((await rcreate(t, withTpl(randomUUID()))).status).toBe(422);
  });
  it("no se puede usar la plantilla de otro negocio", async () => {
    const a = await register("v2a");
    const b = await register("v2b");
    const tplA = await mkTemplate(a);
    const r = await rcreate(b, withTpl(tplA));
    expect(r.status).toBe(422);
    expect((await r.json()).error).toBe("plantilla_no_valida");
  });
  it("una regla de tarea o de app ignora la plantilla; editar la quita o la cambia", async () => {
    const t = await register("v3");
    const tpl = await mkTemplate(t);
    const id = await mkRule(t, { actionType: "tarea", messageTemplate: null, ...withTpl(tpl) });
    expect((await ruleRowOf(t, id)).template_id).toBeNull();
    const rid = await mkRule(t, withTpl(tpl));
    expect((await ruleRowOf(t, rid)).template_id).toBe(tpl);
    const edit = { action: "edit", id: rid, name: "Aviso", triggerEvent: "order.status_changed", onlyStatus: "confirmado", actionType: "mensaje", messageTemplate: "Hola {cliente}", taskTitle: "Avisar", taskPriority: 2 };
    expect((await rupdate(t, { ...edit, templateId: null, templateParams: [] })).status).toBe(200);
    expect((await ruleRowOf(t, rid)).template_id).toBeNull();
    expect((await rupdate(t, { ...edit, ...withTpl(tpl, ["{cliente}"]) })).status).toBe(422);
    const list = await (await listRules(api("GET", "/api/automations", t.cookie))).json();
    expect(list.rules.find((x: { id: string }) => x.id === rid)).toMatchObject({ templateId: null, templateParams: [] });
  });
});

describe("el aviso guarda una copia de la plantilla ya llena", () => {
  it("al confirmar el pedido quedan nombre, idioma, datos y texto final", async () => {
    const t = await register("c1");
    const tpl = await mkTemplate(t, { name: "pedido_confirmado" });
    await mkRule(t, withTpl(tpl));
    const c = await customer(t);
    const o = await orderFor(t, c, "Ana");
    await confirm(t, o.id);
    const [n] = await notes(t);
    expect(n).toMatchObject({ template_name: "pedido_confirmado", template_language: "es", template_params: ["Ana", String(o.number)], template_text: `Hola Ana, tu pedido ${o.number} fue confirmado. ¡Gracias!` });
    expect(n.body).toContain("Hola Ana"); // el texto libre de siempre sigue ahí
  });
  it("si un dato queda vacío, no se usa la plantilla (el aviso es el de siempre)", async () => {
    const t = await register("c2");
    const tpl = await mkTemplate(t);
    await mkRule(t, withTpl(tpl, ["{cliente}", "{fecha}"])); // un pedido no tiene {fecha}
    const c = await customer(t);
    await confirm(t, (await orderFor(t, c)).id);
    expect((await notes(t))[0]).toMatchObject({ template_name: null, template_params: null, template_text: null });
  });
});

describe("envío con plantilla pasadas las 24 h", () => {
  async function pending(name: string, o: { inboundAgoHours?: number | null; tpl?: boolean } = {}) {
    const t = await register(name);
    const tpl = await mkTemplate(t, { name: "pedido_confirmado" });
    const ruleId = await mkRule(t, o.tpl === false ? {} : withTpl(tpl));
    const c = await customer(t, { inboundAgoHours: o.inboundAgoHours === undefined ? 30 : o.inboundAgoHours });
    await confirm(t, (await orderFor(t, c)).id);
    const [n] = await notes(t);
    return { t, tpl, ruleId, c, n };
  }

  it("ventana cerrada + plantilla: sale la plantilla, se guarda como plantilla y no se crea tarea", async () => {
    const { t, c, n } = await pending("e1");
    const log: { to: string; name: string; language: string; params: string[] }[] = [];
    expect(await sendOne(t.tenantId, n.id, { send: failSend, sendTemplate: okTpl(log) })).toBe("sent");
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({ to: c.waId, name: "pedido_confirmado", language: "es" });
    expect(log[0]!.params[0]).toBe("Ana");
    expect((await notes(t))[0]).toMatchObject({ status: "enviado" });
    const [m] = await outMsgs(t);
    expect(m).toMatchObject({ msg_type: "template", send_state: "sent", body: n.template_text });
    expect(await tasks(t)).toHaveLength(0);
  });
  it("nunca escribió: también sale por plantilla", async () => {
    const { t, n } = await pending("e2", { inboundAgoHours: null });
    expect(await sendOne(t.tenantId, n.id, { send: failSend, sendTemplate: okTpl() })).toBe("sent");
  });
  it("dentro de las 24 h se envía el texto libre y la plantilla no se usa", async () => {
    const { t, n } = await pending("e3", { inboundAgoHours: 2 });
    const log: { to: string; body: string }[] = [];
    const tplLog: { to: string; name: string; language: string; params: string[] }[] = [];
    expect(await sendOne(t.tenantId, n.id, { send: okSend(log), sendTemplate: okTpl(tplLog) })).toBe("sent");
    expect(log).toHaveLength(1);
    expect(tplLog).toHaveLength(0);
    expect((await outMsgs(t))[0]).toMatchObject({ msg_type: "text" });
  });
  it("sin plantilla en la regla, pasadas las 24 h sigue igual: omitido y tarea", async () => {
    const { t, n } = await pending("e4", { tpl: false });
    expect(await sendOne(t.tenantId, n.id, { send: failSend, sendTemplate: okTpl() })).toBe("omitted");
    expect((await notes(t))[0]).toMatchObject({ status: "omitido", reason: "ventana_cerrada" });
    expect(await tasks(t)).toHaveLength(1);
  });
  it("si Meta rechaza la plantilla (pausada): falla con motivo y queda la tarea para avisar a mano", async () => {
    const { t, n } = await pending("e5");
    const rejected = async (): Promise<SendResult> => ({ kind: "rejected", status: 400, code: 132015, message: "paused" });
    expect(await sendOne(t.tenantId, n.id, { send: failSend, sendTemplate: rejected })).toBe("failed");
    expect((await notes(t))[0].reason).toContain("132015");
    expect(await tasks(t)).toHaveLength(1);
  });
  it("si la plantilla se borra después, el aviso ya creado igual se envía y la regla deja de usarla", async () => {
    const { t, tpl, ruleId, n } = await pending("e6");
    await withTenant(t.tenantId, (db) => db.query("DELETE FROM whatsapp_templates WHERE id = $1", [tpl]));
    expect((await ruleRowOf(t, ruleId)).template_id).toBeNull();
    expect(await sendOne(t.tenantId, n.id, { send: failSend, sendTemplate: okTpl() })).toBe("sent");
  });
  it("un fallo de red antes de enviar se reintenta con la misma plantilla (sin duplicar)", async () => {
    const { t, n } = await pending("e7");
    const retry = async (): Promise<SendResult> => ({ kind: "retry", reason: "ENOTFOUND" });
    expect(await sendOne(t.tenantId, n.id, { send: failSend, sendTemplate: retry })).toBe("retry");
    expect(await outMsgs(t)).toHaveLength(0);
    expect(await sendOne(t.tenantId, n.id, { send: failSend, sendTemplate: okTpl() })).toBe("sent");
    expect(await outMsgs(t)).toHaveLength(1);
  });
});
