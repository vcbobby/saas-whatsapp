import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { POST as signup } from "@/app/api/auth/signup/route";
import { GET as listConversations } from "@/app/api/conversations/route";
import { GET as conversationDetail } from "@/app/api/conversations/messages/route";
import { POST as updateConversation } from "@/app/api/conversations/update/route";
import { POST as reply } from "@/app/api/conversations/reply/route";
import { GET as me } from "@/app/api/me/route";
import { encryptSecret } from "@/lib/crypto";
import { getPool, withTenant } from "@/lib/db";
import { closeLockClient } from "@/lib/queue/lock";
import { ingestBatch } from "@/lib/whatsapp/ingest";
import { sendText, type SendResult } from "@/lib/whatsapp/graph";
import { windowEnd } from "@/lib/conversations/reply";

vi.mock("@/lib/whatsapp/graph", async (orig) => ({ ...(await orig<typeof import("@/lib/whatsapp/graph")>()), sendText: vi.fn() }));
const sendMock = vi.mocked(sendText);
const OK: SendResult = { kind: "sent", waMessageId: "wamid.HUMANO.1" };

const RUN = randomUUID().slice(0, 8);
process.env.QUEUE_PREFIX = `test-r-${RUN}`;
const ORIGIN = new URL(process.env.APP_URL!).origin;
const PASSWORD = "contraseña-de-prueba-123";
const TOKEN = "EAAtoken-de-prueba-del-negocio-1234567890";
const owner = new Pool({ connectionString: process.env.MIGRATION_DATABASE_URL, max: 2 });
const tenantIds: string[] = [];
let seq = 0;
const newPhoneId = () => `7${RUN.replace(/\D/g, "").padEnd(4, "5").slice(0, 4)}${Date.now() % 100000}${seq++}`.slice(0, 18);
const newWaId = () => `58414${String(Date.now()).slice(-6)}${seq++}`.slice(0, 15);

