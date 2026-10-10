import { createHmac, randomUUID } from "node:crypto";
import IORedis from "ioredis";
import { Worker } from "bullmq";
import { Pool } from "pg";
import { afterAll, describe, expect, it, vi } from "vitest";
import { POST as signup } from "@/app/api/auth/signup/route";
import { GET as me } from "@/app/api/me/route";
import { POST as hookPost } from "@/app/api/webhooks/whatsapp/route";
import { LlmError, type LlmProvider } from "@/lib/ai/provider";
import { encryptSecret } from "@/lib/crypto";
import { getPool, withTenant } from "@/lib/db";
import { QUEUE_NAME } from "@/lib/queue/connection";
import { closeLockClient } from "@/lib/queue/lock";
import { processInbound } from "@/lib/queue/process";
import { closeProducer } from "@/lib/queue/producer";
import { createInboundHandler, onJobFailed } from "@/worker/handler";

process.env.WHATSAPP_APP_SECRET = "secreto-de-prueba-de-la-app-meta";
process.env.WHATSAPP_VERIFY_TOKEN = "token-de-verificacion-de-prueba-123456";
const RUN = randomUUID().slice(0, 8);
process.env.QUEUE_PREFIX = `test-e-${RUN}`;
const PREFIX = process.env.QUEUE_PREFIX;
const ORIGIN = new URL(process.env.APP_URL!).origin;
const owner = new Pool({ connectionString: process.env.MIGRATION_DATABASE_URL, max: 2 });
const tenantIds: string[] = [];
let seq = 0;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function setup(name: string) {
  const email = `e2e-${RUN}-${name}@example.test`;
  const res = await signup(new Request(`${ORIGIN}/api/auth/signup`, { method: "POST", headers: { origin: ORIGIN, "content-type": "application/json" }, body: JSON.stringify({ email, password: "contraseña-de-prueba-123", businessName: `Negocio ${name}` }) }));
  const cookie = (res.headers.get("set-cookie") ?? "").split(";")[0]!;
  const info = await (await me(new Request(`${ORIGIN}/api/me`, { headers: { origin: ORIGIN, cookie } }))).json();
  const tenantId = info.tenant.id as string;
  tenantIds.push(tenantId);
  const phoneId = `5${RUN.replace(/\D/g, "").padEnd(4, "9").slice(0, 4)}${Date.now() % 100000}${seq++}`.slice(0, 18);
  const { payload, keyVersion } = encryptSecret("EAAtoken-e2e-1234567890-abcdef", `wa:${tenantId}:${phoneId}`);
  await owner.query("INSERT INTO tenant_integrations (tenant_id, provider, external_id, secret_enc, key_version) VALUES ($1,'whatsapp',$2,$3,$4)", [tenantId, phoneId, payload, keyVersion]);
  await withTenant(tenantId, (db) => db.query("INSERT INTO tenant_agents (tenant_id, enabled, instructions) VALUES ($1, true, 'Abrimos 8-5')", [tenantId]));
  return { tenantId, phoneId };
}

function webhook(phoneId: string, text: string) {
  const raw = JSON.stringify({ object: "whatsapp_business_account", entry: [{ id: "1", changes: [{ field: "messages", value: {
    messaging_product: "whatsapp", metadata: { display_phone_number: "58412", phone_number_id: phoneId },
    contacts: [{ wa_id: "584125550000", profile: { name: "Cliente" } }],
    messages: [{ from: "584125550000", id: `wamid.${RUN}.${seq++}`, timestamp: String(Math.floor(Date.now() / 1000)), type: "text", text: { body: text } }],
  } }] }] });
  return new Request(`${ORIGIN}/api/webhooks/whatsapp`, { method: "POST", headers: { "content-type": "application/json", "x-hub-signature-256": "sha256=" + createHmac("sha256", process.env.WHATSAPP_APP_SECRET!).update(raw).digest("hex") }, body: raw });
}

function startWorker(handler: ReturnType<typeof createInboundHandler>) {
  const conn = new IORedis(process.env.REDIS_URL!, { maxRetriesPerRequest: null });
  const w = new Worker(QUEUE_NAME, (job) => processInbound(job.data, handler), { connection: conn, prefix: PREFIX, concurrency: 3 });
  w.on("failed", (job, err) => void onJobFailed(job, err));
  return { worker: w, close: async () => { await w.close(); conn.disconnect(); } };
}

