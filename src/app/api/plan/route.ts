import { requireTenant } from "@/lib/auth/guard";
import { jsonResponse, route } from "@/lib/auth/http";
import { withTenant } from "@/lib/db";
import { can } from "@/lib/auth/permissions";
import { loadPlanUsage, quotaState } from "@/lib/plans/usage";

/** Plan del negocio y cuánto lleva usado. Lo puede ver cualquier persona del equipo. */
export const GET = route(async (req) => {
  const auth = await requireTenant(req);
  if (!auth.ok) return auth.response;
  const u = await withTenant(auth.ctx.tenantId, (db) => loadPlanUsage(db, auth.ctx.tenantId));
  if (!u) return jsonResponse({ plan: null });
  return jsonResponse({
    ...u,
    canPay: can(auth.ctx.role, "billing:manage") && !auth.ctx.impersonating,
    repliesState: quotaState(u.repliesThisMonth, u.plan.maxRepliesMonth),
    membersState: quotaState(u.members + u.pendingInvitations, u.plan.maxMembers),
  });
});
