import { getPool } from "@/lib/db";
import { checkOrigin, jsonResponse, readJson, route } from "@/lib/auth/http";
import { requireSuperAdmin } from "@/lib/auth/guard";
import { adminStatusSchema } from "@/lib/support/schema";

/** Cerrar o reabrir una consulta. */
export const POST = route(async (req) => {
  const blocked = checkOrigin(req);
  if (blocked) return blocked;
  const auth = await requireSuperAdmin(req);
  if (!auth.ok) return auth.response;
  const body = await readJson(req, adminStatusSchema);
  if (!body.ok) return body.response;
  await getPool().query("SELECT admin_support_set_status($1, $2, $3)", [auth.tokenHash, body.data.id, body.data.status]);
  return jsonResponse({ ok: true });
});
