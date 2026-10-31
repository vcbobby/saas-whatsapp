import { z } from "zod";
import { requireTenant } from "@/lib/auth/guard";
import { checkOrigin, errorResponse, jsonResponse, readJson, route } from "@/lib/auth/http";
import { withTenant } from "@/lib/db";
import { MAX_RECIPIENTS, audienceSchema, eligibleIds } from "@/lib/broadcasts/audience";
import { templateProblem } from "@/lib/broadcasts/template";

const schema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("start"), id: z.uuid(), confirmConsent: z.literal(true, { error: "Confirma que estas personas aceptaron recibir promociones." }) }),
  z.object({ action: z.literal("pause"), id: z.uuid() }),
  z.object({ action: z.literal("resume"), id: z.uuid() }),
  z.object({ action: z.literal("cancel"), id: z.uuid() }),
  z.object({ action: z.literal("delete"), id: z.uuid() }),
]);

/** Iniciar el envío, pausarlo, reanudarlo, cancelarlo o borrar un borrador. */
export const POST = route(async (req) => {
  const blocked = checkOrigin(req);
  if (blocked) return blocked;
  const auth = await requireTenant(req, "broadcasts:manage");
  if (!auth.ok) return auth.response;
  const body = await readJson(req, schema);
  if (!body.ok) return body.response;
  const { tenantId } = auth.ctx;
  const d = body.data;
  const me = auth.session.userId;

  const out = await withTenant(tenantId, async (db) => {
    const b = (await db.query<{ status: string; template_name: string; template_language: string; params: unknown[]; audience: unknown }>(
      "SELECT status, template_name, template_language, params, audience FROM broadcasts WHERE tenant_id = $1 AND id = $2 FOR UPDATE", [tenantId, d.id])).rows[0];
    if (!b) return { err: [404, "no_encontrado", "No encontrado."] as const };
    const audit = (action: string, meta: object = {}) => db.query("INSERT INTO audit_log (tenant_id, actor_id, action, target_type, target_id, metadata) VALUES ($1, $2, $3, 'broadcast', $4, $5::jsonb)", [tenantId, me, action, d.id, JSON.stringify(meta)]);
    const bad = (code: string, text: string) => ({ err: [409, code, text] as const });
    switch (d.action) {
      case "start": {
        if (b.status !== "borrador") return bad("estado_invalido", "Esta difusión ya empezó.");
        const t = (await db.query<{ body: string; status: string; sendable: boolean }>("SELECT body, status, sendable FROM whatsapp_templates WHERE tenant_id = $1 AND name = $2 AND language = $3", [tenantId, b.template_name, b.template_language])).rows[0];
        const problem = templateProblem(t, b.params);
        if (problem) return bad("plantilla_invalida", problem);
        if ((await db.query("SELECT 1 FROM tenant_integrations WHERE tenant_id = $1 AND provider = 'whatsapp'", [tenantId])).rowCount !== 1) return bad("sin_whatsapp", "Primero conecta tu número de WhatsApp.");
        const ids = await eligibleIds(db, tenantId, audienceSchema.parse(b.audience));
        if (ids.length === 0) return bad("sin_destinatarios", "Nadie cumple las condiciones ahora mismo (permiso registrado, sin baja y sin atención personal). Revisa la vista previa.");
        if (ids.length > MAX_RECIPIENTS) return bad("demasiados", `Son más de ${MAX_RECIPIENTS} personas. Filtra por una etiqueta para enviarlo por partes.`);
        await db.query("INSERT INTO broadcast_recipients (tenant_id, broadcast_id, contact_id) SELECT $1, $2, x FROM unnest($3::uuid[]) x ON CONFLICT DO NOTHING", [tenantId, d.id, ids]);
        await db.query("UPDATE broadcasts SET status = 'enviando', total = $3, started_at = now() WHERE tenant_id = $1 AND id = $2", [tenantId, d.id, ids.length]);
        await audit("broadcast.started", { total: ids.length });
        return { ok: true as const, total: ids.length };
      }
      case "pause":
        if (b.status !== "enviando") return bad("estado_invalido", "Solo se puede pausar una difusión que está enviando.");
        await db.query("UPDATE broadcasts SET status = 'pausada', pause_reason = NULL WHERE tenant_id = $1 AND id = $2", [tenantId, d.id]);
        await audit("broadcast.paused");
        return { ok: true as const };
      case "resume":
        if (b.status !== "pausada") return bad("estado_invalido", "Solo se puede reanudar una difusión pausada.");
        await db.query("UPDATE broadcasts SET status = 'enviando', pause_reason = NULL WHERE tenant_id = $1 AND id = $2", [tenantId, d.id]);
        await audit("broadcast.resumed");
        return { ok: true as const };
      case "cancel":
        if (!["borrador", "enviando", "pausada"].includes(b.status)) return bad("estado_invalido", "Esta difusión ya terminó.");
        await db.query("UPDATE broadcast_recipients SET status = 'omitido', reason = 'cancelada' WHERE tenant_id = $1 AND broadcast_id = $2 AND status = 'pendiente'", [tenantId, d.id]);
        await db.query("UPDATE broadcasts SET status = 'cancelada', finished_at = now() WHERE tenant_id = $1 AND id = $2", [tenantId, d.id]);
        await audit("broadcast.cancelled");
        return { ok: true as const };
      case "delete":
        if (b.status !== "borrador") return bad("estado_invalido", "Solo se pueden borrar los borradores.");
        await db.query("DELETE FROM broadcasts WHERE tenant_id = $1 AND id = $2", [tenantId, d.id]);
        return { ok: true as const };
    }
  });
  if ("err" in out && out.err) return errorResponse(out.err[0], out.err[1], out.err[2]);
  return jsonResponse(out);
});
