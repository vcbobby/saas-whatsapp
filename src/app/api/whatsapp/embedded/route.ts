import { z } from "zod";
import { requireTenant } from "@/lib/auth/guard";
import { checkOrigin, errorResponse, jsonResponse, readJson, route } from "@/lib/auth/http";
import { getEmbeddedSignupConfig } from "@/lib/env";
import { completeEmbeddedSignup } from "@/lib/whatsapp/embedded";
import { saveIntegration } from "@/lib/whatsapp/integration";

const schema = z.object({
  code: z.string().trim().min(10).max(2000),
  phoneNumberId: z.string().trim().regex(/^\d{5,30}$/),
  wabaId: z.string().trim().regex(/^\d{5,30}$/),
});

/** Cierra la conexión de WhatsApp «con un clic». Solo existe cuando EMBEDDED_SIGNUP_ENABLED=true y Meta aprobó la app. */
export const POST = route(async (req) => {
  const blocked = checkOrigin(req);
  if (blocked) return blocked;
  if (!getEmbeddedSignupConfig()) return errorResponse(404, "no_disponible", "La conexión con un clic todavía no está activada.");
  const auth = await requireTenant(req, "integrations:manage");
  if (!auth.ok) return auth.response;
  const body = await readJson(req, schema);
  if (!body.ok) return body.response;
  const { tenantId } = auth.ctx;
  const r = await completeEmbeddedSignup(body.data);
  if (!r.ok) return errorResponse(r.status, r.code, r.message);
  try {
    await saveIntegration({ tenantId, actorId: auth.session.userId, phoneNumberId: body.data.phoneNumberId, accessToken: r.accessToken, display: r.display, via: "embedded", wabaId: body.data.wabaId, expiresAt: r.expiresAt });
  } catch (err) {
    if ((err as { code?: string }).code === "23505") return errorResponse(409, "ya_conectado", "Este negocio ya tiene un número conectado, o ese número ya está en uso. Desconecta el actual primero.");
    throw err;
  }
  return jsonResponse({ ok: true, displayPhoneNumber: r.display, verifiedName: r.verifiedName, warnings: r.warnings }, 201);
});
