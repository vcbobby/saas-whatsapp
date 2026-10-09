import { createHmac, randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { POST as signup } from "@/app/api/auth/signup/route";
import { GET as me } from "@/app/api/me/route";
import { DELETE as disconnect, POST as connect } from "@/app/api/whatsapp/connect/route";
import { GET as hookGet, POST as hookPost } from "@/app/api/webhooks/whatsapp/route";
import { decryptSecret } from "@/lib/crypto";
import { getPool, withTenant } from "@/lib/db";
import { ingestBatch } from "@/lib/whatsapp/ingest";
import { parseWebhook } from "@/lib/whatsapp/payload";
import { readRawBody, verifySignature } from "@/lib/whatsapp/signature";

process.env.WHATSAPP_APP_SECRET = "secreto-de-prueba-de-la-app-meta";
process.env.WHATSAPP_VERIFY_TOKEN = "token-de-verificacion-de-prueba-123456";
const SECRET = process.env.WHATSAPP_APP_SECRET;
const VERIFY = process.env.WHATSAPP_VERIFY_TOKEN;

const ORIGIN = new URL(process.env.APP_URL!).origin;
const RUN = randomUUID().slice(0, 8);
const PASSWORD = "contraseña-de-prueba-123";
const owner = new Pool({ connectionString: process.env.MIGRATION_DATABASE_URL, max: 2 });
const tenantIds: string[] = [];
// Números de prueba únicos por ejecución.
let seq = 0;
const newPhoneId = () => `9${RUN.replace(/\D/g, "").padEnd(4, "7").slice(0, 4)}${Date.now() % 100000}${seq++}`.slice(0, 18);

const cookieOf = (res: Response) => (res.headers.get("set-cookie") ?? "").split(";")[0]!;
function api(method: string, path: string, cookie?: string, body?: unknown) {
  return new Request(`${ORIGIN}${path}`, {
    method,
    headers: { origin: ORIGIN, ...(body !== undefined ? { "content-type": "application/json" } : {}), ...(cookie ? { cookie } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

async function register(name: string) {
  const email = `wa-${RUN}-${name}@example.test`;
  const res = await signup(api("POST", "/api/auth/signup", undefined, { email, password: PASSWORD, businessName: `Negocio ${name}` }));
  expect(res.status).toBe(201);
  const cookie = cookieOf(res);
  const info = await (await me(api("GET", "/api/me", cookie))).json();
  tenantIds.push(info.tenant.id);
  return { cookie, tenantId: info.tenant.id as string, email };
}

/** Registra un número directamente (sin pasar por Meta) para probar el webhook. */
async function giveNumber(tenantId: string, phoneId = newPhoneId()) {
  await owner.query(
    "INSERT INTO tenant_integrations (tenant_id, provider, external_id, secret_enc) VALUES ($1, 'whatsapp', $2, 'x')",
    [tenantId, phoneId],
  );
  return phoneId;
}

function waBody(phoneId: string, opts: { messages?: object[]; statuses?: object[]; contacts?: object[] }) {
  return {
    object: "whatsapp_business_account",
    entry: [{ id: "123", changes: [{ field: "messages", value: {
      messaging_product: "whatsapp",
      metadata: { display_phone_number: "58412", phone_number_id: phoneId },
      contacts: opts.contacts ?? [], messages: opts.messages, statuses: opts.statuses,
    } }] }],
  };
}
const text = (id: string, from = "584121234567", body = "hola", ts = Math.floor(Date.now() / 1000)) =>
  ({ from, id, timestamp: String(ts), type: "text", text: { body } });

function signed(body: unknown, secret = SECRET, extraHeaders: Record<string, string> = {}) {
  const raw = typeof body === "string" ? body : JSON.stringify(body);
  const sig = "sha256=" + createHmac("sha256", secret).update(raw).digest("hex");
  return new Request(`${ORIGIN}/api/webhooks/whatsapp`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-hub-signature-256": sig, ...extraHeaders },
    body: raw,
  });
}

const count = async (tenantId: string, table: string, where = "true") =>
  withTenant(tenantId, async (db) => Number((await db.query(`SELECT count(*) AS n FROM ${table} WHERE ${where}`)).rows[0].n));

afterEach(() => vi.unstubAllGlobals());

afterAll(async () => {
  await owner.query("DELETE FROM users WHERE email LIKE $1", [`wa-${RUN}-%`]);
  for (const id of tenantIds) {
    const c = await owner.connect();
    try {
      await c.query("BEGIN");
      // tenants tiene FORCE RLS: sin fijar el negocio el DELETE no borra nada (en silencio).
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

beforeAll(() => {
  expect(process.env.WHATSAPP_APP_SECRET).toBe(SECRET);
});

describe("firma X-Hub-Signature-256", () => {
  const raw = Buffer.from('{"a":1}');
  const good = "sha256=" + createHmac("sha256", SECRET).update(raw).digest("hex");
  it("acepta la firma correcta (también en mayúsculas)", () => {
    expect(verifySignature(raw, good, SECRET)).toBe(true);
    expect(verifySignature(raw, "sha256=" + good.slice(7).toUpperCase(), SECRET)).toBe(true);
  });
  it("rechaza cuerpo alterado, secreto distinto y cabeceras malformadas", () => {
    expect(verifySignature(Buffer.from('{"a":2}'), good, SECRET)).toBe(false);
    expect(verifySignature(raw, good, "otro-secreto-distinto-123")).toBe(false);
    for (const h of [null, "", "sha256=", "sha1=" + good.slice(7), "sha512=" + good.slice(7), "xxxxxxx" + good.slice(7), good.slice(7), "sha256=zz" + good.slice(9), good + "00"]) {
      expect(verifySignature(raw, h, SECRET)).toBe(false);
    }
  });
  it("readRawBody corta cuerpos que pasan el tope aunque no declaren tamaño", async () => {
    const stream = new ReadableStream({ start(c) { c.enqueue(new Uint8Array(600)); c.enqueue(new Uint8Array(600)); c.close(); } });
    const r = new Request("http://x.test/", { method: "POST", body: stream, duplex: "half" } as RequestInit);
    expect(await readRawBody(r, 1000)).toBeNull();
    const ok = new Request("http://x.test/", { method: "POST", body: "hola" });
    expect((await readRawBody(ok, 1000))?.toString()).toBe("hola");
  });
});

describe("interpretar el JSON de Meta", () => {
  it("extrae texto, nombre y estados; limpia basura", () => {
    const now = Date.now();
    const sec = Math.floor(now / 1000);
    const body = waBody("1234567", {
      contacts: [{ wa_id: "584121234567", profile: { name: "Ana\u0000 Pérez" } }],
      messages: [
        text("wamid.A", "584121234567", "hola\u0000 mundo", sec),
        { from: "584121234567", id: "wamid.B", timestamp: String(sec), type: "image", image: { caption: "foto", id: "m1" } },
        { from: "584121234567", id: "wamid.C", timestamp: String(sec), type: "interactive", interactive: { button_reply: { title: "Sí" } } },
        { from: "no-es-numero", id: "wamid.D", timestamp: String(sec), type: "text", text: { body: "x" } },
        { from: "584121234567", id: "wamid.E", timestamp: String(sec + 99999999), type: "text", text: { body: "futuro" } },
      ],
      statuses: [{ id: "wamid.S", status: "read", timestamp: String(sec) }, { id: "wamid.T", status: "raro" }],
    });
    const out = parseWebhook(body, now)!;
    expect(out).toHaveLength(1);
    const b = out[0]!;
    expect(b.messages.map((m) => m.waMessageId)).toEqual(["wamid.A", "wamid.B", "wamid.C", "wamid.E"]);
    expect(b.messages[0]).toMatchObject({ body: "hola mundo", name: "Ana Pérez", type: "text" });
    expect(b.messages[1]).toMatchObject({ type: "image", body: "foto" });
    expect(b.messages[2]!.body).toBe("Sí");
    expect(b.messages[3]!.at.getTime()).toBe(now); // fecha futura -> ahora
    expect(b.statuses).toHaveLength(1);
  });
  it("rechaza objetos que no son de WhatsApp y tolera campos extra o vacíos", () => {
    expect(parseWebhook({ object: "page", entry: [] })).toBeNull();
    expect(parseWebhook("hola")).toBeNull();
    expect(parseWebhook({ object: "whatsapp_business_account" })).toEqual([]);
    expect(parseWebhook({ object: "whatsapp_business_account", entry: [{ changes: [{ field: "otra", value: {} }] }] })).toEqual([]);
  });
  it("limita la cantidad de elementos por petición", () => {
    const many = Array.from({ length: 500 }, (_, i) => text(`wamid.${i}`));
    const out = parseWebhook(waBody("1234567", { messages: many }))!;
    expect(out[0]!.messages.length).toBeLessThanOrEqual(200);
  });
});

describe("verificación inicial (GET)", () => {
  const get = (q: string) => hookGet(new Request(`${ORIGIN}/api/webhooks/whatsapp?${q}`));
  it("devuelve el challenge solo con token correcto", async () => {
    const ok = await get(`hub.mode=subscribe&hub.verify_token=${VERIFY}&hub.challenge=1158201444`);
    expect(ok.status).toBe(200);
    expect(await ok.text()).toBe("1158201444");
    expect(ok.headers.get("content-type")).toContain("text/plain");
  });
  it("rechaza token malo, modo malo, sin token y challenge con HTML", async () => {
    expect((await get("hub.mode=subscribe&hub.verify_token=malo&hub.challenge=1")).status).toBe(403);
    expect((await get(`hub.mode=otra&hub.verify_token=${VERIFY}&hub.challenge=1`)).status).toBe(403);
    expect((await get("hub.mode=subscribe&hub.challenge=1")).status).toBe(403);
    expect((await get(`hub.mode=subscribe&hub.verify_token=${VERIFY}&hub.challenge=${encodeURIComponent("<script>alert(1)</script>")}`)).status).toBe(403);
  });
});

describe("recepción (POST)", () => {
  it("sin firma o con firma falsa no guarda nada", async () => {
    const t = await register("p1");
    const phone = await giveNumber(t.tenantId);
    const body = waBody(phone, { messages: [text("wamid.NOSIG")] });
    const noSig = await hookPost(new Request(`${ORIGIN}/api/webhooks/whatsapp`, { method: "POST", body: JSON.stringify(body) }));
    expect(noSig.status).toBe(401);
    const bad = await hookPost(signed(body, "otro-secreto-distinto-123"));
    expect(bad.status).toBe(401);
    expect(await count(t.tenantId, "messages")).toBe(0);
  });

  it("cuerpo enorme -> 413; JSON roto firmado -> 400", async () => {
    const big = "x".repeat(1_100_000);
    expect((await hookPost(signed(big))).status).toBe(413);
    expect((await hookPost(signed("{no es json"))).status).toBe(400);
  });

  it("guarda mensaje, contacto y conversación en el negocio dueño del número", async () => {
    const t = await register("p2");
    const phone = await giveNumber(t.tenantId);
    const res = await hookPost(signed(waBody(phone, {
      contacts: [{ wa_id: "584121234567", profile: { name: "Ana" } }],
      messages: [text("wamid.P2A", "584121234567", "¿Tienen cita mañana?")],
    })));
    expect(res.status).toBe(200);
    expect(await count(t.tenantId, "messages", "wa_message_id = 'wamid.P2A'")).toBe(1);
    const c = await withTenant(t.tenantId, async (db) => (await db.query("SELECT display_name FROM contacts")).rows);
    expect(c).toEqual([{ display_name: "Ana" }]);
    const m = await withTenant(t.tenantId, async (db) => (await db.query("SELECT direction, body, msg_type FROM messages")).rows[0]);
    expect(m).toEqual({ direction: "in", body: "¿Tienen cita mañana?", msg_type: "text" });
  });

  it("número desconocido: responde 200 y no guarda nada", async () => {
    const res = await hookPost(signed(waBody("55555555555", { messages: [text("wamid.NADIE")] })));
    expect(res.status).toBe(200);
    const r = await owner.query("SELECT count(*)::int AS n FROM messages WHERE wa_message_id = 'wamid.NADIE'");
    expect(r.rows[0].n).toBe(0);
  });

  it("los reintentos de Meta no duplican (10 entregas simultáneas del mismo mensaje)", async () => {
    const t = await register("p3");
    const phone = await giveNumber(t.tenantId);
    const body = waBody(phone, { messages: [text("wamid.DUP")] });
    const results = await Promise.all(Array.from({ length: 10 }, () => hookPost(signed(body))));
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(await count(t.tenantId, "messages")).toBe(1);
    expect(await count(t.tenantId, "conversations")).toBe(1);

    // Un reintento no cuenta como nuevo ni pisa el contenido original.
    const again = await ingestBatch(parseWebhook(waBody(phone, { messages: [{ ...text("wamid.DUP"), text: { body: "OTRO TEXTO" } }] }))![0]!);
    expect(again.newMessages).toBe(0);
    const stored = await withTenant(t.tenantId, async (db) => (await db.query("SELECT body FROM messages")).rows[0].body);
    expect(stored).toBe("hola");
  });

  it("mensajes distintos del mismo cliente al mismo tiempo comparten UNA conversación", async () => {
    const t = await register("p4");
    const phone = await giveNumber(t.tenantId);
    await Promise.all(Array.from({ length: 8 }, (_, i) =>
      hookPost(signed(waBody(phone, { messages: [text(`wamid.C${i}`, "584129998877", `m${i}`)] })))));
    expect(await count(t.tenantId, "messages")).toBe(8);
    expect(await count(t.tenantId, "conversations")).toBe(1);
    expect(await count(t.tenantId, "contacts")).toBe(1);
  });

  it("si la conversación estaba cerrada, el nuevo mensaje abre otra", async () => {
    const t = await register("p5");
    const phone = await giveNumber(t.tenantId);
    await hookPost(signed(waBody(phone, { messages: [text("wamid.K1")] })));
    await withTenant(t.tenantId, (db) => db.query("UPDATE conversations SET status = 'closed' WHERE tenant_id = $1", [t.tenantId]));
    await hookPost(signed(waBody(phone, { messages: [text("wamid.K2")] })));
    expect(await count(t.tenantId, "conversations")).toBe(2);
    expect(await count(t.tenantId, "conversations", "status <> 'closed'")).toBe(1);
  });

  it("aislamiento: cada negocio solo ve lo de su número", async () => {
    const a = await register("p6a");
    const b = await register("p6b");
    const pa = await giveNumber(a.tenantId);
    const pb = await giveNumber(b.tenantId);
    await hookPost(signed(waBody(pa, { messages: [text("wamid.ISO-A", "584120000001", "para A")] })));
    await hookPost(signed(waBody(pb, { messages: [text("wamid.ISO-B", "584120000002", "para B")] })));
    const bodiesA = await withTenant(a.tenantId, async (db) => (await db.query("SELECT body FROM messages")).rows.map((r) => r.body));
    const bodiesB = await withTenant(b.tenantId, async (db) => (await db.query("SELECT body FROM messages")).rows.map((r) => r.body));
    expect(bodiesA).toEqual(["para A"]);
    expect(bodiesB).toEqual(["para B"]);
  });

  it("estados de entrega: solo avanzan (sent < delivered < read) y no se pisan", async () => {
    const t = await register("p7");
    const phone = await giveNumber(t.tenantId);
    await hookPost(signed(waBody(phone, { messages: [text("wamid.IN7")] })));
    await withTenant(t.tenantId, async (db) => {
      const conv = (await db.query("SELECT id FROM conversations")).rows[0].id;
      await db.query("INSERT INTO messages (tenant_id, conversation_id, direction, wa_message_id, body) VALUES ($1, $2, 'out', 'wamid.OUT7', 'hola')", [t.tenantId, conv]);
    });
    const st = (s: string) => hookPost(signed(waBody(phone, { statuses: [{ id: "wamid.OUT7", status: s, timestamp: String(Math.floor(Date.now() / 1000)) }] })));
    const current = () => withTenant(t.tenantId, async (db) => (await db.query("SELECT delivery_status FROM messages WHERE wa_message_id = 'wamid.OUT7'")).rows[0].delivery_status);
    await st("read");
    expect(await current()).toBe("read");
    await st("delivered"); // llega tarde: no retrocede
    expect(await current()).toBe("read");
    await st("failed"); // no pisa un "read"
    expect(await current()).toBe("read");
    // Un estado no puede tocar mensajes entrantes.
    await hookPost(signed(waBody(phone, { statuses: [{ id: "wamid.IN7", status: "read" }] })));
    const inbound = await withTenant(t.tenantId, async (db) => (await db.query("SELECT delivery_status FROM messages WHERE wa_message_id = 'wamid.IN7'")).rows[0].delivery_status);
    expect(inbound).toBeNull();
  });
});

describe("conectar el número del negocio", () => {
  const graphOk = (phoneId: string) => vi.fn(async () =>
    new Response(JSON.stringify({ id: phoneId, display_phone_number: "+58 412-1234567", verified_name: "Mi Negocio" }), { status: 200 }));
  const TOKEN = "EAAG-token-de-prueba-muy-largo-123456789";

  it("valida con Meta, guarda el token CIFRADO y lo ata al negocio y al número", async () => {
    const t = await register("c1");
    const phone = newPhoneId();
    const f = graphOk(phone);
    vi.stubGlobal("fetch", f);
    const res = await connect(api("POST", "/api/whatsapp/connect", t.cookie, { phoneNumberId: phone, accessToken: TOKEN }));
    expect(res.status).toBe(201);
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`https://graph.facebook.com/v25.0/${phone}?fields=display_phone_number,verified_name`);
    expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${TOKEN}`);

    const row = await owner.query("SELECT secret_enc, key_version FROM tenant_integrations WHERE external_id = $1", [phone]);
    expect(row.rows[0].secret_enc).not.toContain(TOKEN);
    expect(decryptSecret(row.rows[0].secret_enc, `wa:${t.tenantId}:${phone}`, row.rows[0].key_version)).toBe(TOKEN);
    expect(() => decryptSecret(row.rows[0].secret_enc, `wa:${randomUUID()}:${phone}`, row.rows[0].key_version)).toThrow();

    // Y el webhook ya funciona para ese número.
    const hook = await hookPost(signed(waBody(phone, { messages: [text("wamid.CN1")] })));
    expect(hook.status).toBe(200);
    expect(await count(t.tenantId, "messages")).toBe(1);

    // Un segundo número en el mismo negocio no se permite; desconectar sí.
    vi.stubGlobal("fetch", graphOk("77777"));
    expect((await connect(api("POST", "/api/whatsapp/connect", t.cookie, { phoneNumberId: "77777", accessToken: TOKEN }))).status).toBe(409);
    expect((await disconnect(api("DELETE", "/api/whatsapp/connect", t.cookie))).status).toBe(200);
    expect((await disconnect(api("DELETE", "/api/whatsapp/connect", t.cookie))).status).toBe(404);
    await hookPost(signed(waBody(phone, { messages: [text("wamid.CN1-TARDE")] })));
    expect(await count(t.tenantId, "messages")).toBe(1);
  });

  it("si Meta rechaza el token, no se guarda nada (no se puede reservar el número de otro)", async () => {
    const t = await register("c2");
    const phone = newPhoneId();
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 400 })));
    const res = await connect(api("POST", "/api/whatsapp/connect", t.cookie, { phoneNumberId: phone, accessToken: TOKEN }));
    expect(res.status).toBe(400);
    expect((await owner.query("SELECT count(*)::int AS n FROM tenant_integrations WHERE external_id = $1", [phone])).rows[0].n).toBe(0);
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("sin red"); }));
    expect((await connect(api("POST", "/api/whatsapp/connect", t.cookie, { phoneNumberId: phone, accessToken: TOKEN }))).status).toBe(400);
    // Meta devuelve OTRO id que el pedido: tampoco vale.
    vi.stubGlobal("fetch", graphOk("99999999"));
    expect((await connect(api("POST", "/api/whatsapp/connect", t.cookie, { phoneNumberId: phone, accessToken: TOKEN }))).status).toBe(400);
  });

  it("un número ya conectado por otro negocio no se puede conectar", async () => {
    const a = await register("c3a");
    const b = await register("c3b");
    const phone = await giveNumber(a.tenantId);
    vi.stubGlobal("fetch", graphOk(phone));
    const res = await connect(api("POST", "/api/whatsapp/connect", b.cookie, { phoneNumberId: phone, accessToken: TOKEN }));
    expect(res.status).toBe(409);
  });

  it("un agente no puede conectar ni desconectar; datos inválidos -> 400; sin sesión -> 401", async () => {
    const t = await register("c4");
    await owner.query("UPDATE memberships SET role = 'agent' WHERE tenant_id = $1", [t.tenantId]);
    vi.stubGlobal("fetch", graphOk("12345"));
    expect((await connect(api("POST", "/api/whatsapp/connect", t.cookie, { phoneNumberId: "12345", accessToken: TOKEN }))).status).toBe(403);
    expect((await disconnect(api("DELETE", "/api/whatsapp/connect", t.cookie))).status).toBe(403);
    await owner.query("UPDATE memberships SET role = 'owner' WHERE tenant_id = $1", [t.tenantId]);
    expect((await connect(api("POST", "/api/whatsapp/connect", t.cookie, { phoneNumberId: "abc", accessToken: TOKEN }))).status).toBe(400);
    expect((await connect(api("POST", "/api/whatsapp/connect", t.cookie, { phoneNumberId: "12345", accessToken: "corto" }))).status).toBe(400);
    expect((await connect(api("POST", "/api/whatsapp/connect", undefined, { phoneNumberId: "12345", accessToken: TOKEN }))).status).toBe(401);
  });
});
