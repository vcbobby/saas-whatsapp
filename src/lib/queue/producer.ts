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
