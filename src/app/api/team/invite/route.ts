import { getEnv } from "@/lib/env";
import { getPool } from "@/lib/db";
import { requireTenant } from "@/lib/auth/guard";
import { checkOrigin, jsonResponse, readJson, route } from "@/lib/auth/http";
import { tokenHashOf } from "@/lib/auth/session";
import { teamErrorResponse } from "@/lib/auth/team-errors";
import { newSessionToken } from "@/lib/auth/tokens";
import { inviteSchema } from "@/lib/auth/validation";

export const POST = route(async (req) => {
  const blocked = checkOrigin(req);
  if (blocked) return blocked;
  const auth = await requireTenant(req, "team:manage");
  if (!auth.ok) return auth.response;
  const body = await readJson(req, inviteSchema);
  if (!body.ok) return body.response;

  // El enlace se muestra una sola vez; en la base solo queda su hash.
  const { token, hash } = newSessionToken();
  try {
    await getPool().query("SELECT team_invite($1, $2, $3, $4, $5)", [
      tokenHashOf(req)!, auth.ctx.tenantId, body.data.email, body.data.role, hash,
    ]);
  } catch (err) {
    const r = teamErrorResponse(err);
    if (r) return r;
    throw err;
  }
  const url = `${new URL(getEnv().APP_URL).origin}/invitacion/${token}`;
  return jsonResponse({ ok: true, inviteUrl: url }, 201);
});
