#!/usr/bin/env bash
# Paso 7: cola de trabajo con Redis + BullMQ.
# Ejecútalo desde la raíz del proyecto:  bash aplicar-paso-7.sh
set -euo pipefail

[ -f package.json ] && grep -q '"name": "saas-whatsapp"' package.json || { echo "✖ Ejecuta esto dentro de ~/proyectos/saas-whatsapp"; exit 1; }
[ -f src/lib/whatsapp/ingest.ts ] || { echo "✖ Falta el Paso 6 (src/lib/whatsapp/ingest.ts). ¿Hiciste git pull en main?"; exit 1; }
command -v node >/dev/null || { echo "✖ Falta node"; exit 1; }
command -v openssl >/dev/null || { echo "✖ Falta openssl"; exit 1; }

if [ "$(git rev-parse --abbrev-ref HEAD 2>/dev/null)" = "main" ]; then
  git checkout -b paso-7
  echo "✔ Rama paso-7 creada"
fi

mkdir -p src/lib/queue src/worker tests db/migrations
mkdir -p db/migrations
cat > db/migrations/0005_cola.sql <<'EOF_DB_MIGRATIONS_0005_COLA_SQL'
-- 0005: cola de trabajo (Paso 7).
-- Postgres es la fuente de verdad; Redis solo transporta. Cada mensaje entrante
-- nace "pending" y pasa a "done" cuando el worker lo procesa. Si Redis se cae o
-- un trabajo se pierde, el barrendero vuelve a encolar lo que siga "pending".

ALTER TABLE messages
  ADD COLUMN process_state text NOT NULL DEFAULT 'done'
    CHECK (process_state IN ('pending', 'done', 'failed')),
  ADD COLUMN process_state_at timestamptz NOT NULL DEFAULT now();

CREATE INDEX messages_pendientes_idx ON messages (process_state_at)
  WHERE direction = 'in' AND process_state = 'pending';

-- El barrendero necesita mirar todos los negocios, pero messages tiene RLS forzada.
-- Esta función entra negocio por negocio (solo los que tienen WhatsApp conectado),
-- devuelve ÚNICAMENTE ids (nunca contenido) y no deja ningún negocio fijado al terminar.
CREATE FUNCTION queue_pending_inbound(p_min_age_seconds integer, p_limit integer)
RETURNS TABLE (out_tenant_id uuid, out_message_id uuid)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  t uuid;
  remaining integer := LEAST(GREATEST(COALESCE(p_limit, 1), 1), 500);
  n integer;
  min_age integer := GREATEST(COALESCE(p_min_age_seconds, 0), 0);
BEGIN
  FOR t IN SELECT DISTINCT ti.tenant_id FROM tenant_integrations ti WHERE ti.provider = 'whatsapp' LOOP
    EXIT WHEN remaining <= 0;
    PERFORM set_config('app.tenant_id', t::text, true);
    RETURN QUERY
      SELECT m.tenant_id, m.id FROM messages m
      WHERE m.direction = 'in' AND m.process_state = 'pending'
        AND m.process_state_at < now() - make_interval(secs => min_age)
      ORDER BY m.process_state_at
      LIMIT remaining;
    GET DIAGNOSTICS n = ROW_COUNT;
    remaining := remaining - n;
  END LOOP;
  PERFORM set_config('app.tenant_id', '', true);
  RETURN;
