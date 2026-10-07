import { getPool } from "@/lib/db";
import { jsonResponse, route } from "@/lib/auth/http";
import { requireSuperAdmin } from "@/lib/auth/guard";

export const GET = route(async (req) => {
  const auth = await requireSuperAdmin(req);
  if (!auth.ok) return auth.response;
  const r = await getPool().query("SELECT * FROM admin_list_tenants($1)", [auth.tokenHash]);
  return jsonResponse({
    tenants: r.rows.map((t) => ({
      id: t.t_id,
      name: t.t_name,
      slug: t.t_slug,
      status: t.t_status,
      trialEndsAt: t.t_trial_ends_at,
      createdAt: t.t_created_at,
      members: Number(t.t_members),
    })),
  });
});
