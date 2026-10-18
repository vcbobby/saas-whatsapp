import { randomUUID } from "node:crypto";
import { z } from "zod";
import { requireTenant } from "@/lib/auth/guard";
import { checkOrigin, errorResponse, jsonResponse, readJson, route } from "@/lib/auth/http";
import { withTenant } from "@/lib/db";
import { WEBHOOK_EVENTS, MAX_ENDPOINTS } from "@/lib/webhooks/events";
import { resolveTarget } from "@/lib/webhooks/guard";
import { displayUrl, newSecret, sealSecret } from "@/lib/webhooks/service";

export const createSchema = z.object({
  url: z.string().trim().min(10, "Escribe la dirección de destino").max(2000, "La dirección es demasiado larga"),
  description: z.string().trim().max(120, "Máximo 120 caracteres").optional(),
  events: z.array(z.enum(WEBHOOK_EVENTS)).min(1, "Elige al menos un aviso").max(WEBHOOK_EVENTS.length).transform((a) => [...new Set(a)]),
});

/** Conexiones del negocio y su registro de envíos recientes. Nunca devuelve secretos. */
export const GET = route(async (req) => {
  const auth = await requireTenant(req, "integrations:manage", "automatizaciones");
  if (!auth.ok) return auth.response;
  const { tenantId } = auth.ctx;
  const data = await withTenant(tenantId, async (db) => {
    const eps = await db.query(
      `SELECT e.id, e.url, e.description, e.events, e.active, e.consecutive_failures, e.disabled_reason, e.created_at,
              (SELECT count(*)::int FROM webhook_deliveries d WHERE d.tenant_id = e.tenant_id AND d.endpoint_id = e.id AND d.status = 'pendiente') AS pending
         FROM webhook_endpoints e WHERE e.tenant_id = $1 ORDER BY e.created_at`,
      [tenantId],
    );
    const dels = await db.query(
      `SELECT id, endpoint_id, event_type, status, attempts, last_status, last_error, created_at, finished_at
         FROM webhook_deliveries WHERE tenant_id = $1 ORDER BY created_at DESC, id LIMIT 50`,
      [tenantId],
    );
    return { eps: eps.rows, dels: dels.rows };
  });
  return jsonResponse({
    max: MAX_ENDPOINTS,
    endpoints: data.eps.map((e) => ({ id: e.id, url: displayUrl(e.url), description: e.description, events: e.events, active: e.active, consecutiveFailures: e.consecutive_failures, disabledReason: e.disabled_reason, createdAt: e.created_at, pending: e.pending })),
    deliveries: data.dels.map((d) => ({ id: d.id, endpointId: d.endpoint_id, eventType: d.event_type, status: d.status, attempts: d.attempts, lastStatus: d.last_status, lastError: d.last_error, createdAt: d.created_at, finishedAt: d.finished_at })),
  });
});

/** Crea una conexión. El secreto de firma se devuelve SOLO en esta respuesta. */
export const POST = route(async (req) => {
  const blocked = checkOrigin(req);
  if (blocked) return blocked;
  const auth = await requireTenant(req, "integrations:manage", "automatizaciones");
  if (!auth.ok) return auth.response;
  const body = await readJson(req, createSchema);
  if (!body.ok) return body.response;
  const { tenantId } = auth.ctx;
  const d = body.data;

  const check = await resolveTarget(d.url);
  if (!check.ok) return errorResponse(422, "destino_no_permitido", check.reason, { fields: ["url"] });

  const id = randomUUID();
  const secret = newSecret();
  const sealed = sealSecret(secret, tenantId, id);
  try {
    await withTenant(tenantId, async (db) => {
      await db.query(
        "INSERT INTO webhook_endpoints (id, tenant_id, url, description, events, secret_enc, key_version, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)",
        [id, tenantId, check.target.url.toString(), d.description || null, d.events, sealed.secretEnc, sealed.keyVersion, auth.session.userId],
      );
      await db.query("INSERT INTO audit_log (tenant_id, actor_id, action, target_type, metadata) VALUES ($1,$2,'webhook.created','webhook',$3)", [tenantId, auth.session.userId, JSON.stringify({ endpointId: id, host: check.target.url.host, events: d.events })]);
    });
  } catch (e) {
    if ((e as { code?: string }).code === "23514") return errorResponse(409, "limite_conexiones", `Llegaste al máximo de ${MAX_ENDPOINTS} conexiones. Borra una para crear otra.`);
    throw e;
  }
  return jsonResponse({ id, secret }, 201);
});
