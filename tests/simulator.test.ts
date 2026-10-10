import { randomUUID } from "node:crypto";
import IORedis from "ioredis";
import { Worker } from "bullmq";
import { Pool } from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { POST as signup } from "@/app/api/auth/signup/route";
import { GET as me } from "@/app/api/me/route";
import { GET as simGet, POST as simPost } from "@/app/api/dev/simulador/route";
import { getPool, withTenant } from "@/lib/db";
import { getSendMode } from "@/lib/env";
import { QUEUE_NAME } from "@/lib/queue/connection";
import { closeLockClient } from "@/lib/queue/lock";
import { closeProducer } from "@/lib/queue/producer";
import { processInbound } from "@/lib/queue/process";
import { sendText } from "@/lib/whatsapp/graph";
import { createInboundHandler, onJobFailed } from "@/worker/handler";

const RUN = randomUUID().slice(0, 8);
process.env.QUEUE_PREFIX = `test-s-${RUN}`;
const PREFIX = process.env.QUEUE_PREFIX;
const ORIGIN = new URL(process.env.APP_URL!).origin;
const owner = new Pool({ connectionString: process.env.MIGRATION_DATABASE_URL, max: 2 });
const tenantIds: string[] = [];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function api(method: string, cookie: string | undefined, body?: unknown, origin = ORIGIN) {
  return new Request(`${ORIGIN}/api/dev/simulador`, {
    method,
    headers: { origin, ...(body !== undefined ? { "content-type": "application/json" } : {}), ...(cookie ? { cookie } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}
async function register(name: string, agent = true) {
  const email = `sim-${RUN}-${name}@example.test`;
  const res = await signup(new Request(`${ORIGIN}/api/auth/signup`, { method: "POST", headers: { origin: ORIGIN, "content-type": "application/json" }, body: JSON.stringify({ email, password: "contraseña-de-prueba-123", businessName: `Negocio ${name}` }) }));
  const cookie = (res.headers.get("set-cookie") ?? "").split(";")[0]!;
  const info = await (await me(new Request(`${ORIGIN}/api/me`, { headers: { origin: ORIGIN, cookie } }))).json();
  const tenantId = info.tenant.id as string;
  tenantIds.push(tenantId);
  if (agent) await withTenant(tenantId, (db) => db.query("INSERT INTO tenant_agents (tenant_id, enabled, instructions) VALUES ($1, true, 'Abrimos 8-5')", [tenantId]));
  return { cookie, tenantId };
}
type View = { sendMode: string; agentEnabled: boolean; whatsappReady: boolean; conversation: { status: string; handoffReason: string | null } | null; messages: { direction: string; body: string; send_state: string | null }[] };
const view = async (cookie: string) => (await (await simGet(api("GET", cookie))).json()) as View;
async function until<T>(fn: () => Promise<T | false>, ms = 10_000): Promise<T> {
  const t0 = Date.now();
  for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t0 > ms) throw new Error("tiempo agotado"); await sleep(100); }
}

let worker: Worker;
let conn: IORedis;
beforeAll(() => {
  conn = new IORedis(process.env.REDIS_URL!, { maxRetriesPerRequest: null });
  const handler = createInboundHandler();
  worker = new Worker(QUEUE_NAME, (job) => processInbound(job.data, handler), { connection: conn, prefix: PREFIX, concurrency: 2 });
  worker.on("failed", (job, err) => void onJobFailed(job, err));
});
afterEach(() => vi.unstubAllEnvs());
afterAll(async () => {
  await worker.close();
  conn.disconnect();
  await closeProducer();
  await closeLockClient();
  const redis = new IORedis(process.env.REDIS_URL!);
  let cursor = "0";
  do { const [n, keys] = await redis.scan(cursor, "MATCH", `${PREFIX}:*`, "COUNT", 500); cursor = n; if (keys.length) await redis.del(...keys); } while (cursor !== "0");
  redis.disconnect();
  await owner.query("DELETE FROM users WHERE email LIKE $1", [`sim-${RUN}-%`]);
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

describe("modo de envío y herramientas de desarrollo", () => {
  it("simulate se rechaza en staging y producción, y meta es el valor por defecto", () => {
    vi.stubEnv("WHATSAPP_SEND_MODE", "simulate");
    for (const e of ["staging", "production"]) {
      vi.stubEnv("APP_ENV", e);
      expect(() => getSendMode()).toThrow(/simulate/);
    }
    vi.stubEnv("APP_ENV", "local");
    expect(getSendMode()).toBe("simulate");
    vi.stubEnv("WHATSAPP_SEND_MODE", "");
    vi.unstubAllEnvs();
    delete process.env.WHATSAPP_SEND_MODE;
    expect(getSendMode()).toBe("meta");
  });

  it("sendText en simulate no hace ninguna petición de red", async () => {
    vi.stubEnv("WHATSAPP_SEND_MODE", "simulate");
    const f = vi.fn();
    const r = await sendText("123456789012", "tok", "584120000001", "hola", f as unknown as typeof fetch);
    expect(r.kind).toBe("sent");
    expect(r.kind === "sent" && r.waMessageId.startsWith("wamid.SIM.")).toBe(true);
    expect(f).not.toHaveBeenCalled();
  });

  it("en production responde 404 aunque haya sesión válida", async () => {
    const t = await register("prod");
    vi.stubEnv("APP_ENV", "production");
    expect((await simGet(api("GET", t.cookie))).status).toBe(404);
    expect((await simPost(api("POST", t.cookie, { action: "send", text: "hola" }))).status).toBe(404);
  });
});

describe("API /api/dev/simulador", () => {
  it("exige sesión, origen válido y datos válidos", async () => {
    const t = await register("val");
    vi.stubEnv("WHATSAPP_SEND_MODE", "simulate");
    expect((await simGet(api("GET", undefined))).status).toBe(401);
    expect((await simPost(api("POST", t.cookie, { action: "send", text: "hola" }, "https://malo.example"))).status).toBe(403);
    expect((await simPost(api("POST", t.cookie, { action: "send", text: "   " }))).status).toBe(400);
    expect((await simPost(api("POST", t.cookie, { action: "send", text: "x".repeat(1001) }))).status).toBe(400);
    expect((await simPost(api("POST", t.cookie, { action: "otra" }))).status).toBe(400);
  });

  it("en modo meta sin número conectado responde 409 y no guarda nada", async () => {
    const t = await register("meta");
    vi.stubEnv("WHATSAPP_SEND_MODE", "meta");
    const res = await simPost(api("POST", t.cookie, { action: "send", text: "hola" }));
    expect(res.status).toBe(409);
    expect((await view(t.cookie)).messages).toHaveLength(0);
    expect((await owner.query("SELECT 1 FROM tenant_integrations WHERE tenant_id = $1", [t.tenantId])).rowCount).toBe(0);
  });

  it("simulate: crea un número de prueba y el agente responde por la ruta real (cola + worker)", async () => {
    const t = await register("flujo");
    vi.stubEnv("WHATSAPP_SEND_MODE", "simulate");
    expect((await simPost(api("POST", t.cookie, { action: "send", text: "¿A qué hora abren?" }))).status).toBe(201);
    const v = await until(async () => { const x = await view(t.cookie); return x.messages.some((m) => m.direction === "out" && m.send_state === "sent") ? x : false; });
    expect(v.sendMode).toBe("simulate");
    expect(v.whatsappReady).toBe(true);
    const out = v.messages.find((m) => m.direction === "out")!;
    expect(out.body).toContain("¿A qué hora abren?");
    expect(v.conversation?.status).toBe("bot");
    const wa = await withTenant(t.tenantId, (db) => db.query("SELECT wa_message_id FROM messages WHERE direction = 'out'"));
    expect(wa.rows[0].wa_message_id).toMatch(/^wamid\.SIM\./);
    // un segundo mensaje reutiliza el mismo número de prueba
    await simPost(api("POST", t.cookie, { action: "send", text: "Gracias" }));
    await until(async () => (await view(t.cookie)).messages.filter((m) => m.direction === "out").length === 2);
    expect((await owner.query("SELECT 1 FROM tenant_integrations WHERE tenant_id = $1", [t.tenantId])).rowCount).toBe(1);
  });

  it("con el asistente apagado no responde y lo informa", async () => {
    const t = await register("apagado", false);
    vi.stubEnv("WHATSAPP_SEND_MODE", "simulate");
    await simPost(api("POST", t.cookie, { action: "send", text: "hola" }));
    await sleep(1500);
    const v = await view(t.cookie);
    expect(v.agentEnabled).toBe(false);
    expect(v.messages.filter((m) => m.direction === "out")).toHaveLength(0);
    expect(v.messages).toHaveLength(1);
  });

  it("pedir una persona pasa la conversación a humano y deja de responder", async () => {
    const t = await register("humano");
    vi.stubEnv("WHATSAPP_SEND_MODE", "simulate");
    await simPost(api("POST", t.cookie, { action: "send", text: "quiero hablar con una persona" }));
    const v = await until(async () => { const x = await view(t.cookie); return x.conversation?.status === "human" ? x : false; });
    expect(v.conversation?.handoffReason).toBe("pedido_de_persona");
    const antes = v.messages.length;
    await simPost(api("POST", t.cookie, { action: "send", text: "¿hola?" }));
    await sleep(1500);
    const d = await view(t.cookie);
    expect(d.messages.length).toBe(antes + 1);
    expect(d.messages.at(-1)!.direction).toBe("in");
  });

  it("reset cierra la conversación y empieza una nueva vacía", async () => {
    const t = await register("reset");
    vi.stubEnv("WHATSAPP_SEND_MODE", "simulate");
    await simPost(api("POST", t.cookie, { action: "send", text: "hola" }));
    await until(async () => (await view(t.cookie)).messages.some((m) => m.direction === "out"));
    expect((await simPost(api("POST", t.cookie, { action: "reset" }))).status).toBe(200);
    expect(await view(t.cookie)).toMatchObject({ conversation: null, messages: [] });
    await simPost(api("POST", t.cookie, { action: "send", text: "de nuevo" }));
    const v = await until(async () => { const x = await view(t.cookie); return x.messages.some((m) => m.direction === "out") ? x : false; });
    expect(v.messages).toHaveLength(2);
    expect(v.conversation?.status).toBe("bot");
  });

  it("aísla negocios: el simulador de uno no ve los mensajes de otro", async () => {
    const a = await register("aisla-a");
    const b = await register("aisla-b");
    vi.stubEnv("WHATSAPP_SEND_MODE", "simulate");
    await simPost(api("POST", a.cookie, { action: "send", text: "secreto-de-A" }));
    await until(async () => (await view(a.cookie)).messages.some((m) => m.direction === "out"));
    expect((await view(b.cookie)).messages).toHaveLength(0);
  });
});
