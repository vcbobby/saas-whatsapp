import { requireTenant } from "@/lib/auth/guard";
import { jsonResponse, route } from "@/lib/auth/http";
import { withTenant } from "@/lib/db";
import { buildSnapshot } from "@/lib/summary/snapshot";

/** Resumen del día del negocio (solo lectura). */
export const GET = route(async (req) => {
  const auth = await requireTenant(req, "conversations:read");
  if (!auth.ok) return auth.response;
  const { tenantId } = auth.ctx;
  const snapshot = await withTenant(tenantId, (db) => buildSnapshot(db, tenantId));
  return jsonResponse({ snapshot });
});
