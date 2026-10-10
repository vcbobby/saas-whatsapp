import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { POST as signup } from "@/app/api/auth/signup/route";
import { GET as me } from "@/app/api/me/route";
import { PUT as saveAgent } from "@/app/api/agent/route";
import { runAgent } from "@/lib/agent/run";
import { LlmError, type LlmProvider } from "@/lib/ai/provider";
import { encryptSecret } from "@/lib/crypto";
import { getPool, withTenant } from "@/lib/db";
import { can } from "@/lib/auth/permissions";
import { markInboundFailed } from "@/lib/queue/process";
import { LockBusyError } from "@/lib/queue/lock";
import { closeLockClient } from "@/lib/queue/lock";
import { ingestBatch } from "@/lib/whatsapp/ingest";
import type { SendResult } from "@/lib/whatsapp/graph";

process.env.WHATSAPP_APP_SECRET = "secreto-de-prueba-de-la-app-meta";
process.env.WHATSAPP_VERIFY_TOKEN = "token-de-verificacion-de-prueba-123456";
const RUN = randomUUID().slice(0, 8);
process.env.QUEUE_PREFIX = `test-a-${RUN}`;
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
  const email = `ag-${RUN}-${name}@example.test`;
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

const outRows = (t: T) => withTenant(t.tenantId, async (db) => (await db.query("SELECT * FROM messages WHERE direction = 'out' ORDER BY created_at")).rows);
const convOf = (t: T) => withTenant(t.tenantId, async (db) => (await db.query("SELECT status, handoff_reason FROM conversations")).rows[0] as { status: string; handoff_reason: string | null });
const setConv = (t: T, status: string) => withTenant(t.tenantId, (db) => db.query("UPDATE conversations SET status = $1", [status]));

beforeAll(async () => { await getPool().query("SELECT 1"); });
afterEach(() => { vi.unstubAllEnvs(); });

afterAll(async () => {
  await closeLockClient();
  await owner.query("DELETE FROM users WHERE email LIKE $1", [`ag-${RUN}-%`]);
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

describe("responder", () => {
  it("genera la respuesta, la envía con el token descifrado y deja todo registrado", async () => {
    const t = await register("ok");
    const wa = newWaId();
    const m = await inbound(t, wa, "¿A qué hora abren?");
    const d = deps({ result: sent("wamid.respuesta1") });
    expect(await runAgent(job(t, m), d.raw)).toBe("replied");

    expect(d.send).toHaveBeenCalledTimes(1);
    expect(d.send).toHaveBeenCalledWith(t.phoneId, TOKEN, wa, "Hola, abrimos de 8am a 5pm.");
    const rows = await outRows(t);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ reply_to: m, send_state: "sent", wa_message_id: "wamid.respuesta1", body: "Hola, abrimos de 8am a 5pm." });
    const usage = await withTenant(t.tenantId, async (db) => (await db.query("SELECT replies, input_tokens, output_tokens FROM agent_usage_daily")).rows[0]);
    expect(usage).toMatchObject({ replies: 1, input_tokens: "10", output_tokens: "5" });

    // El modelo recibe las reglas, la información del negocio y el mensaje encerrado.
    const call = d.llm.generate.mock.calls[0]![0] as { system: string; messages: { role: string; content: string }[] };
    expect(call.system).toContain("Abrimos de 8am a 5pm");
    expect(call.system).toContain('"Negocio ok"');
    expect(call.messages).toEqual([{ role: "user", content: "<cliente>¿A qué hora abren?</cliente>" }]);
  });

  it("un reintento del mismo mensaje no vuelve a enviar nada", async () => {
    const t = await register("replay");
    const m = await inbound(t, newWaId(), "hola");
    const d = deps();
    expect(await runAgent(job(t, m), d.raw)).toBe("replied");
    expect(await runAgent(job(t, m), d.raw)).toBe("already_replied");
    expect(d.send).toHaveBeenCalledTimes(1);
    expect(d.llm.generate).toHaveBeenCalledTimes(1);
    expect(await outRows(t)).toHaveLength(1);
  });

  it("el historial lleva los mensajes anteriores y solo las respuestas realmente enviadas", async () => {
    const t = await register("hist");
    const wa = newWaId();
    const m1 = await inbound(t, wa, "primero");
    await runAgent(job(t, m1), deps({ text: "respuesta uno" }).raw);
    const m2 = await inbound(t, wa, "segundo");
    const d = deps({ text: "respuesta dos" });
    await runAgent(job(t, m2), d.raw);
    const msgs = (d.llm.generate.mock.calls[0]![0] as { messages: { role: string; content: string }[] }).messages;
    expect(msgs.map((x) => x.content)).toEqual(["<cliente>primero</cliente>", "respuesta uno", "<cliente>segundo</cliente>"]);
  });
});

