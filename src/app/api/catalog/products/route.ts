import { z } from "zod";
import { requireTenant } from "@/lib/auth/guard";
import { checkOrigin, errorResponse, jsonResponse, readJson, route } from "@/lib/auth/http";
import { withTenant } from "@/lib/db";
import { MAX_MINOR, MAX_STOCK } from "@/lib/catalog/money";
import { clearStockContext, setStockContext } from "@/lib/inventory/service";

const MAX_ACTIVE_PRODUCTS = 500;

const schema = z.object({
  name: z.string().trim().min(1, "Escribe el nombre del producto").max(120, "Máximo 120 caracteres"),
  description: z.string().trim().max(500, "Máximo 500 caracteres").optional(),
  unit: z.string().trim().max(40, "Máximo 40 caracteres").optional(),
  priceMinor: z.number().int("Precio inválido").min(0, "El precio no puede ser negativo").max(MAX_MINOR, "Precio demasiado grande"),
  stock: z.number().int().min(0, "El stock no puede ser negativo").max(MAX_STOCK).nullable().optional(),
});

export const POST = route(async (req) => {
  const blocked = checkOrigin(req);
  if (blocked) return blocked;
  const auth = await requireTenant(req, "catalog:manage");
  if (!auth.ok) return auth.response;
  const body = await readJson(req, schema);
  if (!body.ok) return body.response;
  const { tenantId } = auth.ctx;
  const d = body.data;
  const out = await withTenant(tenantId, async (db) => {
    const n = await db.query("SELECT count(*)::int AS n FROM catalog_products WHERE tenant_id = $1 AND active", [tenantId]);
    if (n.rows[0].n >= MAX_ACTIVE_PRODUCTS) return "limite" as const;
    try {
      await setStockContext(db, { kind: "edicion", userId: auth.session.userId });
      const r = await db.query(
        "INSERT INTO catalog_products (tenant_id, name, description, unit, price_minor, stock) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id",
        [tenantId, d.name, d.description || null, d.unit || null, d.priceMinor, d.stock ?? null],
      );
      await clearStockContext(db);
      return r.rows[0].id as string;
    } catch (e) {
      if ((e as { code?: string }).code === "23505") return "duplicado" as const;
      throw e;
    }
  });
  if (out === "limite") return errorResponse(409, "limite_productos", `Máximo ${MAX_ACTIVE_PRODUCTS} productos activos.`);
  if (out === "duplicado") return errorResponse(409, "producto_duplicado", "Ya tienes un producto activo con ese nombre.");
  return jsonResponse({ ok: true, id: out }, 201);
});
