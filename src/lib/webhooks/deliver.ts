import { brand } from "@/config/brand";
import { decryptSecret } from "@/lib/crypto";
import { getPool, withTenant } from "@/lib/db";
import { type AppKind, isSealed } from "@/lib/connections/apps";
import { buildAppRequest, friendlyAppError, openConfig } from "@/lib/connections/request";
import { resolveTarget, type Target, type TargetCheck } from "./guard";
import { sendWebhook, type SendResult } from "./send";
import { signBody } from "./sign";

/** Segundos de espera tras el intento n (1, 2, …). Total: 6 intentos en unas 8 horas. */
export const BACKOFF_SECONDS = [60, 300, 1_800, 7_200, 21_600] as const;
export const MAX_ATTEMPTS = BACKOFF_SECONDS.length + 1;
/** Entregas seguidas que se rinden sin éxito antes de desactivar la conexión. */
export const DISABLE_AFTER = 10;
const LOCK_SECONDS = 60;
const RETENTION_DAYS = 14;

export const aadFor = (tenantId: string, endpointId: string) => `wh:${tenantId}:${endpointId}`;

export interface DeliverDeps {
  send?: (target: Target, headers: Record<string, string>, body: string) => Promise<SendResult>;
  resolve?: (url: string) => Promise<TargetCheck>;
  nowSec?: () => number;
}
export type DeliverOutcome = "delivered" | "retry" | "failed" | "skipped";

/** Entrega UNA ya tomada de la cola. Seguro si se repite: solo actúa sobre entregas pendientes. */
export async function deliverOne(tenantId: string, deliveryId: string, deps: DeliverDeps = {}): Promise<DeliverOutcome> {
  const loaded = await withTenant(tenantId, async (db) => {
    const r = await db.query(
      `UPDATE webhook_deliveries d SET attempts = d.attempts + 1
         FROM webhook_endpoints e
        WHERE d.tenant_id = $1 AND d.id = $2 AND d.status = 'pendiente' AND e.tenant_id = d.tenant_id AND e.id = d.endpoint_id
        RETURNING d.id, d.endpoint_id, d.event_id, d.event_type, d.payload, d.attempts, e.url, e.secret_enc, e.key_version, e.active, e.kind, e.app_config_enc, e.app_key_version`,
      [tenantId, deliveryId],
    );
    if (r.rowCount === 0) await db.query("SELECT webhook_queue_set($1, NULL)", [deliveryId]); // ya no hay nada que enviar
    return r.rows[0] as { endpoint_id: string; event_id: string; event_type: string; payload: unknown; attempts: number; url: string; secret_enc: string; key_version: number; active: boolean; kind: AppKind; app_config_enc: string | null; app_key_version: number | null } | undefined;
  });
  if (!loaded) return "skipped";

  const finish = (result: SendResult | { ok: false; status: null; error: string }) =>
    withTenant(tenantId, async (db) => {
      const attempts = loaded.attempts;
      const error = result.ok ? null : (result.error ?? "Falló el envío").slice(0, 300);
      if (result.ok) {
        await db.query("UPDATE webhook_deliveries SET status = 'entregado', finished_at = now(), last_status = $3, last_error = NULL WHERE tenant_id = $1 AND id = $2", [tenantId, deliveryId, result.status]);
        await db.query("UPDATE webhook_endpoints SET consecutive_failures = 0 WHERE tenant_id = $1 AND id = $2 AND consecutive_failures <> 0", [tenantId, loaded.endpoint_id]);
        await db.query("SELECT webhook_queue_set($1, NULL)", [deliveryId]);
        await purge(db, tenantId);
        return "delivered" as const;
      }
      if (attempts < MAX_ATTEMPTS && loaded.active) {
        await db.query("UPDATE webhook_deliveries SET last_status = $3, last_error = $4 WHERE tenant_id = $1 AND id = $2", [tenantId, deliveryId, result.status, error]);
        await db.query("SELECT webhook_queue_set($1, now() + make_interval(secs => $2))", [deliveryId, BACKOFF_SECONDS[attempts - 1]]);
        return "retry" as const;
      }
      // Se rindió: entrega fallida; la conexión cuenta una falla más y, si son demasiadas seguidas, se desactiva.
      await db.query("UPDATE webhook_deliveries SET status = 'fallido', finished_at = now(), last_status = $3, last_error = $4 WHERE tenant_id = $1 AND id = $2", [tenantId, deliveryId, result.status, error]);
      await db.query("SELECT webhook_queue_set($1, NULL)", [deliveryId]);
      const ep = await db.query(
        "UPDATE webhook_endpoints SET consecutive_failures = consecutive_failures + 1 WHERE tenant_id = $1 AND id = $2 RETURNING consecutive_failures, active, description, url",
        [tenantId, loaded.endpoint_id],
      );
      const e = ep.rows[0];
      if (e && e.active && e.consecutive_failures >= DISABLE_AFTER) {
        await db.query("UPDATE webhook_endpoints SET active = false, disabled_reason = $3, updated_at = now() WHERE tenant_id = $1 AND id = $2", [tenantId, loaded.endpoint_id, `Se desactivó tras ${DISABLE_AFTER} avisos fallidos seguidos.`]);
        // Que una persona se entere: queda una tarea en «Hoy».
        const name = String(e.description || safeHost(e.url)).slice(0, 80);
        await db.query(
          `INSERT INTO work_items (tenant_id, type, priority, title, detail, source, dedupe_key)
           VALUES ($1, 'tarea', 1, $2, $3, 'sistema', $4) ON CONFLICT DO NOTHING`,
          [tenantId, `Se desactivó la conexión «${name}»`, `Falló ${DISABLE_AFTER} veces seguidas. Revisa que tu sistema esté funcionando y vuelve a activarla en Conexiones.`, `webhook-off:${loaded.endpoint_id}`],
        );
      }
      await purge(db, tenantId);
      return "failed" as const;
    });

  if (!loaded.active) return finish({ ok: false, status: null, error: "La conexión está desactivada" });
  if (loaded.attempts > MAX_ATTEMPTS) return finish({ ok: false, status: null, error: "Se agotaron los intentos" });

  // Conexiones a una app (Telegram, Discord, Slack): el enlace y el token salen del almacén cifrado y el mensaje se arma en español.
  if (isSealed(loaded.kind)) {
    let built: ReturnType<typeof buildAppRequest>;
    try {
      if (!loaded.app_config_enc || loaded.app_key_version === null) throw new Error("sin datos");
      built = buildAppRequest(loaded.kind, openConfig(loaded.app_config_enc, loaded.app_key_version, tenantId, loaded.endpoint_id), loaded.event_type, loaded.payload);
    } catch { return finish({ ok: false, status: null, error: "No se pudieron leer los datos de la conexión. Vuelve a conectar la app." }); }
    if (!built.ok) return finish({ ok: false, status: null, error: built.reason });
    const chk = await (deps.resolve ?? ((u: string) => resolveTarget(u)))(built.req.url);
    if (!chk.ok) return finish({ ok: false, status: null, error: chk.reason });
    const r = await (deps.send ?? sendWebhook)(chk.target, { ...built.req.headers, "user-agent": `${brand.name.replace(/[^\w .-]/g, "")}-Avisos/1` }, built.req.body);
    return finish(r.ok ? r : { ...r, error: friendlyAppError(loaded.kind, r.status, r.error) });
  }

  let secret: string;
  try { secret = decryptSecret(loaded.secret_enc, aadFor(tenantId, loaded.endpoint_id), loaded.key_version); }
  catch { return finish({ ok: false, status: null, error: "No se pudo leer el secreto de la conexión" }); }

  const check = await (deps.resolve ?? ((u: string) => resolveTarget(u)))(loaded.url);
  if (!check.ok) return finish({ ok: false, status: null, error: check.reason });

  const body = JSON.stringify(loaded.payload);
  const t = (deps.nowSec ?? (() => Math.floor(Date.now() / 1000)))();
  const headers = {
    "content-type": "application/json",
    "user-agent": `${brand.name.replace(/[^\w .-]/g, "")}-Webhooks/1`,
    "x-webhook-id": loaded.event_id,
    "x-webhook-event": loaded.event_type,
    "x-webhook-attempt": String(loaded.attempts),
    "x-webhook-signature": signBody(secret, t, body),
  };
  const res = await (deps.send ?? sendWebhook)(check.target, headers, body);
  return finish(res);
}

