import { requireTenant } from "@/lib/auth/guard";
import { jsonResponse, route } from "@/lib/auth/http";
import { can } from "@/lib/auth/permissions";
import { withTenant } from "@/lib/db";
import { isCurrency } from "@/lib/catalog/money";

/** Catálogo: moneda y productos (los activos primero). */
export const GET = route(async (req) => {
  const auth = await requireTenant(req, "catalog:read");
  if (!auth.ok) return auth.response;
  const { tenantId } = auth.ctx;
  const data = await withTenant(tenantId, async (db) => {
    const s = await db.query("SELECT currency FROM catalog_settings WHERE tenant_id = $1", [tenantId]);
    const p = await db.query(
      "SELECT id, name, description, unit, price_minor, stock, active FROM catalog_products WHERE tenant_id = $1 ORDER BY active DESC, lower(name) LIMIT 1000",
      [tenantId],
    );
    return { currency: s.rows[0]?.currency as string | undefined, products: p.rows };
  });
  return jsonResponse({
    currency: isCurrency(data.currency) ? data.currency : "USD",
    products: data.products.map((x) => ({ id: x.id, name: x.name, description: x.description, unit: x.unit, priceMinor: Number(x.price_minor), stock: x.stock, active: x.active })),
    canManage: can(auth.ctx.role, "catalog:manage"),
  });
});
