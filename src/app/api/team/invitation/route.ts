import { getPool } from "@/lib/db";
import { requireTenant } from "@/lib/auth/guard";
import { checkOrigin, jsonResponse, readJson, route } from "@/lib/auth/http";
import { tokenHashOf } from "@/lib/auth/session";
import { teamErrorResponse } from "@/lib/auth/team-errors";
import { invitationIdSchema } from "@/lib/auth/validation";

/** Revocar una invitación pendiente. */
export const POST = route(async (req) => {
  const blocked = checkOrigin(req);
  if (blocked) return blocked;
  const auth = await requireTenant(req, "team:manage");
  if (!auth.ok) return auth.response;
  const body = await readJson(req, invitationIdSchema);
  if (!body.ok) return body.response;
  try {
    await getPool().query("SELECT team_revoke_invitation($1, $2, $3)", [
      tokenHashOf(req)!, auth.ctx.tenantId, body.data.invitationId,
    ]);
  } catch (err) {
    const r = teamErrorResponse(err);
    if (r) return r;
    throw err;
  }
  return jsonResponse({ ok: true });
});
