import { z } from "zod";
import { requireTenant } from "@/lib/auth/guard";
import { checkOrigin, errorResponse, jsonResponse, readJson, route } from "@/lib/auth/http";
import { withTenant } from "@/lib/db";
import { appLink } from "@/lib/email/outbox";
import { normalizePhone } from "@/lib/storefront/pure";

async function slugOf(tenantId: string): Promise<string> {
  return (await withTenant(tenantId, (db) => db.query<{ slug: string }>("SELECT slug FROM tenants WHERE id = $1", [tenantId]))).rows[0]!.slug;
}

export const GET = route(async (req) => {
  const auth = await requireTenant(req, "catalog:manage");
  if (!auth.ok) return auth.response;
  const { tenantId } = auth.ctx;
  const { row, count, slug } = await withTenant(tenantId, async (db) => ({
    row: (await db.query<{ enabled: boolean; phone: string | null; intro: string | null }>("SELECT enabled, phone, intro FROM public_catalog WHERE tenant_id = $1", [tenantId])).rows[0],
    count: (await db.query<{ n: number }>("SELECT count(*)::int AS n FROM catalog_products WHERE tenant_id = $1 AND active", [tenantId])).rows[0]!.n,
    slug: (await db.query<{ slug: string }>("SELECT slug FROM tenants WHERE id = $1", [tenantId])).rows[0]!.slug,
  }));
  return jsonResponse({ enabled: row?.enabled ?? false, phone: row?.phone ?? "", intro: row?.intro ?? "", products: count, url: appLink(`/c/${slug}`) });
});

const schema = z.object({
  enabled: z.boolean(),
  phone: z.string().trim().max(40),
  intro: z.string().trim().max(300, "La introducción admite hasta 300 letras"),
});

export const PUT = route(async (req) => {
  const blocked = checkOrigin(req);
  if (blocked) return blocked;
  const auth = await requireTenant(req, "catalog:manage");
  if (!auth.ok) return auth.response;
  const body = await readJson(req, schema);
  if (!body.ok) return body.response;
  const d = body.data;
  const phone = d.phone ? normalizePhone(d.phone) : null;
  if (d.phone && !phone) return errorResponse(400, "datos_invalidos", "Escribe el WhatsApp con código de país y sin el 0 inicial (por ejemplo 58 412 1234567).");
  if (d.enabled && !phone) return errorResponse(400, "datos_invalidos", "Para publicar, escribe el número de WhatsApp al que te van a escribir.");
  const { tenantId } = auth.ctx;
  await withTenant(tenantId, async (db) => {
    await db.query(
      `INSERT INTO public_catalog (tenant_id, enabled, phone, intro) VALUES ($1,$2,$3,$4)
       ON CONFLICT (tenant_id) DO UPDATE SET enabled = EXCLUDED.enabled, phone = EXCLUDED.phone, intro = EXCLUDED.intro, updated_at = now()`,
      [tenantId, d.enabled, phone, d.intro || null]);
    await db.query("INSERT INTO audit_log (tenant_id, actor_id, action, target_type, metadata) VALUES ($1,$2,'storefront.update','tenant',$3::jsonb)", [tenantId, auth.session.userId, JSON.stringify({ enabled: d.enabled })]);
  });
  return jsonResponse({ ok: true, url: appLink(`/c/${await slugOf(tenantId)}`) });
});
