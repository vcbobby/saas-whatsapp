import { getPool } from "@/lib/db";
import { requireTenant } from "@/lib/auth/guard";
import { checkOrigin, errorResponse, jsonResponse, readJson, route } from "@/lib/auth/http";
import { tokenHashOf } from "@/lib/auth/session";
import { billingErrorResponse, isStaleRate } from "@/lib/billing/errors";
import { payCreateSchema } from "@/lib/auth/validation";

/** Crea una cotización: plan + meses + método. Pago Móvil congela la tasa BCV 30 minutos. */
export const POST = route(async (req) => {
  const blocked = checkOrigin(req);
  if (blocked) return blocked;
  const auth = await requireTenant(req, "billing:manage");
  if (!auth.ok) return auth.response;
  const body = await readJson(req, payCreateSchema);
  if (!body.ok) return body.response;
  try {
    const r = await getPool().query("SELECT payment_create($1, $2, $3, $4, $5) AS id", [tokenHashOf(req)!, auth.ctx.tenantId, body.data.planId, body.data.months, body.data.method]);
    return jsonResponse({ ok: true, paymentId: r.rows[0].id }, 201);
  } catch (e) {
    if (isStaleRate(e)) return errorResponse(409, "tasa_desactualizada", "La tasa del día aún no está actualizada. Intenta en un rato o elige otro método.");
    const r = billingErrorResponse(e);
    if (r) return r;
    throw e;
  }
});
