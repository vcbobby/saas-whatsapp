import { jsonResponse, route } from "@/lib/auth/http";
import { requireSession } from "@/lib/auth/guard";
import { effectiveTenant } from "@/lib/auth/session";

export const GET = route(async (req) => {
  const auth = await requireSession(req);
  if (!auth.ok) return auth.response;
  const s = auth.session;
  const ctx = effectiveTenant(s);
  return jsonResponse({
    user: {
      email: s.email,
      isSuperAdmin: s.isSuperAdmin,
      mfaEnabled: s.mfaEnabled,
      needsMfaSetup: s.needsMfaSetup,
    },
    tenant: ctx
      ? {
          id: ctx.tenantId,
          role: ctx.role,
          status: ctx.impersonating ? null : s.activeTenantStatus,
          impersonating: ctx.impersonating,
        }
      : null,
  });
});
