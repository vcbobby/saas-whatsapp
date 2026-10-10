import { createHmac, randomUUID } from "node:crypto";
import IORedis from "ioredis";
import { Queue, Worker } from "bullmq";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { POST as signup } from "@/app/api/auth/signup/route";
import { GET as me } from "@/app/api/me/route";
import { POST as hookPost } from "@/app/api/webhooks/whatsapp/route";
import { getPool, withTenant } from "@/lib/db";
import { QUEUE_NAME } from "@/lib/queue/connection";
import { markInboundFailed, processInbound } from "@/lib/queue/process";
import * as producer from "@/lib/queue/producer";
import { sweepPending } from "@/lib/queue/sweeper";

const RUN = randomUUID().slice(0, 8);
process.env.QUEUE_PREFIX = `test-q-${RUN}`;
process.env.WHATSAPP_APP_SECRET = "secreto-de-prueba-de-la-app-meta";
process.env.WHATSAPP_VERIFY_TOKEN = "token-de-verificacion-de-prueba-123456";
const SECRET = process.env.WHATSAPP_APP_SECRET;
const PREFIX = process.env.QUEUE_PREFIX;

const ORIGIN = new URL(process.env.APP_URL!).origin;
const PASSWORD = "contraseña-de-prueba-123";
const owner = new Pool({ connectionString: process.env.MIGRATION_DATABASE_URL, max: 2 });
const tenantIds: string[] = [];
let seq = 0;
const newPhoneId = () => `8${RUN.replace(/\D/g, "").padEnd(4, "5").slice(0, 4)}${Date.now() % 100000}${seq++}`.slice(0, 18);
const waId = () => `wamid.${RUN}.${seq++}.${Math.random().toString(36).slice(2)}`;

