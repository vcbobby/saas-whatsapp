import { requireTenant } from "@/lib/auth/guard";
import { errorResponse, jsonResponse, route } from "@/lib/auth/http";
import { diagnosePhone, tokenExpiry } from "@/lib/whatsapp/diagnose";
import { loadIntegration } from "@/lib/whatsapp/integration";

/** «Comprobar conexión»: ¿Meta sigue aceptando el token? ¿Cuándo vence? Nunca devuelve el token. */
export const GET = route(async (req) => {
  const auth = await requireTenant(req, "integrations:manage");
  if (!auth.ok) return auth.response;
  const conn = await loadIntegration(auth.ctx.tenantId);
  if (!conn) return errorResponse(404, "sin_numero", "No hay número conectado.");
  const d = await diagnosePhone(conn.phoneNumberId, conn.accessToken, fetch, true);
  const exp = conn.expiresAt ?? (await tokenExpiry(conn.accessToken));
  const expiresAt = exp instanceof Date ? exp : null;
  const hoursLeft = expiresAt ? Math.floor((expiresAt.getTime() - Date.now()) / 3_600_000) : null;
  return jsonResponse({
    via: conn.via,
    ok: d.ok,
    problem: d.ok ? null : { reason: d.reason, message: d.message },
    displayPhoneNumber: d.ok ? d.info.displayPhoneNumber : null,
    verifiedName: d.ok ? d.info.verifiedName : null,
    quality: d.ok ? d.info.quality : null,
    expiresAt: expiresAt?.toISOString() ?? null,
    hoursLeft,
    expiresSoon: hoursLeft !== null && hoursLeft < 24,
  });
});
