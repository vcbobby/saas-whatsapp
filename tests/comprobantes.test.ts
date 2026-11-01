import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { POST as signup } from "@/app/api/auth/signup/route";
import { GET as me } from "@/app/api/me/route";
import { GET as ordersGet } from "@/app/api/orders/route";
import { POST as payPost } from "@/app/api/orders/payment/route";
import { GET as proofGet } from "@/app/api/orders/proof/route";
import { GET as mediaGet } from "@/app/api/conversations/media/route";
import { GET as messagesGet } from "@/app/api/conversations/messages/route";
import { parseWebhook } from "@/lib/whatsapp/payload";
import { fetchWhatsAppMedia } from "@/lib/whatsapp/media";
import { runAgent } from "@/lib/agent/run";
import { type LlmProvider } from "@/lib/ai/provider";
import { encryptSecret } from "@/lib/crypto";
import { getPool, withTenant } from "@/lib/db";
import { closeLockClient } from "@/lib/queue/lock";
import { ingestBatch } from "@/lib/whatsapp/ingest";
import type { SendResult } from "@/lib/whatsapp/graph";

process.env.WHATSAPP_APP_SECRET = "secreto-de-prueba-de-la-app-meta";
process.env.WHATSAPP_VERIFY_TOKEN = "token-de-verificacion-de-prueba-123456";
const RUN = randomUUID().slice(0, 8);
process.env.QUEUE_PREFIX = `test-c-${RUN}`;
const ORIGIN = new URL(process.env.APP_URL!).origin;
const PASSWORD = "contraseña-de-prueba-123";
const TOKEN = "EAAtoken-de-prueba-del-negocio-1234567890";
const owner = new Pool({ connectionString: process.env.MIGRATION_DATABASE_URL, max: 2 });
const tenantIds: string[] = [];
let seq = 0;
const newPhoneId = () => `6${RUN.replace(/\D/g, "").padEnd(4, "3").slice(0, 4)}${Date.now() % 100000}${seq++}`.slice(0, 18);
const newWaId = () => `58412${String(Date.now()).slice(-6)}${seq++}`.slice(0, 15);