describe("historial", () => {
  it("no incluye respuestas que nunca llegaron al cliente (failed, unknown, sending)", async () => {
    const t = await register("hist2");
    const wa = newWaId();
    const m1 = await inbound(t, wa, "primero");
    await withTenant(t.tenantId, async (db) => {
      const c = await db.query("SELECT id FROM conversations");
      for (const st of ["failed", "unknown", "sending"]) {
        // reply_to distinto para cada una (el índice único exige uno por mensaje)
        await db.query("INSERT INTO messages (tenant_id, conversation_id, direction, msg_type, body, reply_to, send_state) VALUES ($1,$2,'out','text',$3,$4,$5)", [t.tenantId, c.rows[0].id, `NO-ENVIADA-${st}`, randomUUID(), st]);
      }
    });
    const m2 = await inbound(t, wa, "segundo");
    const d = deps();
    await runAgent(job(t, m2), d.raw);
    const msgs = (d.llm.generate.mock.calls[0]![0] as { messages: { content: string }[] }).messages;
    expect(JSON.stringify(msgs)).not.toContain("NO-ENVIADA");
    expect(msgs.map((x) => x.content)).toEqual(["<cliente>primero</cliente>", "<cliente>segundo</cliente>"]);
    void m1;
  });
});

describe("cuándo NO responde", () => {
  it("asistente apagado, sin configurar, o negocio suspendido", async () => {
    const off = await register("off", { agent: false });
    const m = await inbound(off, newWaId(), "hola");
    const d = deps();
    expect(await runAgent(job(off, m), d.raw)).toBe("skipped_disabled");
    await withTenant(off.tenantId, (db) => db.query("INSERT INTO tenant_agents (tenant_id, enabled) VALUES ($1, false)", [off.tenantId]));
    expect(await runAgent(job(off, m), d.raw)).toBe("skipped_disabled");

    const sus = await register("sus");
    const m2 = await inbound(sus, newWaId(), "hola");
    for (const [status, trial] of [["suspended", null], ["past_due", null], ["trial", "2020-01-01"]] as const) {
      const c = await owner.connect();
      try {
        await c.query("BEGIN");
        await c.query("SELECT set_config('app.tenant_id', $1, true)", [sus.tenantId]);
        await c.query("UPDATE tenants SET status = $2, trial_ends_at = $3 WHERE id = $1", [sus.tenantId, status, trial]);
        await c.query("COMMIT");
      } finally { c.release(); }
      expect(await runAgent(job(sus, m2), d.raw)).toBe("skipped_inactive_tenant");
    }
    expect(d.send).not.toHaveBeenCalled();
    expect(d.llm.generate).not.toHaveBeenCalled();
  });

  it("conversación en manos de una persona, reacciones y negocio sin WhatsApp", async () => {
    const t = await register("human");
    const m = await inbound(t, newWaId(), "hola");
    await setConv(t, "human");
    const d = deps();
    expect(await runAgent(job(t, m), d.raw)).toBe("skipped_human");
    expect(d.llm.generate).not.toHaveBeenCalled(); // ni siquiera se gasta IA
    await setConv(t, "bot");
    const react = await inbound(t, newWaId(), "👍", "reaction");
    expect(await runAgent(job(t, react), d.raw)).toBe("skipped_ignored_type");
    expect(d.send).not.toHaveBeenCalled();

    const nowa = await register("nowa");
    const m2 = await inbound(nowa, newWaId(), "hola");
    await owner.query("DELETE FROM tenant_integrations WHERE tenant_id = $1", [nowa.tenantId]);
    expect(await runAgent(job(nowa, m2), d.raw)).toBe("skipped_no_whatsapp");
  });

  it("un trabajo falso (negocio A con mensaje de B) no hace nada", async () => {
    const a = await register("fa");
    const b = await register("fb");
    const m = await inbound(b, newWaId(), "hola");
    const d = deps();
    expect(await runAgent({ tenantId: a.tenantId, messageId: m }, d.raw)).toBe("skipped_not_found");
    expect(d.send).not.toHaveBeenCalled();
  });

  it("si el cliente escribió varios mensajes seguidos, solo el último responde, con todo el contexto", async () => {
    const t = await register("burst");
    const wa = newWaId();
    const m1 = await inbound(t, wa, "hola");
    const m2 = await inbound(t, wa, "quería saber el precio");
    const d = deps();
    expect(await runAgent(job(t, m1), d.raw)).toBe("skipped_superseded");
    expect(d.send).not.toHaveBeenCalled();
    expect(await runAgent(job(t, m2), d.raw)).toBe("replied");
    const msgs = (d.llm.generate.mock.calls[0]![0] as { messages: { content: string }[] }).messages;
    // El proveedor junta turnos seguidos del mismo rol (ver normalizeTurns); aquí llegan los dos.
    expect(msgs.map((x) => x.content)).toEqual(["<cliente>hola</cliente>", "<cliente>quería saber el precio</cliente>"]);
    expect(d.send).toHaveBeenCalledTimes(1);
  });

  it("una reacción posterior no cuenta como mensaje más reciente", async () => {
    const t = await register("react-after");
    const wa = newWaId();
    const m1 = await inbound(t, wa, "hola");
    await inbound(t, wa, "👍", "reaction");
    expect(await runAgent(job(t, m1), deps().raw)).toBe("replied");
  });
});