const redis = new IORedis(process.env.REDIS_URL!, { maxRetriesPerRequest: 1 });
const inspect = new Queue(QUEUE_NAME, { connection: redis, prefix: PREFIX });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function api(method: string, path: string, cookie?: string, body?: unknown) {
  return new Request(`${ORIGIN}${path}`, {
    method,
    headers: { origin: ORIGIN, ...(body !== undefined ? { "content-type": "application/json" } : {}), ...(cookie ? { cookie } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}
async function register(name: string) {
  const email = `q-${RUN}-${name}@example.test`;
  const res = await signup(api("POST", "/api/auth/signup", undefined, { email, password: PASSWORD, businessName: `Negocio ${name}` }));
  expect(res.status).toBe(201);
  const cookie = (res.headers.get("set-cookie") ?? "").split(";")[0]!;
  const info = await (await me(api("GET", "/api/me", cookie))).json();
  tenantIds.push(info.tenant.id);
  const phoneId = newPhoneId();
  await owner.query(
    "INSERT INTO tenant_integrations (tenant_id, provider, external_id, secret_enc) VALUES ($1, 'whatsapp', $2, 'x')",
    [info.tenant.id, phoneId],
  );
  return { tenantId: info.tenant.id as string, phoneId };
}

const BODY_SECRETO = "TEXTO-PRIVADO-DEL-CLIENTE-123";
function hookReq(phoneId: string, id: string, body = BODY_SECRETO) {
  const raw = JSON.stringify({
    object: "whatsapp_business_account",
    entry: [{ id: "1", changes: [{ field: "messages", value: {
      messaging_product: "whatsapp",
      metadata: { display_phone_number: "58412", phone_number_id: phoneId },
      contacts: [{ wa_id: "584121234567", profile: { name: "Cliente" } }],
      messages: [{ from: "584121234567", id, timestamp: String(Math.floor(Date.now() / 1000)), type: "text", text: { body } }],
    } }] }],
  });
  const sig = "sha256=" + createHmac("sha256", SECRET).update(raw).digest("hex");
  return new Request(`${ORIGIN}/api/webhooks/whatsapp`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-hub-signature-256": sig },
    body: raw,
  });
}

async function messageOf(tenantId: string, wa: string) {
  return withTenant(tenantId, async (db) => {
    const r = await db.query("SELECT id, process_state FROM messages WHERE tenant_id = $1 AND wa_message_id = $2", [tenantId, wa]);
    return r.rows[0] as { id: string; process_state: string } | undefined;
  });
}
async function ageMessage(tenantId: string, messageId: string, seconds: number) {
  await withTenant(tenantId, (db) =>
    db.query("UPDATE messages SET process_state_at = now() - make_interval(secs => $3) WHERE tenant_id = $1 AND id = $2", [tenantId, messageId, seconds]));
}
async function waitFor<T>(fn: () => Promise<T | undefined | false>, ms = 8_000): Promise<T> {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error("tiempo agotado esperando la condición");
    await sleep(100);
  }
}

beforeAll(async () => {
  await redis.ping(); // si Redis no está encendido, falla aquí con un error claro
});

afterAll(async () => {
  await producer.closeProducer();
  await inspect.close();
  let cursor = "0";
  do {
    const [next, keys] = await redis.scan(cursor, "MATCH", `${PREFIX}:*`, "COUNT", 500);
    cursor = next;
    if (keys.length) await redis.del(...keys);
  } while (cursor !== "0");
  redis.disconnect();
  await owner.query("DELETE FROM users WHERE email LIKE $1", [`q-${RUN}-%`]);
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

describe("webhook → cola", () => {
  it("guarda el mensaje como pending y encola un trabajo con SOLO ids", async () => {
    const t = await register("a");
    const wa = waId();
    const res = await hookPost(hookReq(t.phoneId, wa));
    expect(res.status).toBe(200);

    const m = await messageOf(t.tenantId, wa);
    expect(m?.process_state).toBe("pending");

    const job = await inspect.getJob(m!.id);
    expect(job).toBeTruthy();
    expect(job!.data).toEqual({ tenantId: t.tenantId, messageId: m!.id });
    // Nada de contenido ni teléfonos dentro de Redis.
    const crudo = JSON.stringify(await redis.hgetall(`${PREFIX}:${QUEUE_NAME}:${m!.id}`));
    expect(crudo).not.toContain(BODY_SECRETO);
    expect(crudo).not.toContain("584121234567");
  });

  it("si Meta reenvía el mismo mensaje no se duplica ni el mensaje ni el trabajo", async () => {
    const t = await register("dup");
    const wa = waId();
    await hookPost(hookReq(t.phoneId, wa));
    await hookPost(hookReq(t.phoneId, wa));
    const m = await messageOf(t.tenantId, wa);
    const jobs = (await inspect.getJobs(["waiting", "active", "delayed", "completed", "failed"])).filter((j) => j.id === m!.id);
    expect(jobs).toHaveLength(1);
  });

  it("si Redis falla, el webhook igual responde 200 y el mensaje queda pending", async () => {
    const t = await register("sinredis");
    const spy = vi.spyOn(producer, "enqueueInbound").mockRejectedValueOnce(new Error("Redis caído"));
    const wa = waId();
    const res = await hookPost(hookReq(t.phoneId, wa));
    spy.mockRestore();
    expect(res.status).toBe(200);
    expect((await messageOf(t.tenantId, wa))?.process_state).toBe("pending");
  });

  it("si Redis se queda colgado, el webhook no se cuelga con él (responde 200 en pocos segundos)", async () => {
    const t = await register("colgado");
    const admin = new IORedis(process.env.REDIS_URL!, { maxRetriesPerRequest: 1 });
    await producer.enqueueInbound([{ tenantId: t.tenantId, messageId: randomUUID() }]).catch(() => {}); // calienta la conexión
    await admin.call("CLIENT", "PAUSE", "4500", "ALL");
    const wa = waId();
    const t0 = Date.now();
    const res = await hookPost(hookReq(t.phoneId, wa));
    const ms = Date.now() - t0;
    expect(res.status).toBe(200);
    expect(ms).toBeLessThan(4_200);
    expect((await messageOf(t.tenantId, wa))?.process_state).toBe("pending");
    await sleep(Math.max(0, 4_700 - ms)); // espera a que termine la pausa
    admin.disconnect();
  }, 15_000);
});

describe("procesar un trabajo", () => {
  it("marca done, llama al handler una sola vez y no repite", async () => {
    const t = await register("proc");
    const wa = waId();
    await hookPost(hookReq(t.phoneId, wa));
    const m = (await messageOf(t.tenantId, wa))!;
    const handler = vi.fn(async () => {});
    const data = { tenantId: t.tenantId, messageId: m.id };
    expect(await processInbound(data, handler)).toBe("done");
    expect(await processInbound(data, handler)).toBe("skipped");
    expect(handler).toHaveBeenCalledTimes(1);
    expect((await messageOf(t.tenantId, wa))?.process_state).toBe("done");
  });

  it("si el handler falla, el mensaje sigue pending; al agotar reintentos pasa a failed y el barrendero lo ignora", async () => {
    const t = await register("falla");
    const wa = waId();
    await hookPost(hookReq(t.phoneId, wa));
    const m = (await messageOf(t.tenantId, wa))!;
    const data = { tenantId: t.tenantId, messageId: m.id };
    await expect(processInbound(data, async () => { throw new Error("la IA falló"); })).rejects.toThrow("la IA falló");
    expect((await messageOf(t.tenantId, wa))?.process_state).toBe("pending");

    await markInboundFailed(data);
    expect((await messageOf(t.tenantId, wa))?.process_state).toBe("failed");

    await ageMessage(t.tenantId, m.id, 3_600);
    const r = await getPool().query("SELECT out_message_id FROM queue_pending_inbound(0, 500)");
    expect(r.rows.map((x) => x.out_message_id)).not.toContain(m.id);
  });

  it("un trabajo falso (negocio A con mensaje de B) no toca nada", async () => {
    const a = await register("fa");
    const b = await register("fb");
    const wa = waId();
    await hookPost(hookReq(b.phoneId, wa));
    const mb = (await messageOf(b.tenantId, wa))!;
    const handler = vi.fn(async () => {});
    expect(await processInbound({ tenantId: a.tenantId, messageId: mb.id }, handler)).toBe("skipped");
    expect(handler).not.toHaveBeenCalled();
    expect((await messageOf(b.tenantId, wa))?.process_state).toBe("pending");
    await markInboundFailed({ tenantId: a.tenantId, messageId: mb.id });
    expect((await messageOf(b.tenantId, wa))?.process_state).toBe("pending");
  });

  it("rechaza datos mal formados", async () => {
    await expect(processInbound({ tenantId: "x", messageId: "y" }, async () => {})).rejects.toThrow();
    await expect(processInbound(null, async () => {})).rejects.toThrow();
  });
});

describe("barrendero", () => {
  it("reencola lo pendiente (aunque Redis haya fallado) pero no lo reciente; y no duplica", async () => {
    const t = await register("sweep");
    const spy = vi.spyOn(producer, "enqueueInbound").mockRejectedValueOnce(new Error("Redis caído"));
    const wa = waId();
    await hookPost(hookReq(t.phoneId, wa));
    spy.mockRestore();
    const m = (await messageOf(t.tenantId, wa))!;
    expect(await inspect.getJob(m.id)).toBeFalsy();

    // Reciente: con 60 s de margen no se toca.
    const ids = async (age: number) => (await getPool().query("SELECT out_message_id FROM queue_pending_inbound($1, 500)", [age])).rows.map((x) => x.out_message_id);
    expect(await ids(60)).not.toContain(m.id);

    await ageMessage(t.tenantId, m.id, 120);
    expect(await ids(60)).toContain(m.id);
    expect(await sweepPending(60)).toBeGreaterThanOrEqual(1);
    expect(await inspect.getJob(m.id)).toBeTruthy();
    await sweepPending(60);
    const copias = (await inspect.getJobs(["waiting", "active", "delayed", "completed", "failed"])).filter((j) => j.id === m.id);
    expect(copias).toHaveLength(1);
  });

  it("la función devuelve solo ids y no deja ningún negocio fijado", async () => {
    const t = await register("fn");
    const wa = waId();
    await hookPost(hookReq(t.phoneId, wa));
    const c = await getPool().connect();
    try {
      await c.query("BEGIN");
      const r = await c.query("SELECT * FROM queue_pending_inbound(0, 500)");
      expect(Object.keys(r.fields.reduce((o, f) => ({ ...o, [f.name]: 1 }), {})).sort()).toEqual(["out_message_id", "out_tenant_id"]);
      const set = await c.query("SELECT current_setting('app.tenant_id', true) AS v");
      expect(set.rows[0].v ?? "").toBe("");
      // Sin negocio fijado, app_user sigue sin ver ningún mensaje (RLS).
      expect(Number((await c.query("SELECT count(*) AS n FROM messages")).rows[0].n)).toBe(0);
      await c.query("ROLLBACK");
    } finally {
      c.release();
    }
  });

  it("solo app_user puede ejecutar la función (no PUBLIC)", async () => {
    const r = await owner.query(
      `SELECT has_function_privilege('app_user', 'queue_pending_inbound(integer,integer)', 'EXECUTE') AS app,
              coalesce(proacl::text, '') AS acl
         FROM pg_proc WHERE proname = 'queue_pending_inbound'`,
    );
    expect(r.rows[0].app).toBe(true);
    expect(r.rows[0].acl).not.toMatch(/(^|[{,])=X/); // "=X/..." significa PUBLIC
  });
});

describe("worker real de punta a punta", () => {
  it("un mensaje que llega por el webhook termina en done sin intervención", async () => {
    const t = await register("e2e");
    const seen: string[] = [];
    const conn = new IORedis(process.env.REDIS_URL!, { maxRetriesPerRequest: null });
    const worker = new Worker(QUEUE_NAME, (job) => processInbound(job.data, async (j) => { seen.push(j.messageId); }), { connection: conn, prefix: PREFIX });
    try {
      const wa = waId();
      expect((await hookPost(hookReq(t.phoneId, wa))).status).toBe(200);
      await waitFor(async () => (await messageOf(t.tenantId, wa))?.process_state === "done");
      const m = (await messageOf(t.tenantId, wa))!;
      // El worker también recoge trabajos pendientes de pruebas anteriores; el nuestro, exactamente una vez.
      expect(seen.filter((x) => x === m.id)).toHaveLength(1);
    } finally {
      await worker.close();
      conn.disconnect();
    }
  });
});
