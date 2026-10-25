import { z } from "zod";
import { requireTenant } from "@/lib/auth/guard";
import { checkOrigin, errorResponse, jsonResponse, readJson, route } from "@/lib/auth/http";
import { withTenant } from "@/lib/db";
import { MAX_STOCK } from "@/lib/catalog/money";

const schema = z.object({ productId: z.uuid(), minStock: z.number().int().min(0).max(MAX_STOCK).nullable() });

/** «Avisar cuando queden X» de un producto (null = usar el valor general). */
export const POST = route(async (req) => {
  const blocked = checkOrigin(req);
  if (blocked) return blocked;
  const auth = await requireTenant(req, "catalog:manage");
  if (!auth.ok) return auth.response;
  const body = await readJson(req, schema);
  if (!body.ok) return body.response;
  const { tenantId } = auth.ctx;
  const r = await withTenant(tenantId, (db) =>
    db.query("UPDATE catalog_products SET min_stock = $3, updated_at = now() WHERE tenant_id = $1 AND id = $2", [tenantId, body.data.productId, body.data.minStock]),
  );
  if (r.rowCount !== 1) return errorResponse(404, "no_encontrado", "No encontrado.");
  return jsonResponse({ ok: true });
});