END
$$;
REVOKE ALL ON FUNCTION queue_pending_inbound(integer, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION queue_pending_inbound(integer, integer) TO app_user;
EOF_DB_MIGRATIONS_0005_COLA_SQL
echo "✔ db/migrations/0005_cola.sql"
mkdir -p src/lib/queue
cat > src/lib/queue/connection.ts <<'EOF_SRC_LIB_QUEUE_CONNECTION_TS'
import IORedis from "ioredis";
import { getEnv } from "@/lib/env";

export const QUEUE_NAME = "inbound";

/** Prefijo de las claves en Redis. Distinto por entorno para no mezclar datos. */
export function queuePrefix(): string {
  const p = process.env.QUEUE_PREFIX ?? "saas";
  if (!/^[A-Za-z0-9_-]{1,40}$/.test(p)) throw new Error("QUEUE_PREFIX inválido");
  return p;
}

/**
 * Conexión para PRODUCIR trabajos (la usa el webhook). Falla rápido si Redis no
 * responde: el webhook nunca debe quedarse colgado esperando a Redis.
 */
export function createProducerConnection(): IORedis {
  const conn = new IORedis(getEnv().REDIS_URL, {
    maxRetriesPerRequest: 1,
    connectTimeout: 2_000,
    commandTimeout: 2_000,
    retryStrategy: (times) => Math.min(times * 500, 5_000),
  });
  conn.on("error", (err) => console.error("[cola] Redis (productor):", err.message));
  return conn;
}

/** Conexión del worker. BullMQ exige maxRetriesPerRequest: null para esperar trabajos. */
export function createWorkerConnection(): IORedis {
  const conn = new IORedis(getEnv().REDIS_URL, {
    maxRetriesPerRequest: null,
    retryStrategy: (times) => Math.min(times * 500, 10_000),
  });
  conn.on("error", (err) => console.error("[cola] Redis (worker):", err.message));
  return conn;
}
EOF_SRC_LIB_QUEUE_CONNECTION_TS
echo "✔ src/lib/queue/connection.ts"
mkdir -p src/lib/queue
cat > src/lib/queue/producer.ts <<'EOF_SRC_LIB_QUEUE_PRODUCER_TS'
import { Queue } from "bullmq";
import type IORedis from "ioredis";
import { QUEUE_NAME, createProducerConnection, queuePrefix } from "./connection";

/** Lo ÚNICO que viaja por Redis: dos ids. Nunca texto de mensajes ni teléfonos. */
export interface InboundJob {
  tenantId: string;
  messageId: string;
}

export const JOB_OPTIONS = {
  attempts: 5,
  backoff: { type: "exponential" as const, delay: 2_000 },
  removeOnComplete: { age: 3_600, count: 1_000 },
  removeOnFail: { age: 7 * 24 * 3_600 },
};

const ENQUEUE_TIMEOUT_MS = 3_000;

const globalRef = globalThis as unknown as { __inboundQueue?: { queue: Queue; conn: IORedis; prefix: string } };

function getQueue(): Queue {
  const prefix = queuePrefix();
  const cur = globalRef.__inboundQueue;
  if (cur && cur.prefix === prefix) return cur.queue;
  if (cur) void closeProducer();
  const conn = createProducerConnection();
  const queue = new Queue(QUEUE_NAME, { connection: conn, prefix });
  queue.on("error", (err) => console.error("[cola] error:", err.message));
  globalRef.__inboundQueue = { queue, conn, prefix };
  return queue;
}

/**
 * Encola trabajos. El id del trabajo es el id del mensaje: encolarlo dos veces
 * no lo duplica. Lanza error si Redis no responde en unos segundos; quien llama
 * decide (el webhook lo registra y sigue: el barrendero lo recupera).
 */
export async function enqueueInbound(items: InboundJob[]): Promise<void> {
  if (items.length === 0) return;
  const queue = getQueue();
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("Redis no respondió a tiempo")), ENQUEUE_TIMEOUT_MS);
  });
  try {
    await Promise.race([
      queue.addBulk(items.map((it) => ({ name: "inbound", data: it, opts: { ...JOB_OPTIONS, jobId: it.messageId } }))),
      timeout,
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export async function closeProducer(): Promise<void> {
  const cur = globalRef.__inboundQueue;
  globalRef.__inboundQueue = undefined;
  if (!cur) return;
  await cur.queue.close().catch(() => {});
  cur.conn.disconnect();
}
EOF_SRC_LIB_QUEUE_PRODUCER_TS
echo "✔ src/lib/queue/producer.ts"
mkdir -p src/lib/queue
cat > src/lib/queue/process.ts <<'EOF_SRC_LIB_QUEUE_PROCESS_TS'
import { z } from "zod";
import { withTenant } from "@/lib/db";
import type { InboundJob } from "./producer";

const jobSchema = z.object({ tenantId: z.uuid(), messageId: z.uuid() });

export type InboundHandler = (job: InboundJob) => Promise<void>;
export type ProcessResult = "done" | "skipped";

/**
 * Procesa un mensaje entrante. Reglas:
 *  - Todo pasa por withTenant: un trabajo falso con un negocio y un mensaje de otro no encuentra nada (RLS).
 *  - Si el mensaje ya no está "pending" (otro worker lo terminó), no se repite.
 *  - El handler puede ejecutarse más de una vez para el mismo mensaje (reintentos): debe ser idempotente.
 *  - Si el handler falla, el mensaje sigue "pending" y BullMQ reintenta.
 */
export async function processInbound(data: unknown, handler: InboundHandler): Promise<ProcessResult> {
  const job = jobSchema.parse(data);

  const pending = await withTenant(job.tenantId, async (db) => {
    const r = await db.query(
      "SELECT 1 FROM messages WHERE tenant_id = $1 AND id = $2 AND direction = 'in' AND process_state = 'pending'",
      [job.tenantId, job.messageId],
    );
    return r.rowCount === 1;
  });
  if (!pending) return "skipped";

  await handler(job);

  await withTenant(job.tenantId, (db) =>
    db.query(
      "UPDATE messages SET process_state = 'done', process_state_at = now() WHERE tenant_id = $1 AND id = $2 AND process_state = 'pending'",
      [job.tenantId, job.messageId],
    ),
  );
  return "done";
}

/** Se llama cuando BullMQ agotó los reintentos: se deja de insistir y queda registrado. */
export async function markInboundFailed(data: unknown): Promise<void> {
  const parsed = jobSchema.safeParse(data);
  if (!parsed.success) return;
  const job = parsed.data;
  await withTenant(job.tenantId, (db) =>
    db.query(
      "UPDATE messages SET process_state = 'failed', process_state_at = now() WHERE tenant_id = $1 AND id = $2 AND process_state = 'pending'",
      [job.tenantId, job.messageId],
    ),
  );
}
EOF_SRC_LIB_QUEUE_PROCESS_TS
echo "✔ src/lib/queue/process.ts"
mkdir -p src/lib/queue
cat > src/lib/queue/sweeper.ts <<'EOF_SRC_LIB_QUEUE_SWEEPER_TS'
import { getPool } from "@/lib/db";
import { enqueueInbound, type InboundJob } from "./producer";

/**
 * Recupera mensajes que quedaron "pending" (Redis caído al llegar, trabajo perdido).
 * Reencolar es seguro: el id del trabajo es el id del mensaje.
 */
export async function sweepPending(minAgeSeconds = 60, limit = 200): Promise<number> {
  const r = await getPool().query<{ out_tenant_id: string; out_message_id: string }>(
    "SELECT out_tenant_id, out_message_id FROM queue_pending_inbound($1, $2)",
    [minAgeSeconds, limit],
  );
  const items: InboundJob[] = r.rows.map((x) => ({ tenantId: x.out_tenant_id, messageId: x.out_message_id }));
  await enqueueInbound(items);
  return items.length;
}
EOF_SRC_LIB_QUEUE_SWEEPER_TS
echo "✔ src/lib/queue/sweeper.ts"
mkdir -p src/worker
cat > src/worker/index.ts <<'EOF_SRC_WORKER_INDEX_TS'
import { Worker } from "bullmq";
import { getPool } from "@/lib/db";
import { QUEUE_NAME, createWorkerConnection, queuePrefix } from "@/lib/queue/connection";
import { closeProducer } from "@/lib/queue/producer";
import { markInboundFailed, processInbound, type InboundHandler } from "@/lib/queue/process";
import { sweepPending } from "@/lib/queue/sweeper";

/**
 * Aquí se enchufará el agente de IA (Paso 9). Por ahora solo deja constancia.
 * Importante: se registran ids, nunca el texto del mensaje ni teléfonos.
 */
const handler: InboundHandler = async ({ tenantId, messageId }) => {
  console.log(`[worker] mensaje ${messageId} (negocio ${tenantId.slice(0, 8)}…) recibido; el agente llega en el Paso 9`);
};

const CONCURRENCY = 5;
const SWEEP_EVERY_MS = 30_000;

const connection = createWorkerConnection();
const worker = new Worker(QUEUE_NAME, (job) => processInbound(job.data, handler), {
  connection,
  prefix: queuePrefix(),
  concurrency: CONCURRENCY,
});

worker.on("completed", (job, result) => {
  console.log(`[worker] trabajo ${job.id} → ${String(result)}`);
});
worker.on("failed", (job, err) => {
  if (!job) return;
  const ultimo = job.attemptsMade >= (job.opts.attempts ?? 1);
  console.error(`[worker] trabajo ${job.id} falló (intento ${job.attemptsMade}/${job.opts.attempts ?? 1}): ${err.message}`);
  if (ultimo) {
    markInboundFailed(job.data).catch((e) => console.error("[worker] no se pudo marcar como fallido:", e.message));
  }
});
worker.on("error", (err) => console.error("[worker] error:", err.message));

let sweeping = false;
async function sweep() {
  if (sweeping) return;
  sweeping = true;
  try {
    const n = await sweepPending();
    if (n > 0) console.log(`[worker] barrendero: ${n} mensajes pendientes reencolados`);
  } catch (err) {
    console.error("[worker] barrendero falló:", err instanceof Error ? err.message : err);
  } finally {
    sweeping = false;
  }
}
void sweep();
const timer = setInterval(sweep, SWEEP_EVERY_MS);

let closing = false;
async function shutdown(signal: string) {
  if (closing) return;
  closing = true;
  console.log(`[worker] ${signal}: cerrando con calma…`);
  clearInterval(timer);
  try {
    await worker.close();
    await closeProducer();
    connection.disconnect();
    await getPool().end();
  } finally {
    process.exit(0);
  }
}
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

console.log(`[worker] listo: escuchando la cola "${QUEUE_NAME}" (concurrencia ${CONCURRENCY})`);
EOF_SRC_WORKER_INDEX_TS
echo "✔ src/worker/index.ts"
mkdir -p src/lib/whatsapp
cat > src/lib/whatsapp/ingest.ts <<'EOF_SRC_LIB_WHATSAPP_INGEST_TS'
import { getPool, withTenant } from "@/lib/db";
import type { TenantBatch } from "./payload";

export interface IngestResult {
  newMessages: number;
  /** Mensajes entrantes NUEVOS que hay que encolar para el agente. */
  inbound: { tenantId: string; messageId: string }[];
  statusUpdates: number;
  unknownNumber: boolean;
}

/**
 * Guarda un lote en el negocio dueño del número. Es idempotente: si Meta
 * reintenta el mismo mensaje, el índice único (tenant_id, wa_message_id) lo descarta.
 */
export async function ingestBatch(batch: TenantBatch): Promise<IngestResult> {
  const r = await getPool().query<{ resolve_tenant_by_phone_number_id: string | null }>(
    "SELECT resolve_tenant_by_phone_number_id($1)",
    [batch.phoneNumberId],
  );
  const tenantId = r.rows[0]?.resolve_tenant_by_phone_number_id;
  // Número que no es de ningún cliente: se ignora (pero se responde 200 para que Meta no reintente).
  if (!tenantId) return { newMessages: 0, inbound: [], statusUpdates: 0, unknownNumber: true };

  return withTenant(tenantId, async (db) => {
    let newMessages = 0;
    let statusUpdates = 0;
    const inbound: { tenantId: string; messageId: string }[] = [];

    for (const m of batch.messages) {
      const contact = await db.query<{ id: string }>(
        `INSERT INTO contacts (tenant_id, wa_id, display_name) VALUES ($1, $2, $3)
         ON CONFLICT (tenant_id, wa_id)
         DO UPDATE SET display_name = COALESCE(EXCLUDED.display_name, contacts.display_name)
         RETURNING id`,
        [tenantId, m.waId, m.name],
      );
      const contactId = contact.rows[0]!.id;

      await db.query(
        `INSERT INTO conversations (tenant_id, contact_id) VALUES ($1, $2)
         ON CONFLICT (tenant_id, contact_id) WHERE status <> 'closed' DO NOTHING`,
        [tenantId, contactId],
      );
      const conv = await db.query<{ id: string }>(
        `SELECT id FROM conversations WHERE tenant_id = $1 AND contact_id = $2 AND status <> 'closed'`,
        [tenantId, contactId],
      );
      const conversationId = conv.rows[0]!.id;

      const ins = await db.query(
        `INSERT INTO messages (tenant_id, conversation_id, direction, wa_message_id, msg_type, body, created_at, process_state)
         VALUES ($1, $2, 'in', $3, $4, $5, $6, 'pending')
         ON CONFLICT (tenant_id, wa_message_id) DO NOTHING
         RETURNING id`,
        [tenantId, conversationId, m.waMessageId, m.type, m.body, m.at],
      );
      if (ins.rowCount) {
        newMessages++;
        inbound.push({ tenantId, messageId: ins.rows[0].id });
        await db.query(
          `UPDATE conversations SET last_message_at = GREATEST(COALESCE(last_message_at, $3), $3)
           WHERE tenant_id = $1 AND id = $2`,
          [tenantId, conversationId, m.at],
        );
      }
    }

    for (const s of batch.statuses) {
      // Solo avanza: sent -> delivered -> read. "failed" es final y "read" también.
      const u = await db.query(
        `UPDATE messages SET delivery_status = $3, status_at = $4
         WHERE tenant_id = $1 AND wa_message_id = $2 AND direction = 'out'
           AND (CASE COALESCE(delivery_status, '') WHEN '' THEN 0 WHEN 'sent' THEN 1 WHEN 'delivered' THEN 2 ELSE 3 END)
             < (CASE $3::text WHEN 'sent' THEN 1 WHEN 'delivered' THEN 2 WHEN 'read' THEN 3 ELSE 2 END)`,
        [tenantId, s.waMessageId, s.status, s.at],
      );
      statusUpdates += u.rowCount ?? 0;
    }
    return { newMessages, inbound, statusUpdates, unknownNumber: false };
  });
}
EOF_SRC_LIB_WHATSAPP_INGEST_TS
echo "✔ src/lib/whatsapp/ingest.ts"
mkdir -p src/app/api/webhooks/whatsapp
cat > src/app/api/webhooks/whatsapp/route.ts <<'EOF_SRC_APP_API_WEBHOOKS_WHATSAPP_ROUTE_TS'
import { getWhatsAppEnv } from "@/lib/env";
import { errorResponse, route } from "@/lib/auth/http";
import { enqueueInbound } from "@/lib/queue/producer";
import { ingestBatch } from "@/lib/whatsapp/ingest";
import { parseWebhook } from "@/lib/whatsapp/payload";
import { readRawBody, safeEqualText, verifySignature } from "@/lib/whatsapp/signature";

const MAX_BODY = 1_000_000; // 1 MB: los webhooks reales pesan unos pocos KB

const plain = (text: string, status = 200) =>
  new Response(text, {
    status,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });

/** Meta llama aquí UNA vez al registrar el webhook para comprobar que es tuyo. */
export const GET = route(async (req) => {
  const env = getWhatsAppEnv();
  const q = new URL(req.url).searchParams;
  const challenge = q.get("hub.challenge") ?? "";
  const ok =
    q.get("hub.mode") === "subscribe" &&
    safeEqualText(q.get("hub.verify_token") ?? "", env.WHATSAPP_VERIFY_TOKEN) &&
    /^[A-Za-z0-9_-]{1,200}$/.test(challenge);
  return ok ? plain(challenge) : plain("Forbidden", 403);
});

/** Mensajes y estados. Primero se comprueba la firma; sin firma válida no se toca nada. */
export const POST = route(async (req) => {
  const env = getWhatsAppEnv();
  const raw = await readRawBody(req, MAX_BODY);
  if (!raw) return errorResponse(413, "cuerpo_muy_grande", "Petición demasiado grande.");

  if (!verifySignature(raw, req.headers.get("x-hub-signature-256"), env.WHATSAPP_APP_SECRET)) {
    console.warn("[webhook] firma inválida: revisa que WHATSAPP_APP_SECRET sea el de tu app de Meta");
    return errorResponse(401, "firma_invalida", "Firma inválida.");
  }

  let json: unknown;
  try {
    json = JSON.parse(raw.toString("utf8"));
  } catch {
    return errorResponse(400, "json_invalido", "JSON inválido.");
  }
  const batches = parseWebhook(json);
  if (!batches) return plain("ignored"); // formato que no es de mensajes: 200 para que Meta no reintente

  // 1) Guardar en Postgres (fuente de verdad). Si falla, route() responde 500 y Meta reintenta;
  //    el índice único evita duplicados.
  const porEncolar: { tenantId: string; messageId: string }[] = [];
  for (const batch of batches) {
    const r = await ingestBatch(batch);
    if (r.unknownNumber) {
      console.warn(`[webhook] llegó un mensaje para el número ${batch.phoneNumberId}, que no está conectado a ningún negocio`);
    }
    porEncolar.push(...r.inbound);
  }

  // 2) Avisar al worker. Si Redis falla NO se devuelve error: el mensaje ya está guardado como
  //    "pending" y el barrendero del worker lo recupera. Devolver 500 solo haría que Meta reintente
  //    en vano (el mensaje ya existe y no se volvería a encolar).
  try {
    await enqueueInbound(porEncolar);
  } catch (err) {
    console.error(`[webhook] no se pudo encolar (${porEncolar.length} mensajes quedan pendientes):`, err instanceof Error ? err.message : err);
  }
  return plain("ok");
});
EOF_SRC_APP_API_WEBHOOKS_WHATSAPP_ROUTE_TS
echo "✔ src/app/api/webhooks/whatsapp/route.ts"
mkdir -p tests
cat > tests/queue.test.ts <<'EOF_TESTS_QUEUE_TEST_TS'
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
EOF_TESTS_QUEUE_TEST_TS
echo "✔ tests/queue.test.ts"
mkdir -p tests
cat > tests/global-setup.ts <<'EOF_TESTS_GLOBAL-SETUP_TS'
import IORedis from "ioredis";
import { loadEnv } from "vite";

// Antes de los tests: borra las claves de Redis que dejaron pruebas anteriores
// (solo las que empiezan por "test"; nunca toca la cola real "saas").
export default async function setup() {
  const url = loadEnv("test", process.cwd(), "").REDIS_URL ?? process.env.REDIS_URL;
  if (!url) return;
  const redis = new IORedis(url, { maxRetriesPerRequest: 1, connectTimeout: 2_000, lazyConnect: true });
  redis.on("error", () => {});
  try {
    await redis.connect();
    let cursor = "0";
    do {
      const [next, keys] = await redis.scan(cursor, "MATCH", "test*", "COUNT", 500);
      cursor = next;
      if (keys.length) await redis.del(...keys);
    } while (cursor !== "0");
  } catch {
    // Sin Redis los tests de cola fallarán por sí solos con un mensaje claro.
  } finally {
    redis.disconnect();
  }
}
EOF_TESTS_GLOBAL-SETUP_TS
echo "✔ tests/global-setup.ts"
cat > vitest.config.mts <<'EOF_VITEST_CONFIG_MTS'
import { fileURLToPath } from "node:url";
import { loadEnv } from "vite";
import { defineConfig } from "vitest/config";

export default defineConfig(({ mode }) => ({
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    env: { ...loadEnv(mode, process.cwd(), ""), QUEUE_PREFIX: "test" },
    globalSetup: ["tests/global-setup.ts"],
    fileParallelism: false,
    testTimeout: 20_000,
  },
}));
EOF_VITEST_CONFIG_MTS
echo "✔ vitest.config.mts"

# ---------------------------------------------------------------- dependencias
echo "→ Instalando bullmq, ioredis y tsx (versiones fijas)…"
npm install bullmq@6.3.9 ioredis@6.0.0
npm install -D tsx@4.23.14

# ------------------------------------------------- package.json, next, compose
node - <<'NODE_EOF'
const fs = require("fs");

// package.json: scripts nuevos
const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
pkg.scripts.worker = "tsx --env-file=.env.local src/worker/index.ts";
pkg.scripts["db:up"] = "docker compose --env-file .env.local up -d db redis";
fs.writeFileSync("package.json", JSON.stringify(pkg, null, 2) + "\n");
console.log("✔ package.json (scripts worker y db:up)");

// next.config.ts: no empaquetar bullmq/ioredis
let nc = fs.readFileSync("next.config.ts", "utf8");
if (!nc.includes("serverExternalPackages")) {
  if (!nc.includes("cacheComponents: true,")) { console.log("⚠ next.config.ts: añade a mano  serverExternalPackages: [\"bullmq\", \"ioredis\"],"); }
  else {
    nc = nc.replace("  cacheComponents: true,", () => "  cacheComponents: true,\n  // Estos paquetes cargan archivos propios (scripts Lua): no deben empaquetarse.\n  serverExternalPackages: [\"bullmq\", \"ioredis\"],");
    fs.writeFileSync("next.config.ts", nc);
    console.log("✔ next.config.ts");
  }
} else console.log("• next.config.ts ya estaba listo");

// docker-compose.yml: servicio redis
let dc = fs.readFileSync("docker-compose.yml", "utf8");
if (!dc.includes("saas-redis")) {
  const redis = `
  redis:
    image: redis:7.4-alpine
    container_name: saas-redis
    restart: unless-stopped
    environment:
      REDIS_PASSWORD: \${REDIS_PASSWORD:?falta REDIS_PASSWORD en .env.local}
      REDISCLI_AUTH: \${REDIS_PASSWORD}
    # La contraseña se lee de una variable de entorno (no queda en la lista de procesos).
    # noeviction: BullMQ exige que Redis nunca borre claves por falta de memoria.
    # appendonly: los trabajos pendientes sobreviven a un reinicio.
    command:
      - sh
      - -c
      - exec redis-server --requirepass "$$REDIS_PASSWORD" --appendonly yes --maxmemory 256mb --maxmemory-policy noeviction
    ports:
      - "127.0.0.1:6379:6379"
    volumes:
      - saas_redisdata:/data
    healthcheck:
      test: ["CMD-SHELL", "redis-cli ping | grep -q PONG"]
      interval: 5s
      timeout: 3s
      retries: 20
    security_opt:
      - no-new-privileges:true
`;
  if (!/\nvolumes:\n  saas_pgdata:/.test(dc)) { console.log("⚠ docker-compose.yml: formato inesperado; avísame y lo ajusto"); process.exit(1); }
  dc = dc.replace("\nvolumes:\n  saas_pgdata:", () => redis + "\nvolumes:\n  saas_pgdata:\n  saas_redisdata:");
  fs.writeFileSync("docker-compose.yml", dc);
  console.log("✔ docker-compose.yml (servicio redis)");
} else console.log("• docker-compose.yml ya tenía redis");

// scripts/gen-local-env.sh: que los entornos nuevos también generen la clave de Redis
if (fs.existsSync("scripts/gen-local-env.sh")) {
  let g = fs.readFileSync("scripts/gen-local-env.sh", "utf8");
  if (!g.includes("REDIS_PASSWORD")) {
    g = g.replace("KEY=$(openssl rand -base64 32)\n", () => "KEY=$(openssl rand -base64 32)\nREDISPW=$(openssl rand -hex 24)\n");
    g = g.replace("sed -i '/^DATABASE_URL=/d' \"$FILE\"\n", () => "sed -i '/^DATABASE_URL=/d' \"$FILE\"\nsed -i '/^REDIS_URL=/d' \"$FILE\"\n");
    g = g.replace("ENCRYPTION_CURRENT_VERSION=1\nEOT", () => "ENCRYPTION_CURRENT_VERSION=1\nREDIS_PASSWORD=$REDISPW\nREDIS_URL=redis://:$REDISPW@127.0.0.1:6379\nEOT");
    fs.writeFileSync("scripts/gen-local-env.sh", g);
    console.log("✔ scripts/gen-local-env.sh");
  }
}
NODE_EOF

# ------------------------------------------------------------------ .env.local
if [ ! -f .env.local ]; then echo "✖ No existe .env.local"; exit 1; fi
if ! grep -q '^REDIS_PASSWORD=' .env.local; then
  PW=$(openssl rand -hex 24)
  sed -i '/^REDIS_URL=/d' .env.local
  printf '\n# --- Redis (Paso 7) ---\nREDIS_PASSWORD=%s\nREDIS_URL=redis://:%s@127.0.0.1:6379\n' "$PW" "$PW" >> .env.local
  echo "✔ .env.local: REDIS_PASSWORD y REDIS_URL generados"
else
  echo "• .env.local ya tenía REDIS_PASSWORD"
fi
if [ -f .env.example ] && ! grep -q 'REDIS_PASSWORD' .env.example; then
  printf '\n# Redis (Paso 7): lo genera scripts/gen-local-env.sh\nREDIS_PASSWORD=\n' >> .env.example
fi

# ---------------------------------------------------------------------- CI
if [ -f .github/workflows/ci.yml ]; then
node - <<'NODE_EOF'
const fs = require("fs");
const p = ".github/workflows/ci.yml";
let y = fs.readFileSync(p, "utf8");
if (/^\s*redis:\s*$/m.test(y)) { console.log("• ci.yml ya tenía redis"); process.exit(0); }
const m = y.match(/^(\s*)services:\s*$/m);
if (!m) {
  console.log("⚠ ci.yml: no encontré el bloque 'services:'. Añade a mano, dentro del trabajo que corre los tests:\n" +
`    services:
      redis:
        image: redis:7.4-alpine
        ports:
          - 6379:6379
        options: >-
          --health-cmd "redis-cli ping" --health-interval 5s --health-timeout 3s --health-retries 20`);
  process.exit(0);
}
const i = m[1];
const block = [
  `${i}  redis:`,
  `${i}    image: redis:7.4-alpine`,
  `${i}    ports:`,
  `${i}      - 6379:6379`,
  `${i}    options: >-`,
  `${i}      --health-cmd "redis-cli ping" --health-interval 5s --health-timeout 3s --health-retries 20`,
].join("\n");
y = y.replace(m[0], () => m[0] + "\n" + block);
fs.writeFileSync(p, y);
console.log("✔ .github/workflows/ci.yml (servicio redis). Comprueba que REDIS_URL en el CI sea redis://127.0.0.1:6379");
NODE_EOF
fi

cat <<'FIN'

══════════════════════════════════════════════════════════
 Paso 7 aplicado. Ahora, en este orden:

   1) npm run db:up          # levanta Postgres y Redis
   2) npm run db:migrate     # aplica 0005_cola.sql
   3) npm run typecheck && npm run lint && npm test
   4) En una terminal:  npm run dev
      En OTRA terminal: npm run worker
══════════════════════════════════════════════════════════
FIN