function api(method: string, path: string, cookie?: string, body?: unknown, origin = ORIGIN) {
  return new Request(`${ORIGIN}${path}`, {
    method,
    headers: { origin, ...(body !== undefined ? { "content-type": "application/json" } : {}), ...(cookie ? { cookie } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

async function register(name: string, opts: { agent?: boolean; instructions?: string } = {}) {
  const email = `cp-${RUN}-${name}@example.test`;
  const res = await signup(api("POST", "/api/auth/signup", undefined, { email, password: PASSWORD, businessName: `Negocio ${name}` }));
  expect(res.status).toBe(201);
  const cookie = (res.headers.get("set-cookie") ?? "").split(";")[0]!;
  const info = await (await me(api("GET", "/api/me", cookie))).json();
  const tenantId = info.tenant.id as string;
  tenantIds.push(tenantId);
  const phoneId = newPhoneId();
  const { payload, keyVersion } = encryptSecret(TOKEN, `wa:${tenantId}:${phoneId}`);
  await owner.query("INSERT INTO tenant_integrations (tenant_id, provider, external_id, secret_enc, key_version) VALUES ($1,'whatsapp',$2,$3,$4)", [tenantId, phoneId, payload, keyVersion]);
  if (opts.agent !== false) {
    await withTenant(tenantId, (db) => db.query("INSERT INTO tenant_agents (tenant_id, enabled, assistant_name, instructions) VALUES ($1, true, 'Ana', $2)", [tenantId, opts.instructions ?? "Abrimos de 8am a 5pm. Corte: $10."]));
  }
  return { tenantId, phoneId, cookie, email };
}

type T = Awaited<ReturnType<typeof register>>;
const planSeq = 0;
const planRows: string[] = [];
let t0 = Math.floor(Date.now() / 1000) - 600;
/** Crea un mensaje entrante (como lo haría el webhook) y devuelve su id. */
async function inbound(t: T, waId: string, body: string | null, type = "text") {
  const r = await ingestBatch({ phoneNumberId: t.phoneId, statuses: [], messages: [{ waId, name: "Cliente", waMessageId: `wamid.${RUN}.${seq++}`, at: new Date(++t0 * 1000), type, body }] });
  return r.inbound[0]!.messageId;
}
const job = (t: T, messageId: string) => ({ tenantId: t.tenantId, messageId });

const sent = (id = `wamid.out.${randomUUID()}`): SendResult => ({ kind: "sent", waMessageId: id });
function deps(opts: { text?: string; result?: SendResult | (() => SendResult | Promise<SendResult>); delay?: number } = {}) {
  const llm = { name: "stub", generate: vi.fn(async () => { if (opts.delay) await new Promise((r) => setTimeout(r, opts.delay)); return { text: opts.text ?? "Hola, abrimos de 8am a 5pm.", inputTokens: 10, outputTokens: 5, model: "stub" }; }) };
  const send = vi.fn(async (...args: unknown[]) => (void args, typeof opts.result === "function" ? opts.result() : (opts.result ?? sent())));
  return { llm: llm as unknown as LlmProvider & { generate: ReturnType<typeof vi.fn> }, send, raw: { llm: llm as unknown as LlmProvider, send: send as never } };
}


beforeAll(async () => { await getPool().query("SELECT 1"); });
afterEach(() => { vi.unstubAllEnvs(); });

afterAll(async () => {
  await closeLockClient();
  await owner.query("DELETE FROM users WHERE email LIKE $1", [`cp-${RUN}-%`]);
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
  if (planRows.length) await owner.query("DELETE FROM plans WHERE id = ANY($1)", [planRows]);
  await owner.end();
  await getPool().end();
});



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
let orderSeq = 0;
/** Pedido con una línea (el total siempre cuadra) para el cliente de esa conversación. */
async function orderFor(t: T, contactId: string, o: { status?: string; payment?: string } = {}) {
  const status = o.status ?? "confirmado";
  const num = ++orderSeq + (Date.now() % 100000) * 10;
  const prod = (await oq(t, "INSERT INTO catalog_products (tenant_id, name, price_minor) VALUES ($1,'Pan',500) ON CONFLICT (tenant_id, lower(name)) WHERE active DO UPDATE SET price_minor = 500 RETURNING id", [t.tenantId])).rows[0].id as string;
  const r = await oq(t, `WITH o AS (INSERT INTO orders (tenant_id, number, contact_id, customer_name, status, source, currency, total_minor, confirmed_at, cancelled_at, payment_state, paid_at)
      VALUES ($1,$2,$3,'Cliente',$4,'manual','USD',1000,$5,$6,$7,$8) RETURNING id)
    INSERT INTO order_items (tenant_id, order_id, product_id, position, name, unit_price_minor, quantity, line_total_minor) SELECT $1, o.id, $9, 1, 'Pan', 500, 2, 1000 FROM o RETURNING order_id`,
    [t.tenantId, num, contactId, status, status === "pendiente" ? null : new Date(), status === "cancelado" ? new Date() : null, o.payment ?? "sin_pago", o.payment === "pagado" ? new Date() : null, prod]);
  return r.rows[0].order_id as string;
}
async function imageIn(t: T, waId: string, o: { mime?: string; id?: string } = {}) {
  const r = await ingestBatch({ phoneNumberId: t.phoneId, statuses: [], messages: [{ waId, name: "Cliente", waMessageId: `wamid.${RUN}.${seq++}`, at: new Date(++t0 * 1000), type: "image", body: null, mediaId: o.id ?? `MEDIA${seq}${RUN}`, mediaMime: o.mime ?? "image/jpeg" }] });
  return r.inbound[0]!.messageId;
}
const contactOf = async (t: T, wa: string) => (await oq(t, "SELECT id FROM contacts WHERE tenant_id = $1 AND wa_id = $2", [t.tenantId, wa])).rows[0].id as string;
const orderRow = async (t: T, id: string) => (await oq(t, "SELECT payment_state, proof_message_id, paid_at, payment_method FROM orders WHERE tenant_id = $1 AND id = $2", [t.tenantId, id])).rows[0];
const works = async (t: T) => (await oq(t, "SELECT type, status, dedupe_key, title FROM work_items WHERE tenant_id = $1 AND type = 'pago_por_verificar' ORDER BY created_at", [t.tenantId])).rows;
const pay = (t: { cookie: string }, id: string, action: string, extra: object = {}, origin = ORIGIN) => payPost(api("POST", "/api/orders/payment", t.cookie, { id, action, ...extra }, origin));
/** Primer mensaje del cliente (texto) para que exista contacto y conversación; devuelve su contacto. */
async function customer(t: T) {
  const wa = newWaId();
  await inbound(t, wa, "hola");
  return { wa, contactId: await contactOf(t, wa) };
}

describe("imágenes recibidas: lectura del aviso de Meta", () => {
  const hook = (message: object) => parseWebhook({ object: "whatsapp_business_account", entry: [{ changes: [{ field: "messages", value: { metadata: { phone_number_id: "123456789" }, messages: [{ from: "584120000000", id: "wamid.x", timestamp: String(Math.floor(Date.now() / 1000)), ...message }] } }] }] })![0]!.messages[0]!;
  it("guarda el id y el tipo de una imagen; ignora tipos raros e ids sospechosos", () => {
    expect(hook({ type: "image", image: { id: "9876_abc-DEF", mime_type: "image/jpeg", caption: "mi pago" } })).toMatchObject({ mediaId: "9876_abc-DEF", mediaMime: "image/jpeg", body: "mi pago" });
    expect(hook({ type: "image", image: { id: "1", mime_type: "IMAGE/PNG; charset=x" } })).toMatchObject({ mediaMime: "image/png" });
    expect(hook({ type: "image", image: { id: "1", mime_type: "image/svg+xml" } }).mediaId).toBeUndefined();
    expect(hook({ type: "image", image: { id: "../etc/passwd", mime_type: "image/png" } }).mediaId).toBeUndefined();
    expect(hook({ type: "image", image: { id: "x".repeat(201), mime_type: "image/png" } }).mediaId).toBeUndefined();
    expect(hook({ type: "sticker", sticker: { id: "5", mime_type: "image/webp" } }).mediaId).toBeUndefined();
    expect(hook({ type: "text", text: { body: "hola" } }).mediaId).toBeUndefined();
  });
});

describe("descargar la imagen de WhatsApp", () => {
  const res = (body: BodyInit | null, init: ResponseInit = {}) => new Response(body, init);
  const meta = (o: object = {}) => res(JSON.stringify({ url: "https://lookaside.fbsbx.com/whatsapp_business/attachments/?mid=1", mime_type: "image/jpeg", file_size: 4, ...o }));
  it("baja la imagen en dos pasos con el token del negocio", async () => {
    const calls: [string, string | null][] = [];
    const f = (async (url: string, init: RequestInit) => { calls.push([url, (init.headers as Record<string, string>).Authorization ?? null]); return calls.length === 1 ? meta({ url: "https://scontent.xx.fbcdn.net/x.jpg" }) : res(new Uint8Array([1, 2, 3, 4])); }) as unknown as typeof fetch;
    const out = await fetchWhatsAppMedia("MEDIA1", "TOKEN123", f);
    expect(out).toMatchObject({ ok: true, mime: "image/jpeg" });
    expect(calls[0]![0]).toMatch(/graph\.facebook\.com\/.+\/MEDIA1$/);
    expect(calls.map((c) => c[1])).toEqual(["Bearer TOKEN123", "Bearer TOKEN123"]);
  });
  it("expirada, demasiado grande, formato no permitido, red caída, id inválido", async () => {
    const f404 = (async () => res("{}", { status: 404 })) as unknown as typeof fetch;
    expect(await fetchWhatsAppMedia("M1", "T", f404)).toEqual({ ok: false, reason: "expirada" });
    const big = (async () => meta({ file_size: 6 * 1024 * 1024 })) as unknown as typeof fetch;
    expect(await fetchWhatsAppMedia("M1", "T", big)).toEqual({ ok: false, reason: "grande" });
    const pdf = (async () => meta({ mime_type: "application/pdf" })) as unknown as typeof fetch;
    expect(await fetchWhatsAppMedia("M1", "T", pdf)).toEqual({ ok: false, reason: "formato" });
    const boom = (async () => { throw new Error("sin red"); }) as unknown as typeof fetch;
    expect(await fetchWhatsAppMedia("M1", "T", boom)).toEqual({ ok: false, reason: "red" });
    expect(await fetchWhatsAppMedia("../x", "T", boom)).toEqual({ ok: false, reason: "formato" });
    const file410 = (async (u: string) => (u.includes("graph.") ? meta() : res("", { status: 410 }))) as unknown as typeof fetch;
    expect(await fetchWhatsAppMedia("M1", "T", file410)).toEqual({ ok: false, reason: "expirada" });
  });
  it("solo descarga de servidores de Meta (nunca del dominio que venga en la respuesta) y nunca pasa del tope", async () => {
    let second = false;
    const evil = (async (u: string) => { if (!u.includes("graph.")) second = true; return meta({ url: "https://evil.example.com/steal" }); }) as unknown as typeof fetch;
    expect(await fetchWhatsAppMedia("M1", "T", evil)).toEqual({ ok: false, reason: "red" });
    expect(second).toBe(false);
    const sneaky = (async (u: string) => (u.includes("graph.") ? meta({ url: "https://facebook.com.evil.example/x" }) : res("x"))) as unknown as typeof fetch;
    expect(await fetchWhatsAppMedia("M1", "T", sneaky)).toEqual({ ok: false, reason: "red" });
    const huge = (async (u: string) => (u.includes("graph.") ? meta({ file_size: 10, url: "https://scontent.xx.fbcdn.net/x" }) : res(new Uint8Array(5 * 1024 * 1024 + 1)))) as unknown as typeof fetch;
    expect(await fetchWhatsAppMedia("M1", "T", huge)).toEqual({ ok: false, reason: "grande" });
  });
});

describe("comprobante: al llegar una imagen", () => {
  it("con UN pedido por pagar: queda como su comprobante y se abre una tarea; no se marca pagado", async () => {
    const t = await register("uno");
    const { wa, contactId } = await customer(t);
    const o = await orderFor(t, contactId);
    const m = await imageIn(t, wa);
    const row = await orderRow(t, o);
    expect(row).toMatchObject({ payment_state: "por_verificar", proof_message_id: m, paid_at: null });
    const w = await works(t);
    expect(w).toHaveLength(1);
    expect(w[0]).toMatchObject({ status: "abierto", dedupe_key: `pago:${o}` });
    expect(w[0].title).toContain("Verificar pago del pedido");
  });
  it("con varios pedidos: tarea sin vincular y ninguno cambia; sin pedidos, o con pedido pagado o cancelado: nada", async () => {
    const t = await register("varios");
    const a = await customer(t);
    const o1 = await orderFor(t, a.contactId), o2 = await orderFor(t, a.contactId, { status: "pendiente" });
    await imageIn(t, a.wa);
    expect((await orderRow(t, o1)).payment_state).toBe("sin_pago");
    expect((await orderRow(t, o2)).payment_state).toBe("sin_pago");
    expect((await works(t))[0].dedupe_key).toMatch(/^pago-msg:/);
    const b = await customer(t); // sin pedidos
    await imageIn(t, b.wa);
    const c = await customer(t);
    await orderFor(t, c.contactId, { payment: "pagado" });
    await orderFor(t, c.contactId, { status: "cancelado" });
    await imageIn(t, c.wa);
    expect(await works(t)).toHaveLength(1);
  });
  it("un comprobante nuevo reabre la tarea de un pedido cuyo pago se rechazó", async () => {
    const t = await register("reabre");
    const { wa, contactId } = await customer(t);
    const o = await orderFor(t, contactId);
    await imageIn(t, wa);
    expect((await pay(t, o, "rechazar")).status).toBe(200);
    expect((await works(t))[0].status).toBe("descartado");
    await imageIn(t, wa);
    expect(await orderRow(t, o)).toMatchObject({ payment_state: "por_verificar" });
    expect((await works(t)).map((w) => w.status)).toEqual(["abierto"]);
  });
  it("reintentos de Meta (mismo mensaje) no duplican nada", async () => {
    const t = await register("dup");
    const { wa, contactId } = await customer(t);
    await orderFor(t, contactId);
    const waMessageId = `wamid.${RUN}.dup${seq++}`;
    const batch = { phoneNumberId: t.phoneId, statuses: [], messages: [{ waId: wa, name: "C", waMessageId, at: new Date(++t0 * 1000), type: "image", body: null, mediaId: "MEDIADUP", mediaMime: "image/png" }] };
    await ingestBatch(batch); await ingestBatch(batch);
    expect(await works(t)).toHaveLength(1);
  });
});

describe("comprobante: el asistente", () => {
  it("agradece el comprobante, no pasa a una persona, y a otra imagen le responde lo de siempre", async () => {
    const t = await register("asist");
    const { wa, contactId } = await customer(t);
    await orderFor(t, contactId);
    const m = await imageIn(t, wa);
    const d = deps();
    expect(await runAgent(job(t, m), d.raw)).toBe("replied");
    expect(d.llm.generate).not.toHaveBeenCalled();
    expect(d.send.mock.calls[0]![3]).toContain("Recibimos tu comprobante");
    expect((await withTenant(t.tenantId, async (db) => (await db.query("SELECT status FROM conversations")).rows[0])).status).toBe("bot");
    const t2 = await register("asist2");
    const c2 = await customer(t2); // sin pedidos: la imagen no es comprobante
    void c2;
    const m2 = await imageIn(t2, c2.wa);
    const d2 = deps();
    expect(await runAgent(job(t2, m2), d2.raw)).toBe("replied"); // si falla, el valor recibido dice por qué no respondió
    expect(d2.send.mock.calls[0]![3]).toContain("solo puedo leer mensajes de texto");
  });
});

describe("cobro: marcar pagado", () => {
  it("pagado → reabrir → pagado; la tarea se cierra; queda auditado con quién lo hizo", async () => {
    const t = await register("pago");
    const { wa, contactId } = await customer(t);
    const o = await orderFor(t, contactId);
    await imageIn(t, wa);
    expect((await pay(t, o, "pagado", { method: "Pago móvil" })).status).toBe(200);
    expect(await orderRow(t, o)).toMatchObject({ payment_state: "pagado", payment_method: "Pago móvil" });
    expect((await orderRow(t, o)).paid_at).not.toBeNull();
    expect((await works(t))[0].status).toBe("resuelto");
    expect((await pay(t, o, "pagado")).status).toBe(409); // ya pagado
    expect((await pay(t, o, "rechazar")).status).toBe(409); // ya no hay nada por verificar
    expect((await pay(t, o, "reabrir")).status).toBe(200);
    expect(await orderRow(t, o)).toMatchObject({ payment_state: "sin_pago", paid_at: null, payment_method: null });
    expect((await pay(t, o, "reabrir")).status).toBe(409);
    expect((await pay(t, o, "pagado", { method: "Efectivo" })).status).toBe(200);
    const log = await oq(t, "SELECT action FROM audit_log WHERE tenant_id = $1 AND action LIKE 'order.payment.%' ORDER BY created_at", [t.tenantId]);
    expect(log.rows.map((r) => r.action)).toEqual(["order.payment.pagado", "order.payment.reabrir", "order.payment.pagado"]);
  });
  it("sin comprobante también se puede cobrar (efectivo); un pedido cancelado no", async () => {
    const t = await register("efec");
    const { contactId } = await customer(t);
    const o = await orderFor(t, contactId);
    expect((await pay(t, o, "pagado", { method: "Efectivo" })).status).toBe(200);
    const x = await orderFor(t, contactId, { status: "cancelado" });
    expect((await pay(t, x, "pagado")).status).toBe(409);
  });
  it("«no es un pago válido» vuelve a sin pagar y quita el comprobante", async () => {
    const t = await register("rech");
    const { wa, contactId } = await customer(t);
    const o = await orderFor(t, contactId);
    await imageIn(t, wa);
    expect((await pay(t, o, "rechazar")).status).toBe(200);
    expect(await orderRow(t, o)).toMatchObject({ payment_state: "sin_pago", proof_message_id: null });
  });
  it("validación, permisos, origen y aislamiento entre negocios", async () => {
    const t = await register("perm");
    const { contactId } = await customer(t);
    const o = await orderFor(t, contactId);
    expect((await pay(t, "no-es-uuid", "pagado")).status).toBe(400);
    expect((await pay(t, o, "borrar")).status).toBe(400);
    expect((await pay(t, o, "pagado", { method: "x".repeat(41) })).status).toBe(400);
    expect((await pay(t, o, "pagado", {}, "https://malo.example")).status).toBe(403);
    expect((await payPost(api("POST", "/api/orders/payment", undefined, { id: o, action: "pagado" }))).status).toBe(401);
    const other = await register("ajeno");
    expect((await pay(other, o, "pagado")).status).toBe(409); // el pedido es de otro negocio
    expect((await orderRow(t, o)).payment_state).toBe("sin_pago");
  });
  it("el listado de pedidos trae el estado de pago", async () => {
    const t = await register("lista");
    const { wa, contactId } = await customer(t);
    const o = await orderFor(t, contactId);
    await imageIn(t, wa);
    const j = await (await ordersGet(api("GET", "/api/orders", t.cookie))).json();
    expect(j.orders.find((x: { id: string }) => x.id === o)).toMatchObject({ paymentState: "por_verificar", hasProof: true });
  });
});

describe("ver la imagen", () => {
  afterEach(() => { vi.unstubAllGlobals(); });
  const fakeMeta = (calls: string[]) => vi.stubGlobal("fetch", async (u: string) => {
    calls.push(u);
    if (u.includes("graph.facebook.com")) return new Response(JSON.stringify({ url: "https://scontent.xx.fbcdn.net/img", mime_type: "image/jpeg", file_size: 3 }));
    return new Response(new Uint8Array([255, 216, 255]));
  });
  it("la bandeja y el pedido muestran la imagen solo a quien corresponde, con cabeceras seguras", async () => {
    const t = await register("ver");
    const { wa, contactId } = await customer(t);
    const o = await orderFor(t, contactId);
    const m = await imageIn(t, wa, { id: "MEDIAVER" });
    const calls: string[] = [];
    fakeMeta(calls);
    const r1 = await mediaGet(api("GET", `/api/conversations/media?id=${m}`, t.cookie));
    expect(r1.status).toBe(200);
    expect(r1.headers.get("content-type")).toBe("image/jpeg");
    expect(r1.headers.get("x-content-type-options")).toBe("nosniff");
    expect(r1.headers.get("cache-control")).toContain("no-store");
    expect(r1.headers.get("content-security-policy")).toContain("sandbox");
    expect(calls[0]).toContain("/MEDIAVER");
    const r2 = await proofGet(api("GET", `/api/orders/proof?id=${o}`, t.cookie));
    expect(r2.status).toBe(200);
    // Un agente del mismo negocio también la ve; otro negocio, no.
    const other = await register("verajeno");
    expect((await mediaGet(api("GET", `/api/conversations/media?id=${m}`, other.cookie))).status).toBe(404);
    expect((await proofGet(api("GET", `/api/orders/proof?id=${o}`, other.cookie))).status).toBe(404);
    expect((await mediaGet(api("GET", "/api/conversations/media?id=basura", t.cookie))).status).toBe(400);
    expect((await mediaGet(api("GET", `/api/conversations/media?id=${m}`))).status).toBe(401);
  });
  it("mensaje sin imagen: 404; imagen vencida: 410 con un texto claro; sin WhatsApp conectado: 409", async () => {
    const t = await register("err");
    const { wa, contactId } = await customer(t);
    await orderFor(t, contactId);
    const text = await inbound(t, newWaId(), "solo texto");
    const m = await imageIn(t, wa, { id: "MEDIAOLD" });
    vi.stubGlobal("fetch", async () => new Response("{}", { status: 404 }));
    expect((await mediaGet(api("GET", `/api/conversations/media?id=${text}`, t.cookie))).status).toBe(404);
    const gone = await mediaGet(api("GET", `/api/conversations/media?id=${m}`, t.cookie));
    expect(gone.status).toBe(410);
    expect((await gone.json()).message).toContain("30 días");
    await owner.query("DELETE FROM tenant_integrations WHERE tenant_id = $1", [t.tenantId]).catch(() => undefined);
    await oq(t, "DELETE FROM tenant_integrations WHERE tenant_id = $1", [t.tenantId]);
    expect((await mediaGet(api("GET", `/api/conversations/media?id=${m}`, t.cookie))).status).toBe(409);
  });
  it("la conversación marca qué mensajes traen imagen", async () => {
    const t = await register("marca");
    const { wa, contactId } = await customer(t);
    await orderFor(t, contactId);
    await imageIn(t, wa);
    const conv = (await oq(t, "SELECT id FROM conversations WHERE tenant_id = $1", [t.tenantId])).rows[0].id as string;
    const j = await (await messagesGet(api("GET", `/api/conversations/messages?id=${conv}`, t.cookie))).json();
    const img = j.messages.find((x: { type: string }) => x.type === "image");
    expect(img.hasMedia).toBe(true);
    expect(j.messages.find((x: { type: string }) => x.type === "text").hasMedia).toBe(false);
  });
});