const state = (tenantId: string) => withTenant(tenantId, async (db) => ({
  inbound: (await db.query("SELECT process_state FROM messages WHERE direction = 'in'")).rows[0]?.process_state as string | undefined,
  out: (await db.query("SELECT send_state, body FROM messages WHERE direction = 'out'")).rows as { send_state: string; body: string }[],
  conv: (await db.query("SELECT status, handoff_reason FROM conversations")).rows[0] as { status: string; handoff_reason: string | null },
}));
async function until<T>(fn: () => Promise<T | false>, ms = 10_000): Promise<T> {
  const t0 = Date.now();
  for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t0 > ms) throw new Error("tiempo agotado"); await sleep(100); }
}

afterAll(async () => {
  await closeProducer();
  await closeLockClient();
  const redis = new IORedis(process.env.REDIS_URL!);
  let cursor = "0";
  do { const [n, keys] = await redis.scan(cursor, "MATCH", `${PREFIX}:*`, "COUNT", 500); cursor = n; if (keys.length) await redis.del(...keys); } while (cursor !== "0");
  redis.disconnect();
  await owner.query("DELETE FROM users WHERE email LIKE $1", [`e2e-${RUN}-%`]);
  for (const id of tenantIds) {
    const c = await owner.connect();
    try {
      await c.query("BEGIN");
      await c.query("SELECT set_config('app.tenant_id', $1, true)", [id]);
      await c.query("ALTER TABLE audit_log DISABLE TRIGGER audit_log_sin_cambios");
      await c.query("DELETE FROM audit_log WHERE tenant_id = $1", [id]);
      await c.query("ALTER TABLE audit_log ENABLE TRIGGER audit_log_sin_cambios");
      if ((await c.query("DELETE FROM tenants WHERE id = $1", [id])).rowCount !== 1) throw new Error("La limpieza no borró " + id);
      await c.query("COMMIT");
    } catch (e) { await c.query("ROLLBACK"); throw e; } finally { c.release(); }
  }
  await owner.end();
  await getPool().end();
});

describe("de punta a punta con el worker real", () => {
  it("webhook → cola → agente → WhatsApp: el cliente recibe la respuesta y el mensaje queda procesado", async () => {
    const t = await setup("ok");
    const llm: LlmProvider = { name: "stub", generate: async () => ({ text: "Abrimos de 8 a 5.", inputTokens: 1, outputTokens: 1, model: "s" }) };
    const send = vi.fn(async () => ({ kind: "sent" as const, waMessageId: "wamid.salida-e2e" }));
    const w = startWorker(createInboundHandler({ llm, send }));
    try {
      expect((await hookPost(webhook(t.phoneId, "¿horario?"))).status).toBe(200);
      const s = await until(async () => { const x = await state(t.tenantId); return x.inbound === "done" && x.out.length === 1 && x });
      expect(s.out[0]).toEqual({ send_state: "sent", body: "Abrimos de 8 a 5." });
      expect(s.conv.status).toBe("bot");
      expect(send).toHaveBeenCalledTimes(1);
    } finally { await w.close(); }
  });

  it("error permanente de la IA (clave inválida): falla de inmediato, sin 5 reintentos, y pasa a una persona", async () => {
    const t = await setup("perm");
    const llm: LlmProvider = { name: "stub", generate: vi.fn(async () => { throw new LlmError("401", false, 401); }) };
    const send = vi.fn();
    const w = startWorker(createInboundHandler({ llm, send: send as never }));
    try {
      await hookPost(webhook(t.phoneId, "hola"));
      const s = await until(async () => { const x = await state(t.tenantId); return x.inbound === "failed" && x });
      expect(s.conv).toEqual({ status: "human", handoff_reason: "agente_fallo" });
      expect(s.out).toHaveLength(0);
      expect(send).not.toHaveBeenCalled();
      expect(llm.generate).toHaveBeenCalledTimes(1); // un solo intento
    } finally { await w.close(); }
  });

  it("error temporal de la IA: se reintenta y al final responde", async () => {
    const t = await setup("temp");
    let n = 0;
    const llm: LlmProvider = { name: "stub", generate: async () => { if (n++ === 0) throw new LlmError("429", true, 429); return { text: "Ya estoy aquí.", inputTokens: 0, outputTokens: 0, model: "s" }; } };
    const send = vi.fn(async () => ({ kind: "sent" as const, waMessageId: "wamid.salida-temp" }));
    const w = startWorker(createInboundHandler({ llm, send }));
    try {
      await hookPost(webhook(t.phoneId, "hola"));
      const s = await until(async () => { const x = await state(t.tenantId); return x.inbound === "done" && x.out.length === 1 && x }, 15_000);
      expect(s.out[0]!.body).toBe("Ya estoy aquí.");
      expect(n).toBe(2);
    } finally { await w.close(); }
  }, 25_000);
});