type Db = Pick<import("pg").PoolClient, "query">;
async function purge(db: Db, tenantId: string) {
  await db.query(
    `DELETE FROM webhook_deliveries WHERE ctid IN (
       SELECT ctid FROM webhook_deliveries WHERE tenant_id = $1 AND status <> 'pendiente' AND finished_at < now() - make_interval(days => $2) LIMIT 500)`,
    [tenantId, RETENTION_DAYS],
  );
}
function safeHost(u: string) { try { return new URL(u).hostname; } catch { return "sin nombre"; } }

/** Toma hasta `max` entregas vencidas de la cola y las envía a la vez. Devuelve cuántas se procesaron. */
export async function deliverDue(max = 5, deps: DeliverDeps = {}): Promise<Record<DeliverOutcome, number>> {
  const claimed = await getPool().query<{ out_tenant_id: string; out_delivery_id: string }>("SELECT out_tenant_id, out_delivery_id FROM webhook_claim($1, $2)", [max, LOCK_SECONDS]);
  const counts: Record<DeliverOutcome, number> = { delivered: 0, retry: 0, failed: 0, skipped: 0 };
  await Promise.all(
    claimed.rows.map(async (c) => {
      try {
        counts[await deliverOne(c.out_tenant_id, c.out_delivery_id, deps)]++;
      } catch (err) {
        // Sin resultado: la entrega sigue bloqueada un minuto y se reintenta sola.
        console.error("[webhooks] error inesperado:", err instanceof Error ? err.message : err);
      }
    }),
  );
  return counts;
}
