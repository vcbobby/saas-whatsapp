import { getPool } from "@/lib/db";
import { requireSuperAdmin } from "@/lib/auth/guard";
import { checkOrigin, errorResponse, jsonResponse, readJson, route } from "@/lib/auth/http";
import { billingErrorResponse } from "@/lib/billing/errors";
import { paymentDecideSchema } from "@/lib/auth/validation";

/** Confirma o rechaza un pago por revisar. Confirmar activa el plan y suma 30 días por mes pagado. */
export const POST = route(async (req) => {
  const blocked = checkOrigin(req);
  if (blocked) return blocked;
  const auth = await requireSuperAdmin(req);
  if (!auth.ok) return auth.response;
  const body = await readJson(req, paymentDecideSchema);
  if (!body.ok) return body.response;
  const d = body.data;
  if (!d.approve && !d.reason) return errorResponse(400, "datos_invalidos", "Escribe el motivo del rechazo.");
  try {
    await getPool().query("SELECT admin_payment_decide($1, $2, $3, $4)", [auth.tokenHash, d.paymentId, d.approve, d.reason ?? null]);
  } catch (e) {
    const r = billingErrorResponse(e);
    if (r) return r;
    throw e;
  }
  return jsonResponse({ ok: true });
});
