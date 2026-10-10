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
