import { getPool } from "@/lib/db";
import { checkOrigin, errorResponse, jsonResponse, readJson, route } from "@/lib/auth/http";
import { requireSuperAdmin } from "@/lib/auth/guard";
import { planUpdateSchema } from "@/lib/auth/validation";

/** Edita un plan (nombre, límites, módulos, activo). Solo súper admin. */
export const POST = route(async (req) => {
  const blocked = checkOrigin(req);
  if (blocked) return blocked;
  const auth = await requireSuperAdmin(req);
  if (!auth.ok) return auth.response;
  const body = await readJson(req, planUpdateSchema);
  if (!body.ok) return body.response;
  const d = body.data;
  try {
    await getPool().query("SELECT admin_update_plan($1, $2, $3, $4, $5, $6, $7)", [auth.tokenHash, d.planId, d.name, d.maxRepliesMonth, d.maxMembers, [...new Set(d.modules)], d.active]);
  } catch (e) {
    const code = (e as { code?: string }).code;
    if (code === "P0002") return errorResponse(404, "no_encontrado", "Plan no encontrado.");
    if (code === "22023") return errorResponse(409, "plan_defecto", "El plan por defecto no se puede desactivar. Elige otro por defecto primero.");
    throw e;
  }
  return jsonResponse({ ok: true });
});
