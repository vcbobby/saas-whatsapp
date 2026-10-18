import { getPool } from "@/lib/db";
import { requireSuperAdmin } from "@/lib/auth/guard";
import { checkOrigin, errorResponse, jsonResponse, readJson, route } from "@/lib/auth/http";
import { planPriceSchema } from "@/lib/auth/validation";

/** Precio mensual en USD de un plan (null = no se vende en línea). Solo súper admin. */
export const POST = route(async (req) => {
  const blocked = checkOrigin(req);
  if (blocked) return blocked;
  const auth = await requireSuperAdmin(req);
  if (!auth.ok) return auth.response;
  const body = await readJson(req, planPriceSchema);
  if (!body.ok) return body.response;
  try {
    await getPool().query("SELECT admin_set_plan_price($1, $2, $3)", [auth.tokenHash, body.data.planId, body.data.priceCents]);
  } catch (e) {
    if ((e as { code?: string }).code === "P0002") return errorResponse(404, "no_encontrado", "Plan no encontrado.");
    throw e;
  }
  return jsonResponse({ ok: true });
});
