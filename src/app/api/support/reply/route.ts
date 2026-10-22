import { requireTenant } from "@/lib/auth/guard";
import { checkOrigin, errorResponse, jsonResponse, readJson, route } from "@/lib/auth/http";
import { withTenant } from "@/lib/db";
import { replySchema, supportDbError } from "@/lib/support/schema";

/** Escribir en una consulta (si estaba cerrada, se reabre). */
export const POST = route(async (req) => {
  const blocked = checkOrigin(req);
  if (blocked) return blocked;
  const auth = await requireTenant(req, "support:use");
  if (!auth.ok) return auth.response;
  if (auth.ctx.impersonating) return errorResponse(403, "sin_permiso", "El soporte no puede escribir en nombre de un negocio.");
  const body = await readJson(req, replySchema);
  if (!body.ok) return body.response;
  try {
    await withTenant(auth.ctx.tenantId, (db) => db.query("SELECT support_reply($1, $2, $3)", [body.data.id, auth.session.userId, body.data.body]));
    return jsonResponse({ ok: true });
  } catch (e) {
    const known = supportDbError(e);
    if (known) return errorResponse(known.status, known.code, known.message);
    throw e;
  }
}, { limit: "support" });
