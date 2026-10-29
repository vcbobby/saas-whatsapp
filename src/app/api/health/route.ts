import { timingSafeEqual } from "node:crypto";
import { getPool } from "@/lib/db";
import { jsonResponse, route } from "@/lib/auth/http";
import { createProducerConnection } from "@/lib/queue/connection";
import { HEARTBEAT_STALE_MS, readHeartbeatAge } from "@/lib/queue/heartbeat";

const withTimeout = <T,>(p: Promise<T>, ms: number): Promise<T> =>
  Promise.race([p, new Promise<never>((_, rej) => setTimeout(() => rej(new Error("tiempo agotado")), ms))]);

/** El detalle solo se entrega con HEALTH_TOKEN configurado (mínimo 16 caracteres) y enviado en la cabecera «x-health-token». */
function detailAllowed(req: Request): boolean {
  const expected = process.env.HEALTH_TOKEN ?? "";
  if (expected.length < 16) return false;
  const got = req.headers.get("x-health-token") ?? "";
  const a = Buffer.from(got);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Estado del servicio, para el healthcheck de Docker y para monitores de disponibilidad.
 * Público a propósito, pero NO revela nada: solo "ok" o "degraded" (y el código HTTP 200 / 503), según base de datos y Redis.
 * Con el token correcto añade el desglose (base de datos, Redis y worker). Ahí, un worker caído también da 503.
 * (El healthcheck de Docker usa la versión pública: un worker caído nunca debe tumbar la web.)
 */
export const GET = route(async (req: Request) => {
  let db = false;
  let redis = false;
  let workerAge: number | null = null;
  try {
    await withTimeout(getPool().query("SELECT 1"), 3_000);
    db = true;
  } catch { /* se informa como degradado */ }
  const conn = createProducerConnection();
  try {
    redis = (await withTimeout(conn.ping(), 3_000)) === "PONG";
    if (redis) workerAge = await withTimeout(readHeartbeatAge(conn), 3_000);
  } catch { /* idem */ } finally {
    conn.disconnect();
  }
  const ok = db && redis;
  if (detailAllowed(req)) {
    const worker = workerAge !== null && workerAge <= HEARTBEAT_STALE_MS;
    const all = ok && worker;
    return jsonResponse(
      {
        status: all ? "ok" : "degraded",
        db: db ? "ok" : "caido",
        redis: redis ? "ok" : "caido",
        worker: worker ? "ok" : "caido",
        workerLatidoHaceSeg: workerAge === null ? null : Math.round(workerAge / 1000),
      },
      all ? 200 : 503,
    );
  }
  return jsonResponse({ status: ok ? "ok" : "degraded" }, ok ? 200 : 503);
});
