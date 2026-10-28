import { requireTenant } from "@/lib/auth/guard";
import { checkOrigin, errorResponse, jsonResponse, route } from "@/lib/auth/http";
import { loadIntegration } from "@/lib/whatsapp/integration";
import { syncTemplates } from "@/lib/whatsapp/template-sync";

/** «Actualizar desde Meta»: estado de revisión, rechazos y plantillas creadas directamente en Meta. */
export const POST = route(async (req) => {
  const blocked = checkOrigin(req);
  if (blocked) return blocked;
  const auth = await requireTenant(req, "integrations:manage");
  if (!auth.ok) return auth.response;
  const conn = await loadIntegration(auth.ctx.tenantId);
  if (!conn) return errorResponse(409, "sin_whatsapp", "Primero conecta tu número de WhatsApp.");
  if (!conn.wabaId) return errorResponse(409, "sin_waba", "Falta el ID de tu cuenta de WhatsApp Business (WABA). Agrégalo arriba en esta pantalla.");
  const r = await syncTemplates(auth.ctx.tenantId, conn);
  if (!r.ok) return errorResponse(502, "meta_rechazo", r.message);
  return jsonResponse({ ok: true, total: r.total, removed: r.removed });
}, { limit: "templates" });
