import type IORedis from "ioredis";
import { queuePrefix } from "./connection";

/**
 * Latido del worker: cada pocos segundos escribe la hora en Redis con una caducidad corta.
 * Si el worker se cae o se cuelga, la clave desaparece y la salud detallada lo marca (sin él no hay respuestas de IA,
 * ni correos, ni avisos, ni recordatorios).
 */
export const HEARTBEAT_EVERY_MS = 15_000;
export const HEARTBEAT_TTL_S = 60;
/** Más viejo que esto se considera caído (cuatro latidos perdidos). */
export const HEARTBEAT_STALE_MS = 60_000;

export function heartbeatKey(): string {
  return `${queuePrefix()}:worker:heartbeat`;
}

export async function writeHeartbeat(conn: IORedis, now = Date.now()): Promise<void> {
  await conn.set(heartbeatKey(), String(now), "EX", HEARTBEAT_TTL_S);
}

/** Edad del último latido en ms, o null si no hay (worker apagado, caído o nunca arrancó). */
export async function readHeartbeatAge(conn: IORedis, now = Date.now()): Promise<number | null> {
  const raw = await conn.get(heartbeatKey());
  if (!raw) return null;
  const t = Number(raw);
  if (!Number.isFinite(t)) return null;
  return Math.max(0, now - t);
}