function api(method: string, path: string, cookie?: string, body?: unknown) {
  return new Request(`${ORIGIN}${path}`, {
    method,
    headers: { origin: ORIGIN, ...(body !== undefined ? { "content-type": "application/json" } : {}), ...(cookie ? { cookie } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

async function register(name: string, opts: { agent?: boolean } = {}) {
  const email = `rp-${RUN}-${name}@example.test`;
  const res = await signup(api("POST", "/api/auth/signup", undefined, { email, password: PASSWORD, businessName: `Negocio ${name}` }));
  expect(res.status).toBe(201);
  const cookie = (res.headers.get("set-cookie") ?? "").split(";")[0]!;
  const info = await (await me(api("GET", "/api/me", cookie))).json();
  const tenantId = info.tenant.id as string;
  tenantIds.push(tenantId);
  const phoneId = newPhoneId();
  const { payload, keyVersion } = encryptSecret(TOKEN, `wa:${tenantId}:${phoneId}`);
  await owner.query("INSERT INTO tenant_integrations (tenant_id, provider, external_id, secret_enc, key_version) VALUES ($1,'whatsapp',$2,$3,$4)", [tenantId, phoneId, payload, keyVersion]);
  if (opts.agent) {
    await withTenant(tenantId, (db) => db.query("INSERT INTO tenant_agents (tenant_id, enabled, assistant_name, instructions) VALUES ($1, true, 'Ana', 'Abrimos de 8am a 5pm.')", [tenantId]));
  }
  return { tenantId, phoneId, cookie };
}
type T = Awaited<ReturnType<typeof register>>;

let t0 = Math.floor(Date.now() / 1000) - 3600;
/** Un cliente escribe (como lo haría el webhook). Devuelve los ids de su conversación y contacto. */
async function customer(t: T, body: string | null = "hola", opts: { name?: string; waId?: string; type?: string } = {}) {
  const waId = opts.waId ?? newWaId();
  const r = await ingestBatch({ phoneNumberId: t.phoneId, statuses: [], messages: [{ waId, name: opts.name ?? "Cliente", waMessageId: `wamid.${RUN}.${seq++}`, at: new Date(++t0 * 1000), type: opts.type ?? "text", body }] });
  const row = await withTenant(t.tenantId, async (db) =>
    (await db.query("SELECT c.id AS conv, c.contact_id AS contact FROM conversations c JOIN contacts ct ON ct.id = c.contact_id AND ct.tenant_id = c.tenant_id WHERE ct.wa_id = $1 AND c.status <> 'closed'", [waId])).rows[0],
  );
  return { waId, conv: row.conv as string, contact: row.contact as string, messageId: r.inbound[0]!.messageId };
}

beforeAll(async () => { await getPool().query("SELECT 1"); });

afterAll(async () => {
  await closeLockClient();
  await owner.query("DELETE FROM users WHERE email LIKE $1", [`rp-${RUN}-%`]);
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

const userIdOf = async (name: string) => (await owner.query("SELECT id FROM users WHERE email = $1", [`rp-${RUN}-${name}@example.test`])).rows[0].id as string;
const ownerExec = async (tenantId: string, sql: string, params: unknown[] = []) => {
  const c = await owner.connect();
  try {
    await c.query("BEGIN");
    await c.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
    const r = await c.query(sql, params);
    await c.query("COMMIT");
    return r;
  } catch (e) {
    await c.query("ROLLBACK");
    throw e;
  } finally {
    c.release();
  }
};
const take = async (t: T, conv: string) => expect((await updateConversation(api("POST", "/api/conversations/update", t.cookie, { id: conv, action: "take" }))).status).toBe(200);
const send = (t: T, conv: string, text: string, key: string = randomUUID()) => reply(api("POST", "/api/conversations/reply", t.cookie, { id: conv, clientKey: key, text }));
const outRows = (t: T, conv: string) =>
  withTenant(t.tenantId, async (db) => (await db.query("SELECT * FROM messages WHERE conversation_id = $1 AND direction = 'out' ORDER BY received_at", [conv])).rows);
/** Un negocio con una conversación ya tomada por su dueño. */
async function ready(name: string) {
  const t = await register(name);
  const c = await customer(t, "hola, ¿abren hoy?");
  await take(t, c.conv);
  sendMock.mockReset();
  sendMock.mockResolvedValue(OK);
  return { t, c };
}

describe("windowEnd (ventana de 24 horas)", () => {
  const now = Date.parse("2026-01-10T12:00:00Z");
  it("sin mensaje del cliente no hay ventana", () => expect(windowEnd(null, now)).toBeNull());
  it("dentro de las 24 h (menos el margen de 2 min) está abierta y termina a tiempo", () => {
    const last = new Date(now - 10 * 3600_000);
    expect(windowEnd(last, now)!.getTime()).toBe(last.getTime() + 24 * 3600_000 - 120_000);
  });
  it("justo antes del margen sigue abierta y pasado el margen se cierra", () => {
    expect(windowEnd(new Date(now - (24 * 3600_000 - 120_000) + 1000), now)).not.toBeNull();
    expect(windowEnd(new Date(now - (24 * 3600_000 - 120_000)), now)).toBeNull();
    expect(windowEnd(new Date(now - 30 * 3600_000), now)).toBeNull();
  });
});

describe("responder desde la bandeja: envío", () => {
  it("envía el texto al número del cliente con el token del negocio y lo guarda con quién lo escribió", async () => {
    const { t, c } = await ready("ok1");
    const res = await send(t, c.conv, "  Sí, abrimos hasta las 5pm.  ");
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, duplicate: false });
    expect(sendMock).toHaveBeenCalledTimes(1);
    expect(sendMock).toHaveBeenCalledWith(t.phoneId, TOKEN, c.waId, "Sí, abrimos hasta las 5pm.");
    const rows = await outRows(t, c.conv);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ body: "Sí, abrimos hasta las 5pm.", send_state: "sent", wa_message_id: "wamid.HUMANO.1", sent_by: await userIdOf("ok1"), reply_to: null, msg_type: "text" });
    const conv = await withTenant(t.tenantId, async (db) => (await db.query("SELECT status, last_message_at FROM conversations WHERE id = $1", [c.conv])).rows[0]);
    expect(conv.status).toBe("human");
    expect(Date.now() - new Date(conv.last_message_at).getTime()).toBeLessThan(10_000);
  });

  it("el detalle lo muestra como «me» y con el plazo de respuesta; otro miembro lo ve como «team»", async () => {
    const { t, c } = await ready("ok2");
    await send(t, c.conv, "Hola");
    const d = await (await conversationDetail(api("GET", `/api/conversations/messages?id=${c.conv}`, t.cookie))).json();
    expect(d.messages.map((m: { sender: string }) => m.sender)).toEqual(["customer", "me"]);
    expect(new Date(d.conversation.replyUntil).getTime()).toBeGreaterThan(Date.now());
    // Otro usuario del negocio (simulado cambiando el autor del mensaje)
    await ownerExec(t.tenantId, "UPDATE messages SET sent_by = gen_random_uuid() WHERE conversation_id = $1 AND direction = 'out'", [c.conv]);
    const d2 = await (await conversationDetail(api("GET", `/api/conversations/messages?id=${c.conv}`, t.cookie))).json();
    expect(d2.messages[1].sender).toBe("team");
    // Un mensaje del asistente (sin autor) se ve como «assistant»
    await ownerExec(t.tenantId, "UPDATE messages SET sent_by = NULL WHERE conversation_id = $1 AND direction = 'out'", [c.conv]);
    const d3 = await (await conversationDetail(api("GET", `/api/conversations/messages?id=${c.conv}`, t.cookie))).json();
    expect(d3.messages[1].sender).toBe("assistant");
  });

  it("la lista indica si el último mensaje lo escribió una persona", async () => {
    const { t, c } = await ready("ok3");
    await send(t, c.conv, "Listo");
    const l = await (await listConversations(api("GET", "/api/conversations", t.cookie))).json();
    expect(l.conversations[0]).toMatchObject({ lastDirection: "out", lastByPerson: true, lastPreview: "Listo" });
  });

  it("DOBLE CLIC: el mismo intento (misma clave) nunca envía dos veces", async () => {
    const { t, c } = await ready("dup1");
    const key = randomUUID();
    const a = await send(t, c.conv, "Hola", key);
    const b = await send(t, c.conv, "Hola", key);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(await b.json()).toMatchObject({ ok: true, duplicate: true });
    expect(sendMock).toHaveBeenCalledTimes(1);
    expect(await outRows(t, c.conv)).toHaveLength(1);
  });

  it("DOS PETICIONES A LA VEZ con la misma clave: solo una sale hacia WhatsApp", async () => {
    const { t, c } = await ready("dup2");
    sendMock.mockImplementation(async () => { await new Promise((r) => setTimeout(r, 150)); return OK; });
    const key = randomUUID();
    const rs = await Promise.all([send(t, c.conv, "Hola", key), send(t, c.conv, "Hola", key), send(t, c.conv, "Hola", key)]);
    expect(sendMock).toHaveBeenCalledTimes(1);
    expect(await outRows(t, c.conv)).toHaveLength(1);
    for (const r of rs) expect([200, 409]).toContain(r.status);
  });

  it("mensajes distintos (claves distintas) se envían los dos", async () => {
    const { t, c } = await ready("dup3");
    await send(t, c.conv, "Uno");
    await send(t, c.conv, "Uno");
    expect(sendMock).toHaveBeenCalledTimes(2);
  });

  it("la misma clave en OTRA conversación se rechaza", async () => {
    const { t, c } = await ready("dup4");
    const c2 = await customer(t, "hola");
    await take(t, c2.conv);
    const key = randomUUID();
    await send(t, c.conv, "Hola", key);
    const r = await send(t, c2.conv, "Hola", key);
    expect(r.status).toBe(409);
    expect((await r.json()).error).toBe("clave_en_uso");
    expect(sendMock).toHaveBeenCalledTimes(1);
  });
});

describe("responder desde la bandeja: reglas", () => {
  it("si la conversación está con el asistente, no se puede responder", async () => {
    const t = await register("rule1");
    const c = await customer(t);
    const r = await send(t, c.conv, "Hola");
    expect(r.status).toBe(409);
    expect((await r.json()).error).toBe("no_tomada");
    expect(sendMock).not.toHaveBeenCalled();
    expect(await outRows(t, c.conv)).toHaveLength(0);
  });

  it("pasada a una persona por el asistente (sin responsable) también exige tomarla", async () => {
    const t = await register("rule2");
    const c = await customer(t);
    await withTenant(t.tenantId, (db) => db.query("UPDATE conversations SET status = 'human', handoff_reason = 'pedido_de_persona' WHERE id = $1", [c.conv]));
    expect((await send(t, c.conv, "Hola")).status).toBe(409);
    await take(t, c.conv);
    sendMock.mockResolvedValue(OK);
    expect((await send(t, c.conv, "Hola")).status).toBe(200);
  });

  it("si la tiene otra persona del equipo, no se puede responder hasta tomarla", async () => {
    const { t, c } = await ready("rule3");
    await withTenant(t.tenantId, (db) => db.query("UPDATE conversations SET assigned_to = gen_random_uuid() WHERE id = $1", [c.conv]));
    const r = await send(t, c.conv, "Hola");
    expect((await r.json()).error).toBe("no_tomada");
    expect(sendMock).not.toHaveBeenCalled();
  });

  it("devolver la conversación al asistente impide seguir respondiendo", async () => {
    const { t, c } = await ready("rule4");
    await updateConversation(api("POST", "/api/conversations/update", t.cookie, { id: c.conv, action: "release" }));
    expect((await send(t, c.conv, "Hola")).status).toBe(409);
    expect(sendMock).not.toHaveBeenCalled();
  });

  it("una conversación cerrada no admite respuestas", async () => {
    const { t, c } = await ready("rule5");
    await updateConversation(api("POST", "/api/conversations/update", t.cookie, { id: c.conv, action: "close" }));
    const r = await send(t, c.conv, "Hola");
    expect(r.status).toBe(409);
    expect((await r.json()).error).toBe("conversacion_cerrada");
  });

  it("VENTANA DE 24 H: con el último mensaje del cliente de hace 25 h no se envía nada", async () => {
    const { t, c } = await ready("win1");
    await ownerExec(t.tenantId, "UPDATE messages SET created_at = now() - interval '25 hours' WHERE conversation_id = $1 AND direction = 'in'", [c.conv]);
    const r = await send(t, c.conv, "Hola");
    expect(r.status).toBe(409);
    expect((await r.json()).error).toBe("ventana_cerrada");
    expect(sendMock).not.toHaveBeenCalled();
    expect(await outRows(t, c.conv)).toHaveLength(0);
    const d = await (await conversationDetail(api("GET", `/api/conversations/messages?id=${c.conv}`, t.cookie))).json();
    expect(d.conversation.replyUntil).toBeNull();
  });

  it("de hace 23 h sí se puede; de hace 23 h 59 min ya no (margen de seguridad)", async () => {
    const { t, c } = await ready("win2");
    await ownerExec(t.tenantId, "UPDATE messages SET created_at = now() - interval '23 hours' WHERE conversation_id = $1 AND direction = 'in'", [c.conv]);
    expect((await send(t, c.conv, "Hola")).status).toBe(200);
    await ownerExec(t.tenantId, "UPDATE messages SET created_at = now() - interval '23 hours 59 minutes' WHERE conversation_id = $1 AND direction = 'in'", [c.conv]);
    expect((await send(t, c.conv, "Otra")).status).toBe(409);
  });

  it("responder NO renueva la ventana: solo cuenta lo que escribe el cliente", async () => {
    const { t, c } = await ready("win3");
    await send(t, c.conv, "Hola");
    await ownerExec(t.tenantId, "UPDATE messages SET created_at = now() - interval '30 hours' WHERE conversation_id = $1 AND direction = 'in'", [c.conv]);
    expect((await send(t, c.conv, "Sigo aquí")).status).toBe(409);
  });

  it("un negocio con la prueba vencida no puede responder", async () => {
    const { t, c } = await ready("rule6");
    await ownerExec(t.tenantId, "UPDATE tenants SET trial_ends_at = now() - interval '1 day' WHERE id = $1", [t.tenantId]);
    const r = await send(t, c.conv, "Hola");
    expect(r.status).toBe(403);
    expect((await r.json()).error).toBe("negocio_inactivo");
    expect(sendMock).not.toHaveBeenCalled();
  });

  it("sin WhatsApp conectado se explica y no se crea nada", async () => {
    const { t, c } = await ready("rule7");
    await ownerExec(t.tenantId, "DELETE FROM tenant_integrations WHERE tenant_id = $1", [t.tenantId]);
    const r = await send(t, c.conv, "Hola");
    expect((await r.json()).error).toBe("sin_whatsapp");
    expect(await outRows(t, c.conv)).toHaveLength(0);
  });

  it("otro negocio no puede responder en esta conversación (404) ni se envía nada", async () => {
    const { c } = await ready("iso1");
    const other = await register("iso2");
    const r = await send(other, c.conv, "Hola");
    expect(r.status).toBe(404);
    expect(sendMock).not.toHaveBeenCalled();
  });

  it("validación: sin sesión 401, origen ajeno 403, texto vacío/espacios/demasiado largo o ids inválidos 400", async () => {
    const { t, c } = await ready("val1");
    expect((await reply(api("POST", "/api/conversations/reply", undefined, { id: c.conv, clientKey: randomUUID(), text: "x" }))).status).toBe(401);
    const bad = new Request(`${ORIGIN}/api/conversations/reply`, { method: "POST", headers: { origin: "https://malo.example", "content-type": "application/json", cookie: t.cookie }, body: JSON.stringify({ id: c.conv, clientKey: randomUUID(), text: "x" }) });
    expect((await reply(bad)).status).toBe(403);
    expect((await send(t, c.conv, "")).status).toBe(400);
    expect((await send(t, c.conv, "   \n  ")).status).toBe(400);
    expect((await send(t, c.conv, "a".repeat(4001))).status).toBe(400);
    expect((await send(t, c.conv, "a".repeat(4000))).status).toBe(200);
    expect((await reply(api("POST", "/api/conversations/reply", t.cookie, { id: "no-uuid", clientKey: randomUUID(), text: "x" }))).status).toBe(400);
    expect((await reply(api("POST", "/api/conversations/reply", t.cookie, { id: c.conv, clientKey: "no-uuid", text: "x" }))).status).toBe(400);
    expect(sendMock).toHaveBeenCalledTimes(1);
  });

  it("los mensajes de una persona no cuentan para los límites del asistente (no llevan reply_to)", async () => {
    const { t, c } = await ready("cap1");
    await send(t, c.conv, "Hola");
    const n = await withTenant(t.tenantId, async (db) => (await db.query("SELECT count(*)::int AS n FROM messages WHERE direction = 'out' AND reply_to IS NOT NULL")).rows[0].n);
    expect(n).toBe(0);
  });
});

describe("responder desde la bandeja: fallos de WhatsApp", () => {
  it("rechazo por ventana (131047): queda como fallido, explica las 24 h y no se duplica al repetir la clave", async () => {
    const { t, c } = await ready("fail1");
    sendMock.mockResolvedValue({ kind: "rejected", status: 400, code: 131047, message: "Re-engagement message" });
    const key = randomUUID();
    const r = await send(t, c.conv, "Hola", key);
    expect(r.status).toBe(502);
    const body = await r.json();
    expect(body.error).toBe("envio_fallido");
    expect(body.message).toContain("24 horas");
    const rows = await outRows(t, c.conv);
    expect(rows[0]).toMatchObject({ send_state: "failed" });
    expect(rows[0].send_error).toContain("131047");
    const again = await send(t, c.conv, "Hola", key);
    expect(again.status).toBe(502);
    expect(sendMock).toHaveBeenCalledTimes(1);
  });

  it("otro rechazo (token vencido): fallido con el código; el texto del error de Meta no se muestra al usuario", async () => {
    const { t, c } = await ready("fail2");
    sendMock.mockResolvedValue({ kind: "rejected", status: 401, code: 190, message: "Error validating access token SECRETO" });
    const r = await send(t, c.conv, "Hola");
    const body = await r.json();
    expect(body.message).toContain("190");
    expect(JSON.stringify(body)).not.toContain("SECRETO");
  });

  it("sin conexión con Meta (retry): fallido, no se envió, y un NUEVO intento (clave nueva) funciona", async () => {
    const { t, c } = await ready("fail3");
    sendMock.mockResolvedValueOnce({ kind: "retry", reason: "ENOTFOUND" });
    const r = await send(t, c.conv, "Hola");
    expect(r.status).toBe(502);
    expect((await outRows(t, c.conv))[0].send_state).toBe("failed");
    const r2 = await send(t, c.conv, "Hola");
    expect(r2.status).toBe(200);
    expect(sendMock).toHaveBeenCalledTimes(2);
  });

  it("resultado incierto (tiempo agotado): queda «unknown», avisa y repetir la misma clave NO reenvía", async () => {
    const { t, c } = await ready("fail4");
    sendMock.mockResolvedValue({ kind: "unknown", reason: "tiempo agotado" });
    const key = randomUUID();
    const r = await send(t, c.conv, "Hola", key);
    expect(r.status).toBe(502);
    expect((await r.json()).error).toBe("envio_incierto");
    expect((await outRows(t, c.conv))[0].send_state).toBe("unknown");
    const again = await send(t, c.conv, "Hola", key);
    expect((await again.json()).error).toBe("envio_incierto");
    expect(sendMock).toHaveBeenCalledTimes(1);
    const d = await (await conversationDetail(api("GET", `/api/conversations/messages?id=${c.conv}`, t.cookie))).json();
    expect(d.messages[1].sendState).toBe("unknown");
  });

  it("si el envío lanza una excepción, no queda «sending» para siempre", async () => {
    const { t, c } = await ready("fail5");
    sendMock.mockRejectedValue(new Error("boom"));
    const r = await send(t, c.conv, "Hola");
    expect(r.status).toBe(502);
    expect((await outRows(t, c.conv))[0].send_state).toBe("failed");
  });

  it("un envío interrumpido (fila «sending» vieja) se marca como incierto y no se reenvía", async () => {
    const { t, c } = await ready("fail6");
    const key = randomUUID();
    const uid = await userIdOf("fail6");
    await ownerExec(t.tenantId, "INSERT INTO messages (tenant_id, conversation_id, direction, msg_type, body, send_state, sent_by, client_key, received_at) VALUES ($1,$2,'out','text','Hola','sending',$3,$4, now() - interval '5 minutes')", [t.tenantId, c.conv, uid, key]);
    const d = await (await conversationDetail(api("GET", `/api/conversations/messages?id=${c.conv}`, t.cookie))).json();
    expect(d.messages.find((m: { direction: string }) => m.direction === "out").sendState).toBe("unknown");
    const r = await send(t, c.conv, "Hola", key);
    expect((await r.json()).error).toBe("envio_incierto");
    expect((await outRows(t, c.conv))[0].send_state).toBe("unknown");
    expect(sendMock).not.toHaveBeenCalled();
  });

  it("un envío en curso (fila «sending» reciente) responde «en curso» sin reenviar", async () => {
    const { t, c } = await ready("fail7");
    const key = randomUUID();
    const uid = await userIdOf("fail7");
    await ownerExec(t.tenantId, "INSERT INTO messages (tenant_id, conversation_id, direction, msg_type, body, send_state, sent_by, client_key) VALUES ($1,$2,'out','text','Hola','sending',$3,$4)", [t.tenantId, c.conv, uid, key]);
    const r = await send(t, c.conv, "Hola", key);
    expect(r.status).toBe(409);
    expect((await r.json()).error).toBe("envio_en_curso");
    expect(sendMock).not.toHaveBeenCalled();
  });
});

describe("base de datos: restricciones de la migración 0011", () => {
  it("un mensaje entrante no puede tener autor ni clave de envío", async () => {
    const t = await register("db1");
    const c = await customer(t);
    const e1 = await ownerExec(t.tenantId, "UPDATE messages SET sent_by = gen_random_uuid() WHERE conversation_id = $1 AND direction = 'in'", [c.conv]).catch((e) => e as { code?: string });
    expect((e1 as { code?: string }).code).toBe("23514");
    const e2 = await ownerExec(t.tenantId, "UPDATE messages SET client_key = gen_random_uuid() WHERE conversation_id = $1 AND direction = 'in'", [c.conv]).catch((e) => e as { code?: string });
    expect((e2 as { code?: string }).code).toBe("23514");
  });

  it("la misma clave no se puede repetir dentro del negocio, pero sí entre negocios distintos", async () => {
    const a = await register("db2");
    const b = await register("db3");
    const ca = await customer(a);
    const cb = await customer(b);
    const key = randomUUID();
    const ins = (t: T, conv: string, k: string) => withTenant(t.tenantId, (db) => db.query("INSERT INTO messages (tenant_id, conversation_id, direction, body, client_key) VALUES ($1,$2,'out','x',$3)", [t.tenantId, conv, k]));
    await ins(a, ca.conv, key);
    const e = await ins(a, ca.conv, key).catch((x) => x as { code?: string });
    expect((e as { code?: string }).code).toBe("23505");
    await ins(b, cb.conv, key);
  });
});
