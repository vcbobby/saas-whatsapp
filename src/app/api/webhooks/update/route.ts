import { randomUUID } from "node:crypto";
import { z } from "zod";
import { requireTenant } from "@/lib/auth/guard";
import { checkOrigin, errorResponse, jsonResponse, readJson, route } from "@/lib/auth/http";
import { withTenant } from "@/lib/db";
import { TEST_EVENT, WEBHOOK_EVENTS } from "@/lib/webhooks/events";
import { resolveTarget } from "@/lib/webhooks/guard";
import { newSecret, sealSecret } from "@/lib/webhooks/service";

const url = z.string().trim().min(10, "Escribe la dirección de destino").max(2000);
const events = z.array(z.enum(WEBHOOK_EVENTS)).min(1, "Elige al menos un aviso").max(WEBHOOK_EVENTS.length).transform((a) => [...new Set(a)]);
const schema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("toggle"), id: z.uuid(), active: z.boolean() }),
  z.object({ action: z.literal("edit"), id: z.uuid(), url: url.optional(), description: z.string().trim().max(120).nullable().optional(), events: events.optional() }),
  z.object({ action: z.literal("rotate"), id: z.uuid() }),
  z.object({ action: z.literal("delete"), id: z.uuid() }),
  z.object({ action: z.literal("test"), id: z.uuid() }),
  z.object({ action: z.literal("retry"), deliveryId: z.uuid() }),
]);

/** Cambios sobre una conexión: activar/desactivar, editar, rotar el secreto, borrar, enviar prueba y reintentar un envío fallido. */
export const POST = route(async (req) => {
  const blocked = checkOrigin(req);
  if (blocked) return blocked;
  const auth = await requireTenant(req, "integrations:manage", "automatizaciones");
  if (!auth.ok) return auth.response;
  const body = await readJson(req, schema);
  if (!body.ok) return body.response;
  const { tenantId } = auth.ctx;
  const actor = auth.session.userId;
  const d = body.data;
  const audit = (db: { query: (q: string, p: unknown[]) => Promise<unknown> }, action: string, meta: Record<string, unknown>) =>
    db.query("INSERT INTO audit_log (tenant_id, actor_id, action, target_type, metadata) VALUES ($1,$2,$3,'webhook',$4)", [tenantId, actor, action, JSON.stringify(meta)]);
  const notFound = () => errorResponse(404, "no_existe", "Esa conexión ya no existe.");

  if (d.action === "retry") {
    const r = await withTenant(tenantId, async (db) => {
      const x = await db.query(
        `UPDATE webhook_deliveries d SET status = 'pendiente', attempts = 0, finished_at = NULL, last_error = NULL
           FROM webhook_endpoints e WHERE d.tenant_id = $1 AND d.id = $2 AND d.status = 'fallido' AND e.tenant_id = d.tenant_id AND e.id = d.endpoint_id AND e.active
         RETURNING d.id`,
        [tenantId, d.deliveryId],
      );
      if (x.rowCount === 1) await audit(db, "webhook.retry", { deliveryId: d.deliveryId });
      return x.rowCount === 1;
    });
    return r ? jsonResponse({ ok: true }) : errorResponse(409, "no_se_puede_reintentar", "Solo se pueden reintentar envíos fallidos de conexiones activas.");
  }

  if (d.action === "edit" && d.url !== undefined) {
    const check = await resolveTarget(d.url);
    if (!check.ok) return errorResponse(422, "destino_no_permitido", check.reason, { fields: ["url"] });
    d.url = check.target.url.toString();
  }

  const out = await withTenant(tenantId, async (db) => {
    const cur = await db.query("SELECT id, active FROM webhook_endpoints WHERE tenant_id = $1 AND id = $2 FOR UPDATE", [tenantId, d.id]);
    if (cur.rowCount !== 1) return { kind: "none" as const };
    switch (d.action) {
      case "toggle":
        await db.query(
          "UPDATE webhook_endpoints SET active = $3, consecutive_failures = CASE WHEN $3 THEN 0 ELSE consecutive_failures END, disabled_reason = CASE WHEN $3 THEN NULL ELSE 'Desactivada por una persona.' END, updated_at = now() WHERE tenant_id = $1 AND id = $2",
          [tenantId, d.id, d.active],
        );
        if (d.active) await db.query("UPDATE work_items SET status = 'resuelto', resolved_at = now(), resolved_by = $3, updated_at = now() WHERE tenant_id = $1 AND dedupe_key = $2 AND status IN ('abierto', 'en_proceso')", [tenantId, `webhook-off:${d.id}`, actor]);
        await audit(db, "webhook.toggled", { endpointId: d.id, active: d.active });
        return { kind: "ok" as const };
      case "edit": {
        await db.query(
          `UPDATE webhook_endpoints SET url = COALESCE($3, url), description = CASE WHEN $4::boolean THEN $5 ELSE description END, events = COALESCE($6, events), updated_at = now() WHERE tenant_id = $1 AND id = $2`,
          [tenantId, d.id, d.url ?? null, d.description !== undefined, d.description ?? null, d.events ?? null],
        );
        await audit(db, "webhook.updated", { endpointId: d.id, url: d.url !== undefined, events: d.events ?? null });
        return { kind: "ok" as const };
      }
      case "rotate": {
        const secret = newSecret();
        const sealed = sealSecret(secret, tenantId, d.id);
        await db.query("UPDATE webhook_endpoints SET secret_enc = $3, key_version = $4, updated_at = now() WHERE tenant_id = $1 AND id = $2", [tenantId, d.id, sealed.secretEnc, sealed.keyVersion]);
        await audit(db, "webhook.rotated", { endpointId: d.id });
        return { kind: "ok" as const, secret };
      }
      case "delete":
        await db.query("DELETE FROM webhook_endpoints WHERE tenant_id = $1 AND id = $2", [tenantId, d.id]);
        await audit(db, "webhook.deleted", { endpointId: d.id });
        return { kind: "ok" as const };
      case "test": {
        if (!cur.rows[0].active) return { kind: "inactive" as const };
        const eventId = randomUUID();
        const payload = { id: eventId, type: TEST_EVENT, api_version: "2026-10-01", created_at: new Date().toISOString().replace(/\.\d+Z$/, "Z"), data: { message: "Prueba de conexión" } };
        await db.query("INSERT INTO webhook_deliveries (tenant_id, endpoint_id, event_id, event_type, payload) VALUES ($1,$2,$3,$4,$5)", [tenantId, d.id, eventId, TEST_EVENT, JSON.stringify(payload)]);
        await audit(db, "webhook.test", { endpointId: d.id });
        return { kind: "ok" as const };
      }
    }
  });
  if (out.kind === "none") return notFound();
  if (out.kind === "inactive") return errorResponse(409, "conexion_desactivada", "Activa la conexión para enviar una prueba.");
  return jsonResponse("secret" in out ? { ok: true, secret: out.secret } : { ok: true });
});
