import { z } from "zod";
import { requireTenant } from "@/lib/auth/guard";
import { checkOrigin, errorResponse, jsonResponse, readJson, route } from "@/lib/auth/http";
import { withTenant } from "@/lib/db";
import { MAX_MINOR, MAX_STOCK } from "@/lib/catalog/money";

const MAX_ACTIVE_PRODUCTS = 500;

// Campos ausentes = no se tocan. «null» en descripción, presentación o stock = borrarlos (stock null = sin control).
const schema = z.object({
  id: z.uuid(),
  name: z.string().trim().min(1).max(120).optional(),
  description: z.string().trim().max(500).nullable().optional(),
  unit: z.string().trim().max(40).nullable().optional(),
  priceMinor: z.number().int().min(0).max(MAX_MINOR).optional(),
  stock: z.number().int().min(0).max(MAX_STOCK).nullable().optional(),
  active: z.boolean().optional(),
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
    const cur = await db.query("SELECT active FROM catalog_products WHERE tenant_id = $1 AND id = $2 FOR UPDATE", [tenantId, d.id]);
    if (cur.rowCount !== 1) return "no_existe" as const;
    if (d.active === true && !cur.rows[0].active) {
      const n = await db.query("SELECT count(*)::int AS n FROM catalog_products WHERE tenant_id = $1 AND active", [tenantId]);
      if (n.rows[0].n >= MAX_ACTIVE_PRODUCTS) return "limite" as const;
    }
    try {
      await db.query(
        `UPDATE catalog_products SET
            name = COALESCE($3, name),
            description = CASE WHEN $4::boolean THEN $5 ELSE description END,
            unit = CASE WHEN $6::boolean THEN $7 ELSE unit END,
            price_minor = COALESCE($8, price_minor),
            stock = CASE WHEN $9::boolean THEN $10 ELSE stock END,
            active = COALESCE($11, active),
            updated_at = now()
          WHERE tenant_id = $1 AND id = $2`,
        [tenantId, d.id, d.name ?? null, d.description !== undefined, d.description || null, d.unit !== undefined, d.unit || null, d.priceMinor ?? null, d.stock !== undefined, d.stock ?? null, d.active ?? null],
      );
      return "ok" as const;
    } catch (e) {
      if ((e as { code?: string }).code === "23505") return "duplicado" as const;
      throw e;
    }
  });
  if (out === "no_existe") return errorResponse(404, "no_encontrado", "No encontrado.");
  if (out === "limite") return errorResponse(409, "limite_productos", `Máximo ${MAX_ACTIVE_PRODUCTS} productos activos.`);
  if (out === "duplicado") return errorResponse(409, "producto_duplicado", "Ya tienes un producto activo con ese nombre.");
  return jsonResponse({ ok: true });
});
