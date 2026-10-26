import { z } from "zod";
import { withTenant } from "@/lib/db";
import { requireTenant } from "@/lib/auth/guard";
import { checkOrigin, errorResponse, jsonResponse, readJson, route } from "@/lib/auth/http";
import { diagnosePhone, looksLikePhoneNumber, normalizePhoneId, normalizeToken, tokenExpiry } from "@/lib/whatsapp/diagnose";
import { saveIntegration } from "@/lib/whatsapp/integration";

const connectSchema = z.object({ phoneNumberId: z.string().max(60), accessToken: z.string().max(3000) });

/** Conecta el número de WhatsApp del negocio (valida el token con Meta, explica qué falla y lo guarda cifrado). */
export const POST = route(async (req) => {
  const blocked = checkOrigin(req);
  if (blocked) return blocked;
  const auth = await requireTenant(req, "integrations:manage");
  if (!auth.ok) return auth.response;
  const body = await readJson(req, connectSchema);
  if (!body.ok) return body.response;
  const tenantId = auth.ctx.tenantId;

  // La gente pega con comillas, «Bearer », espacios o el teléfono en vez del ID: se limpia y, si no sirve, se explica.
  const phoneNumberId = normalizePhoneId(body.data.phoneNumberId);
  const accessToken = normalizeToken(body.data.accessToken);
  if (looksLikePhoneNumber(body.data.phoneNumberId)) return errorResponse(400, "id_es_telefono", "Eso parece un número de teléfono. Necesitas el «Phone number ID»: un código largo de solo dígitos que aparece en «Configuración de la API» de Meta, debajo del teléfono.", { fields: ["phoneNumberId"] });
  if (!/^\d{5,30}$/.test(phoneNumberId)) return errorResponse(400, "id_no_valido", "El ID del número son solo dígitos (de 5 a 30), sin espacios ni letras.", { fields: ["phoneNumberId"] });
  if (accessToken.length < 20) return errorResponse(400, "token_corto", "El token es demasiado corto. Cópialo completo desde Meta (empieza con EAA…).", { fields: ["accessToken"] });

  const diag = await diagnosePhone(phoneNumberId, accessToken);
  if (!diag.ok) return errorResponse(400, diag.reason === "token" ? "token_no_valido" : `meta_${diag.reason}`, diag.message, { fields: [diag.reason === "id" ? "phoneNumberId" : "accessToken"] });
  const exp = await tokenExpiry(accessToken);

  try {
    await saveIntegration({ tenantId, actorId: auth.session.userId, phoneNumberId, accessToken, display: diag.info.displayPhoneNumber, via: "manual", expiresAt: exp instanceof Date ? exp : null });
  } catch (err) {
    if ((err as { code?: string }).code === "23505") {
      return errorResponse(
        409,
        "ya_conectado",
        "Este negocio ya tiene un número conectado, o ese número ya está en uso. Desconecta el actual primero.",
      );
    }
    throw err;
  }
  return jsonResponse({ ok: true, displayPhoneNumber: diag.info.displayPhoneNumber, verifiedName: diag.info.verifiedName, expiresAt: exp instanceof Date ? exp.toISOString() : null }, 201);
});

/** Desconecta el número del negocio. */
export const DELETE = route(async (req) => {
  const blocked = checkOrigin(req);
  if (blocked) return blocked;
  const auth = await requireTenant(req, "integrations:manage");
  if (!auth.ok) return auth.response;
  const tenantId = auth.ctx.tenantId;
  const removed = await withTenant(tenantId, async (db) => {
    const r = await db.query(
      `DELETE FROM tenant_integrations WHERE tenant_id = $1 AND provider = 'whatsapp' RETURNING external_id`,
      [tenantId],
    );
    if (r.rowCount) {
      await db.query(
        `INSERT INTO audit_log (tenant_id, actor_id, action, target_type, target_id)
         VALUES ($1, $2, 'whatsapp.disconnected', 'integration', $3)`,
        [tenantId, auth.session.userId, r.rows[0].external_id],
      );
    }
    return r.rowCount ?? 0;
  });
  if (!removed) return errorResponse(404, "no_encontrado", "No hay número conectado.");
  return jsonResponse({ ok: true });
});
