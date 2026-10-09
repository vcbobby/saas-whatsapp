import { getPool } from "@/lib/db";
import { requireTenant } from "@/lib/auth/guard";
import { checkOrigin, jsonResponse, readJson, route } from "@/lib/auth/http";
import { tokenHashOf } from "@/lib/auth/session";
import { teamErrorResponse } from "@/lib/auth/team-errors";
import { roleChangeSchema } from "@/lib/auth/validation";

export const POST = route(async (req) => {
  const blocked = checkOrigin(req);
  if (blocked) return blocked;
  const auth = await requireTenant(req, "team:roles");
  if (!auth.ok) return auth.response;
  const body = await readJson(req, roleChangeSchema);
  if (!body.ok) return body.response;
  try {
    await getPool().query("SELECT team_set_role($1, $2, $3, $4)", [
      tokenHashOf(req)!, auth.ctx.tenantId, body.data.userId, body.data.role,
    ]);
  } catch (err) {
    const r = teamErrorResponse(err);
    if (r) return r;
    throw err;
  }
  return jsonResponse({ ok: true });
});
