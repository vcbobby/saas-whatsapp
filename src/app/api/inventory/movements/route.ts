import { z } from "zod";
import { requireTenant } from "@/lib/auth/guard";
import { errorResponse, jsonResponse, route } from "@/lib/auth/http";
import { withTenant } from "@/lib/db";
import { listMovements } from "@/lib/inventory/service";

/** Historial de movimientos (de un producto o de todo el negocio), lo más reciente primero. */
export const GET = route(async (req) => {
  const auth = await requireTenant(req, "catalog:read");
  if (!auth.ok) return auth.response;
  const { tenantId } = auth.ctx;
  const u = new URL(req.url);
  const pid = u.searchParams.get("productId");
  if (pid !== null && !z.uuid().safeParse(pid).success) return errorResponse(400, "datos_invalidos", "Producto inválido.");
  const movements = await withTenant(tenantId, (db) => listMovements(db, tenantId, { productId: pid ?? undefined, limit: 100, viewerId: auth.session.userId }));
  return jsonResponse({ movements });
});
