import { requireTenant } from "@/lib/auth/guard";
import { checkOrigin, errorResponse, jsonResponse, readJson, route } from "@/lib/auth/http";
import { withTenant } from "@/lib/db";
import { applyOnboarding } from "@/lib/onboarding/apply";
import { onboardingSchema } from "@/lib/onboarding/schema";

/** Termina el asistente de bienvenida: configura servicios/productos, horario, asistente y datos del negocio de una vez. */
export const POST = route(async (req) => {
  const blocked = checkOrigin(req);
  if (blocked) return blocked;
  const auth = await requireTenant(req, "agent:manage");
  if (!auth.ok) return auth.response;
  if (auth.ctx.impersonating) return errorResponse(403, "sin_permiso", "El soporte no puede completar la configuración inicial de un negocio.");
  const body = await readJson(req, onboardingSchema, { maxChars: 20_000 });
  if (!body.ok) return body.response;
  const { tenantId } = auth.ctx;
  const out = await withTenant(tenantId, (db) => applyOnboarding(db, tenantId, auth.session.userId, body.data));
  if (!out.ok) return errorResponse(out.code === "ya_completado" ? 409 : 400, out.code, out.message);
  return jsonResponse(out);
});