describe("pasar a una persona", () => {
  it("si el cliente la pide: sin gastar IA, mensaje fijo y la conversación pasa a humano", async () => {
    const t = await register("pide");
    const m = await inbound(t, newWaId(), "quiero hablar con una persona");
    const d = deps();
    expect(await runAgent(job(t, m), d.raw)).toBe("handoff");
    expect(d.llm.generate).not.toHaveBeenCalled();
    expect(d.send.mock.calls[0]![3]).toContain("te comunico con una persona");
    expect(await convOf(t)).toEqual({ status: "human", handoff_reason: "pedido_de_persona" });
  });

  it("si el modelo lo pide con la señal: se envía el texto SIN la señal", async () => {
    const t = await register("senal");
    const m = await inbound(t, newWaId(), "esto me parece una estafa");
    const d = deps({ text: "[[HUMANO]] Lamento eso, te paso con alguien del equipo." });
    expect(await runAgent(job(t, m), d.raw)).toBe("handoff");
    expect(d.send.mock.calls[0]![3]).toBe("Lamento eso, te paso con alguien del equipo.");
    expect((await convOf(t)).status).toBe("human");
  });

  it("respuesta vacía del modelo → mensaje de respaldo y a una persona; no de texto → aviso fijo sin IA", async () => {
    const t = await register("vacio");
    const m = await inbound(t, newWaId(), "hola");
    const d = deps({ text: "   " });
    expect(await runAgent(job(t, m), d.raw)).toBe("handoff");
    expect(d.send.mock.calls[0]![3]).toContain("no pude procesar");

    const t2 = await register("imagen");
    const m2 = await inbound(t2, newWaId(), null, "image");
    const d2 = deps();
    expect(await runAgent(job(t2, m2), d2.raw)).toBe("replied");
    expect(d2.llm.generate).not.toHaveBeenCalled();
    expect(d2.send.mock.calls[0]![3]).toContain("solo puedo leer mensajes de texto");
  });

  it("tope diario: no responde más y pasa a una persona", async () => {
    vi.stubEnv("AGENT_DAILY_REPLY_LIMIT", "1");
    const t = await register("tope");
    const wa = newWaId();
    const d = deps();
    expect(await runAgent(job(t, await inbound(t, wa, "uno")), d.raw)).toBe("replied");
    expect(await runAgent(job(t, await inbound(t, wa, "dos")), d.raw)).toBe("limit_reached");
    expect(d.send).toHaveBeenCalledTimes(1);
    expect(await convOf(t)).toEqual({ status: "human", handoff_reason: "limite_diario" });
  });

  it("si una persona toma la conversación mientras la IA piensa, no se envía nada", async () => {
    const t = await register("toma");
    const m = await inbound(t, newWaId(), "hola");
    const d = deps();
    d.llm.generate.mockImplementationOnce(async () => {
      await setConv(t, "human");
      return { text: "tarde", inputTokens: 0, outputTokens: 0, model: "x" };
    });
    expect(await runAgent(job(t, m), d.raw)).toBe("skipped_human");
    expect(d.send).not.toHaveBeenCalled();
    expect(await outRows(t)).toHaveLength(0);
  });

  it("cuando BullMQ agota los reintentos la conversación pasa a una persona", async () => {
    const t = await register("fallo");
    const m = await inbound(t, newWaId(), "hola");
    await markInboundFailed(job(t, m));
    expect(await convOf(t)).toEqual({ status: "human", handoff_reason: "agente_fallo" });
  });
});

