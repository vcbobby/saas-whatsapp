import { checkOrigin, errorResponse, jsonResponse, route } from "@/lib/auth/http";
import { cancelDeletion } from "@/lib/privacy/deletion";
import { requireOwner } from "@/lib/privacy/guard";

/** Arrepentirse: cancela la eliminación pedida (solo el dueño, antes de la fecha). */
export const POST = route(async (req) => {
  const blocked = checkOrigin(req);
  if (blocked) return blocked;
  const owner = await requireOwner(req);
  if (!owner.ok) return owner.response;
  const ok = await cancelDeletion(owner.tenantId, owner.session.userId);
  if (!ok) return errorResponse(409, "sin_eliminacion", "No hay una eliminación pendiente que cancelar.");
  return jsonResponse({ ok: true });
}, { limit: "api" });
