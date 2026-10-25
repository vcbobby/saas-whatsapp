import { z } from "zod";
import { requireTenant } from "@/lib/auth/guard";
import { jsonResponse, route } from "@/lib/auth/http";
import { can } from "@/lib/auth/permissions";
import { withTenant } from "@/lib/db";
import { listInventory } from "@/lib/inventory/service";

const query = z.object({
  filter: z.enum(["all", "low", "out", "untracked"]).catch("all"),
  q: z.string().trim().max(100).catch(""),
});

/** Inventario: productos activos con su estado de stock y el resumen (controlados, bajos, agotados, sin control). */
export const GET = route(async (req) => {
  const auth = await requireTenant(req, "catalog:read");
  if (!auth.ok) return auth.response;
  const { tenantId } = auth.ctx;
  const u = new URL(req.url);
  const f = query.parse({ filter: u.searchParams.get("filter") ?? "all", q: u.searchParams.get("q") ?? "" });
  const data = await withTenant(tenantId, (db) => listInventory(db, tenantId, { filter: f.filter, q: f.q }));
  return jsonResponse({ ...data, canManage: can(auth.ctx.role, "catalog:manage") });
});