describe("envío seguro (nunca se duplica un mensaje al cliente)", () => {
  it("rechazado por Meta → failed y a una persona", async () => {
    const t = await register("rech");
    const m = await inbound(t, newWaId(), "hola");
    const d = deps({ result: { kind: "rejected", status: 401, code: 190, message: "Token vencido" } });
    expect(await runAgent(job(t, m), d.raw)).toBe("send_failed");
    expect((await outRows(t))[0]).toMatchObject({ send_state: "failed", send_error: "190: Token vencido" });
    expect(await convOf(t)).toEqual({ status: "human", handoff_reason: "envio_rechazado" });
    // Un reintento no vuelve a intentar enviar.
    expect(await runAgent(job(t, m), d.raw)).toBe("send_failed");
    expect(d.send).toHaveBeenCalledTimes(1);
  });

  it("resultado incierto → unknown y a una persona; el reintento NO reenvía", async () => {
    const t = await register("inc");
    const m = await inbound(t, newWaId(), "hola");
    const d = deps({ result: { kind: "unknown", reason: "tiempo agotado" } });
    expect(await runAgent(job(t, m), d.raw)).toBe("send_unknown");
    expect((await outRows(t))[0]).toMatchObject({ send_state: "unknown" });
    expect(await convOf(t)).toEqual({ status: "human", handoff_reason: "envio_incierto" });
    expect(await runAgent(job(t, m), d.raw)).toBe("send_unknown");
    expect(d.send).toHaveBeenCalledTimes(1);
  });

  it("no llegó a Meta (retry) → no queda fila, lanza error, y el reintento sí envía", async () => {
    const t = await register("retry");
    const m = await inbound(t, newWaId(), "hola");
    const d = deps({ result: { kind: "retry", reason: "ENOTFOUND" } });
    await expect(runAgent(job(t, m), d.raw)).rejects.toThrow(/reintentará/);
    expect(await outRows(t)).toHaveLength(0);
    expect((await convOf(t)).status).toBe("bot");
    d.send.mockResolvedValueOnce(sent("wamid.ok"));
    expect(await runAgent(job(t, m), d.raw)).toBe("replied");
    expect(d.send).toHaveBeenCalledTimes(2);
    expect(await outRows(t)).toHaveLength(1);
  });

  it("si un intento anterior murió a mitad del envío, no se reenvía a ciegas", async () => {
    const t = await register("murio");
    const m = await inbound(t, newWaId(), "hola");
    await withTenant(t.tenantId, async (db) => {
      const c = await db.query("SELECT id FROM conversations");
      await db.query("INSERT INTO messages (tenant_id, conversation_id, direction, msg_type, body, reply_to, send_state) VALUES ($1,$2,'out','text','x',$3,'sending')", [t.tenantId, c.rows[0].id, m]);
    });
    const d = deps();
    expect(await runAgent(job(t, m), d.raw)).toBe("send_unknown");
    expect(d.send).not.toHaveBeenCalled();
    expect((await outRows(t))[0].send_state).toBe("unknown");
    expect(await convOf(t)).toEqual({ status: "human", handoff_reason: "envio_incierto" });
  });

  it("dos respuestas simultáneas al mismo mensaje: el índice único deja pasar solo una", async () => {
    const t = await register("carrera");
    const m = await inbound(t, newWaId(), "hola");
    await withTenant(t.tenantId, async (db) => {
      const c = await db.query("SELECT id FROM conversations");
      await db.query("INSERT INTO messages (tenant_id, conversation_id, direction, msg_type, body, reply_to, send_state) VALUES ($1,$2,'out','text','a',$3,'sent')", [t.tenantId, c.rows[0].id, m]);
      await expect(db.query("INSERT INTO messages (tenant_id, conversation_id, direction, msg_type, body, reply_to, send_state) VALUES ($1,$2,'out','text','b',$3,'sending')", [t.tenantId, c.rows[0].id, m])).rejects.toMatchObject({ code: "23505" });
    }).catch((e) => { if ((e as { code?: string }).code !== "23505") throw e; });
  });

  it("errores de la IA se propagan (BullMQ reintenta) y no dejan nada a medias", async () => {
    const t = await register("llmerr");
    const m = await inbound(t, newWaId(), "hola");
    const d = deps();
    d.llm.generate.mockRejectedValueOnce(new LlmError("límite de uso", true, 429));
    await expect(runAgent(job(t, m), d.raw)).rejects.toBeInstanceOf(LlmError);
    expect(d.send).not.toHaveBeenCalled();
    expect(await outRows(t)).toHaveLength(0);
  });

  it("una conversación a la vez: un segundo trabajo simultáneo espera (candado)", async () => {
    const t = await register("lock");
    const wa = newWaId();
    const m1 = await inbound(t, wa, "hola");
    const d = deps({ delay: 400 });
    const first = runAgent(job(t, m1), d.raw);
    await new Promise((r) => setTimeout(r, 100));
    await expect(runAgent(job(t, m1), d.raw)).rejects.toBeInstanceOf(LockBusyError);
    expect(await first).toBe("replied");
    expect(d.send).toHaveBeenCalledTimes(1);
  });
});

