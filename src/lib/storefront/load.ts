import { getPool, withTenant } from "@/lib/db";
import { isCurrency, type Currency } from "@/lib/catalog/money";
import { tenantHasModule } from "@/lib/plans/modules";

export interface StoreProduct { id: string; name: string; description: string | null; unit: string | null; priceMinor: number; soldOut: boolean }
export interface Store { business: string; phone: string; intro: string | null; currency: Currency; products: StoreProduct[] }

/** El catálogo público de un negocio por su slug; null si no existe, no está publicado o no está al día. Solo datos que el negocio quiere mostrar. */
export async function loadStore(slug: string): Promise<Store | null> {
  if (!/^[a-z0-9][a-z0-9-]{1,48}[a-z0-9]$/i.test(slug)) return null;
  const r = await getPool().query<{ out_tenant_id: string; out_name: string; out_phone: string; out_intro: string | null }>("SELECT * FROM public_catalog_lookup($1)", [slug]);
  const row = r.rows[0];
  if (!row) return null;
  const tenantId = row.out_tenant_id;
  if (!(await tenantHasModule(tenantId, "catalogo"))) return null;
  const data = await withTenant(tenantId, async (db) => {
    const cur = await db.query<{ currency: string }>("SELECT currency FROM catalog_settings WHERE tenant_id = $1", [tenantId]);
    const prods = await db.query<{ id: string; name: string; description: string | null; unit: string | null; price_minor: string; stock: number | null }>(
      "SELECT id, name, description, unit, price_minor, stock FROM catalog_products WHERE tenant_id = $1 AND active ORDER BY name LIMIT 200", [tenantId]);
    return { currency: cur.rows[0]?.currency, prods: prods.rows };
  });
  return {
    business: row.out_name, phone: row.out_phone, intro: row.out_intro,
    currency: isCurrency(data.currency) ? data.currency : "USD",
    products: data.prods.map((p) => ({ id: p.id, name: p.name, description: p.description, unit: p.unit, priceMinor: Number(p.price_minor), soldOut: p.stock !== null && p.stock <= 0 })),
  };
}
