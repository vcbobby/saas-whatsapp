import { z } from "zod";
import { requireTenant } from "@/lib/auth/guard";
import { checkOrigin, errorResponse, jsonResponse, readJson, route } from "@/lib/auth/http";
import { withTenant } from "@/lib/db";
import { loadIntegration } from "@/lib/whatsapp/integration";
import { deleteMetaTemplate, explainTemplateError } from "@/lib/whatsapp/templates";

const schema = z.object({ id: z.uuid() });

/** Borra la plantilla en Meta (todos sus idiomas comparten el nombre: se borra ese nombre completo) y en la copia local. */
export const POST = route(async (req) => {
  const blocked = checkOrigin(req);
  if (blocked) return blocked;
  const auth = await requireTenant(req, "integrations:manage");
  if (!auth.ok) return auth.response;
  const body = await readJson(req, schema);
  if (!body.ok) return body.response;
  const tenantId = auth.ctx.tenantId;
  const tpl = await withTenant(tenantId, async (db) => (await db.query<{ name: string }>("SELECT name FROM whatsapp_templates WHERE id = $1", [body.data.id])).rows[0]);
  if (!tpl) return errorResponse(404, "no_encontrado", "No encontrado.");
  const conn = await loadIntegration(tenantId);
  if (!conn?.wabaId) return errorResponse(409, "sin_waba", "Falta el ID de tu cuenta de WhatsApp Business (WABA).");
  const r = await deleteMetaTemplate(conn.wabaId, conn.accessToken, tpl.name);
  // Si Meta dice que ya no existe, igual se limpia la copia local.
  const gone = !r.ok && r.error && (r.error.code === 100 || r.error.status === 404);
  if (!r.ok && !gone) return errorResponse(502, "meta_rechazo", explainTemplateError(r.error, "network" in r ? r.network : undefined));
  await withTenant(tenantId, async (db) => {
    await db.query("DELETE FROM whatsapp_templates WHERE name = $1", [tpl.name]);
    await db.query("INSERT INTO audit_log (tenant_id, actor_id, action, target_type, metadata) VALUES ($1,$2,'whatsapp.template_deleted','template',$3)", [tenantId, auth.session.userId, JSON.stringify({ name: tpl.name })]);
  });
  return jsonResponse({ ok: true });
}, { limit: "templates" });