describe("API /api/agent", () => {
  const body = { enabled: true, assistantName: "Sofía", instructions: "Atendemos de lunes a viernes.\u0007" };

  it("guarda la configuración (sin caracteres de control) y audita sin guardar el contenido", async () => {
    const t = await register("api", { agent: false });
    const res = await saveAgent(api("PUT", "/api/agent", t.cookie, body));
    expect(res.status).toBe(200);
    const row = await withTenant(t.tenantId, async (db) => (await db.query("SELECT * FROM tenant_agents")).rows[0]);
    expect(row).toMatchObject({ enabled: true, assistant_name: "Sofía", instructions: "Atendemos de lunes a viernes." });
    const audit = await withTenant(t.tenantId, async (db) => (await db.query("SELECT metadata FROM audit_log WHERE action = 'agent.updated'")).rows[0]);
    expect(audit.metadata).toEqual({ enabled: true, instructionsLength: 29 });
    expect(JSON.stringify(audit.metadata)).not.toContain("lunes");
    // Actualizar de nuevo (upsert).
    expect((await saveAgent(api("PUT", "/api/agent", t.cookie, { ...body, enabled: false }))).status).toBe(200);
    expect((await withTenant(t.tenantId, async (db) => (await db.query("SELECT enabled FROM tenant_agents")).rows))).toEqual([{ enabled: false }]);
  });

  it("rechaza sin sesión, con origen ajeno y con datos inválidos", async () => {
    const t = await register("api2", { agent: false });
    expect((await saveAgent(api("PUT", "/api/agent", undefined, body))).status).toBe(401);
    expect((await saveAgent(api("PUT", "/api/agent", t.cookie, body, "https://malo.example"))).status).toBe(403);
    expect((await saveAgent(api("PUT", "/api/agent", t.cookie, { ...body, assistantName: "  " }))).status).toBe(400);
    expect((await saveAgent(api("PUT", "/api/agent", t.cookie, { ...body, instructions: "x".repeat(4001) }))).status).toBe(400);
    expect((await saveAgent(api("PUT", "/api/agent", t.cookie, { ...body, enabled: "sí" }))).status).toBe(400);
    const row = await withTenant(t.tenantId, async (db) => (await db.query("SELECT 1 FROM tenant_agents")).rowCount);
    expect(row).toBe(0);
  });

  it("solo dueños y administradores pueden cambiar el asistente", () => {
    expect(can("owner", "agent:manage")).toBe(true);
    expect(can("admin", "agent:manage")).toBe(true);
    expect(can("agent", "agent:manage")).toBe(false);
    expect(can(null, "agent:manage")).toBe(false);
  });
});

describe("aislamiento de la configuración", () => {
  it("un negocio no ve ni cambia el asistente de otro (RLS)", async () => {
    const a = await register("iso-a", { instructions: "SECRETO-DE-A" });
    const b = await register("iso-b", { instructions: "de B" });
    const seenByB = await withTenant(b.tenantId, async (db) => (await db.query("SELECT instructions FROM tenant_agents")).rows);
    expect(seenByB).toEqual([{ instructions: "de B" }]);
    const touched = await withTenant(b.tenantId, (db) => db.query("UPDATE tenant_agents SET instructions = 'hackeado' WHERE tenant_id = $1", [a.tenantId]));
    expect(touched.rowCount).toBe(0);
  });
});
