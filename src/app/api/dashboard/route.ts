import { requireTenant } from "@/lib/auth/guard";
import { jsonResponse, route } from "@/lib/auth/http";
import { withTenant } from "@/lib/db";
import { buildDashboard } from "@/lib/dashboard/stats";

/** Cifras y series del panel de Inicio (solo lectura, solo del propio negocio). */
export const GET = route(async (req) => {
  const auth = await requireTenant(req, "conversations:read");
  if (!auth.ok) return auth.response;
  const { tenantId } = auth.ctx;
  const dashboard = await withTenant(tenantId, (db) => buildDashboard(db, tenantId));
  return jsonResponse({ dashboard });
});
