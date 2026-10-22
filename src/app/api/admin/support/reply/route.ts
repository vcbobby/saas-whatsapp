import { getPool } from "@/lib/db";
import { checkOrigin, errorResponse, jsonResponse, readJson, route } from "@/lib/auth/http";
import { requireSuperAdmin } from "@/lib/auth/guard";
import { replySchema, supportDbError } from "@/lib/support/schema";

export const POST = route(async (req) => {
  const blocked = checkOrigin(req);
  if (blocked) return blocked;
  const auth = await requireSuperAdmin(req);
  if (!auth.ok) return auth.response;
  const body = await readJson(req, replySchema);
  if (!body.ok) return body.response;
  try {
    await getPool().query("SELECT admin_support_reply($1, $2, $3)", [auth.tokenHash, body.data.id, body.data.body]);
    return jsonResponse({ ok: true });
  } catch (e) {
    const known = supportDbError(e);
    if (known) return errorResponse(known.status, known.code, known.message);
    throw e;
  }
});
