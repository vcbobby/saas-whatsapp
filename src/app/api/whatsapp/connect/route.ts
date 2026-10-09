import { encryptSecret } from "@/lib/crypto";
import { withTenant } from "@/lib/db";
import { requireTenant } from "@/lib/auth/guard";
import { checkOrigin, errorResponse, jsonResponse, readJson, route } from "@/lib/auth/http";
import { whatsappConnectSchema } from "@/lib/auth/validation";
import { fetchPhoneInfo } from "@/lib/whatsapp/graph";

/** Conecta el número de WhatsApp del negocio (valida el token con Meta y lo guarda cifrado). */
export const POST = route(async (req) => {
  const blocked = checkOrigin(req);
  if (blocked) return blocked;
  const auth = await requireTenant(req, "integrations:manage");
  if (!auth.ok) return auth.response;
  const body = await readJson(req, whatsappConnectSchema);
  if (!body.ok) return body.response;
  const { phoneNumberId, accessToken } = body.data;
  const tenantId = auth.ctx.tenantId;

  const info = await fetchPhoneInfo(phoneNumberId, accessToken);
  if (!info) {
    return errorResponse(
      400,
      "token_no_valido",
      "Meta no aceptó ese token para ese número. Revisa el ID del número y que el token tenga permisos de WhatsApp.",
    );
  }

  // El texto cifrado queda atado a este negocio y a este número (AAD).
  const { payload, keyVersion } = encryptSecret(accessToken, `wa:${tenantId}:${phoneNumberId}`);
  try {
    await withTenant(tenantId, async (db) => {
      await db.query(
        `INSERT INTO tenant_integrations (tenant_id, provider, external_id, secret_enc, key_version)
         VALUES ($1, 'whatsapp', $2, $3, $4)`,
        [tenantId, phoneNumberId, payload, keyVersion],
      );
      await db.query(
        `INSERT INTO audit_log (tenant_id, actor_id, action, target_type, target_id, metadata)
         VALUES ($1, $2, 'whatsapp.connected', 'integration', $3, $4)`,
        [tenantId, auth.session.userId, phoneNumberId, JSON.stringify({ display: info.displayPhoneNumber })],
      );
    });
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
  return jsonResponse({ ok: true, displayPhoneNumber: info.displayPhoneNumber, verifiedName: info.verifiedName }, 201);
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
