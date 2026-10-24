import { getPool } from "@/lib/db";
import { jsonResponse, route } from "@/lib/auth/http";
import { createProducerConnection } from "@/lib/queue/connection";

const withTimeout = <T,>(p: Promise<T>, ms: number): Promise<T> =>
  Promise.race([p, new Promise<never>((_, rej) => setTimeout(() => rej(new Error("tiempo agotado")), ms))]);

/**
 * Estado del servicio, para el healthcheck de Docker y para monitores de disponibilidad.
 * Público a propósito, pero NO revela nada: solo "ok" o "degraded" (y el código HTTP 200 / 503).
 */
export const GET = route(async () => {
  let db = false;
  let redis = false;
  try {
    await withTimeout(getPool().query("SELECT 1"), 3_000);
    db = true;
  } catch { /* se informa como degradado */ }
  const conn = createProducerConnection();
  try {
    redis = (await withTimeout(conn.ping(), 3_000)) === "PONG";
  } catch { /* idem */ } finally {
    conn.disconnect();
  }
  const ok = db && redis;
  return jsonResponse({ status: ok ? "ok" : "degraded" }, ok ? 200 : 503);
});
