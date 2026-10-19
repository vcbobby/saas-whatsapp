import { requireTenant } from "@/lib/auth/guard";
import { checkOrigin, errorResponse, jsonResponse, route } from "@/lib/auth/http";
import { withTenant } from "@/lib/db";

/** «Lo haré después»: el asistente deja de aparecer solo; se puede retomar desde Inicio. */
export const POST = route(async (req) => {
  const blocked = checkOrigin(req);
  if (blocked) return blocked;
  const auth = await requireTenant(req, "agent:manage");
  if (!auth.ok) return auth.response;
  if (auth.ctx.impersonating) return errorResponse(403, "sin_permiso", "El soporte no puede hacer esto.");
  const { tenantId } = auth.ctx;
  await withTenant(tenantId, (db) => db.query("UPDATE tenants SET onboarding_state = 'skipped' WHERE id = $1 AND onboarding_state = 'pending'", [tenantId]));
  return jsonResponse({ ok: true });
});
