import { randomUUID } from "node:crypto";
import IORedis from "ioredis";
import { getEnv } from "@/lib/env";
import { queuePrefix } from "./connection";

/** El candado está ocupado: BullMQ reintentará el trabajo más tarde. */
export class LockBusyError extends Error {
  constructor() {
    super("La conversación está siendo atendida por otro proceso");
    this.name = "LockBusyError";
  }
}

const globalRef = globalThis as unknown as { __lockRedis?: IORedis };

function client(): IORedis {
  if (!globalRef.__lockRedis) {
    const c = new IORedis(getEnv().REDIS_URL, { maxRetriesPerRequest: 2, connectTimeout: 3_000, commandTimeout: 3_000 });
    c.on("error", (err) => console.error("[cola] Redis (candado):", err.message));
    globalRef.__lockRedis = c;
  }
  return globalRef.__lockRedis;
}

export async function closeLockClient(): Promise<void> {
  const c = globalRef.__lockRedis;
  globalRef.__lockRedis = undefined;
  if (c) c.disconnect();
}

// Borra la clave solo si el valor sigue siendo el nuestro (otro proceso pudo tomarla si expiró).
const RELEASE = `if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) else return 0 end`;

/**
 * Una sola ejecución a la vez por clave. Vence sola a los `ttlMs` por si el proceso muere.
 * Si el trabajo dura más que el TTL, el candado ya no protege: por eso el TTL es mayor que
 * cualquier espera interna (IA 30 s + envío 10 s).
 */
export async function withLock<T>(key: string, ttlMs: number, fn: () => Promise<T>): Promise<T> {
  if (!/^[A-Za-z0-9:_-]{1,100}$/.test(key)) throw new Error("Clave de candado inválida");
  const full = `${queuePrefix()}:lock:${key}`;
  const token = randomUUID();
  const redis = client();
  const ok = await redis.set(full, token, "PX", ttlMs, "NX");
  if (ok !== "OK") throw new LockBusyError();
  try {
    return await fn();
  } finally {
    await redis.eval(RELEASE, 1, full, token).catch(() => {});
  }
}
