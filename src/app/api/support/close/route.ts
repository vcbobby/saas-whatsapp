import { requireTenant } from "@/lib/auth/guard";
import { checkOrigin, errorResponse, jsonResponse, readJson, route } from "@/lib/auth/http";
import { withTenant } from "@/lib/db";
import { closeSchema } from "@/lib/support/schema";

/** Cerrar una consulta resuelta. */
export const POST = route(async (req) => {
  const blocked = checkOrigin(req);
  if (blocked) return blocked;
  const auth = await requireTenant(req, "support:use");
  if (!auth.ok) return auth.response;
  if (auth.ctx.impersonating) return errorResponse(403, "sin_permiso", "El soporte no puede cerrar consultas en nombre de un negocio.");
  const body = await readJson(req, closeSchema);
  if (!body.ok) return body.response;
  await withTenant(auth.ctx.tenantId, (db) => db.query("SELECT support_close($1)", [body.data.id]));
  return jsonResponse({ ok: true });
});
