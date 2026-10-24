import { z } from "zod";
import { checkOrigin, errorResponse, jsonResponse, readJson, route } from "@/lib/auth/http";
import { withTenant } from "@/lib/db";
import { requestDeletion } from "@/lib/privacy/deletion";
import { confirmIdentity, confirmSchema, requireOwner } from "@/lib/privacy/guard";

const schema = confirmSchema.extend({ confirmName: z.string().min(1).max(200) });

/** Pedir la eliminación del negocio: 7 días para arrepentirse; luego se borra todo de forma definitiva. */
export const POST = route(async (req) => {
  const blocked = checkOrigin(req);
  if (blocked) return blocked;
  const owner = await requireOwner(req);
  if (!owner.ok) return owner.response;
  const body = await readJson(req, schema);
  if (!body.ok) return body.response;

  const name = await withTenant(owner.tenantId, async (db) => (await db.query<{ name: string }>("SELECT name FROM tenants WHERE id = $1", [owner.tenantId])).rows[0]?.name);
  if (!name || body.data.confirmName.trim() !== name) {
    return errorResponse(400, "nombre_no_coincide", "Escribe el nombre del negocio exactamente como aparece.", { fields: ["confirmName"] });
  }
  const denied = await confirmIdentity(owner.session, owner.tokenHash, body.data);
  if (denied) return denied;

  const scheduledFor = await requestDeletion(owner.tenantId, owner.session.userId);
  return jsonResponse({ ok: true, scheduledFor });
}, { limit: "privacy" });
