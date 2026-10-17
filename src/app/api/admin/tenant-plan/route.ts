import { getPool } from "@/lib/db";
import { checkOrigin, errorResponse, jsonResponse, readJson, route } from "@/lib/auth/http";
import { requireSuperAdmin } from "@/lib/auth/guard";
import { tenantPlanSchema } from "@/lib/auth/validation";

/** Cambia el plan de un negocio. Solo súper admin. */
export const POST = route(async (req) => {
  const blocked = checkOrigin(req);
  if (blocked) return blocked;
  const auth = await requireSuperAdmin(req);
  if (!auth.ok) return auth.response;
  const body = await readJson(req, tenantPlanSchema);
  if (!body.ok) return body.response;
  try {
    await getPool().query("SELECT admin_set_tenant_plan($1, $2, $3)", [auth.tokenHash, body.data.tenantId, body.data.planId]);
  } catch (e) {
    if ((e as { code?: string }).code === "P0002") return errorResponse(404, "no_encontrado", "Negocio o plan no encontrado (o el plan está inactivo).");
    throw e;
  }
  return jsonResponse({ ok: true });
});
