import { getPool } from "@/lib/db";
import { requireTenant } from "@/lib/auth/guard";
import { jsonResponse, route } from "@/lib/auth/http";
import { tokenHashOf } from "@/lib/auth/session";
import { teamErrorResponse } from "@/lib/auth/team-errors";

export const GET = route(async (req) => {
  const auth = await requireTenant(req, "team:manage");
  if (!auth.ok) return auth.response;
  const tokenHash = tokenHashOf(req)!;
  const pool = getPool();
  try {
    const [members, invitations] = await Promise.all([
      pool.query("SELECT * FROM team_members($1, $2)", [tokenHash, auth.ctx.tenantId]),
      pool.query("SELECT * FROM team_invitations($1, $2)", [tokenHash, auth.ctx.tenantId]),
    ]);
    return jsonResponse({
      myRole: auth.ctx.role,
      members: members.rows.map((m) => ({
        userId: m.m_user_id, email: m.m_email, role: m.m_role, since: m.m_since, mfa: m.m_mfa,
      })),
      invitations: invitations.rows.map((i) => ({
        id: i.i_id, email: i.i_email, role: i.i_role, createdAt: i.i_created, expiresAt: i.i_expires,
      })),
    });
  } catch (err) {
    const r = teamErrorResponse(err);
    if (r) return r;
    throw err;
  }
});
