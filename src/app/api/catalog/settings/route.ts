import { z } from "zod";
import { requireTenant } from "@/lib/auth/guard";
import { checkOrigin, jsonResponse, readJson, route } from "@/lib/auth/http";
import { withTenant } from "@/lib/db";
import { CURRENCIES } from "@/lib/catalog/money";

const schema = z.object({ currency: z.enum(CURRENCIES) });

/** Moneda del catálogo. Cambiarla NO convierte los precios: solo cambia cómo se muestran. */
export const PUT = route(async (req) => {
  const blocked = checkOrigin(req);
  if (blocked) return blocked;
  const auth = await requireTenant(req, "catalog:manage");
  if (!auth.ok) return auth.response;
  const body = await readJson(req, schema);
  if (!body.ok) return body.response;
  const { tenantId, userId } = { tenantId: auth.ctx.tenantId, userId: auth.session.userId };
  await withTenant(tenantId, (db) =>
    db.query(
      `INSERT INTO catalog_settings (tenant_id, currency, updated_by) VALUES ($1, $2, $3)
       ON CONFLICT (tenant_id) DO UPDATE SET currency = EXCLUDED.currency, updated_at = now(), updated_by = EXCLUDED.updated_by`,
      [tenantId, body.data.currency, userId],
    ),
  );
  return jsonResponse({ ok: true });
});
