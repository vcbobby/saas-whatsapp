import QRCode from "qrcode";
import { requireTenant } from "@/lib/auth/guard";
import { route } from "@/lib/auth/http";
import { withTenant } from "@/lib/db";
import { appLink } from "@/lib/email/outbox";

/** El código QR (imagen SVG) del enlace del catálogo público, para imprimir o compartir. */
export const GET = route(async (req) => {
  const auth = await requireTenant(req, "catalog:manage");
  if (!auth.ok) return auth.response;
  const { tenantId } = auth.ctx;
  const slug = (await withTenant(tenantId, (db) => db.query<{ slug: string }>("SELECT slug FROM tenants WHERE id = $1", [tenantId]))).rows[0]!.slug;
  const svg = await QRCode.toString(appLink(`/c/${slug}`), { type: "svg", margin: 2, errorCorrectionLevel: "M" });
  return new Response(svg, { headers: { "content-type": "image/svg+xml; charset=utf-8", "cache-control": "private, no-store", "content-disposition": 'inline; filename="catalogo-qr.svg"' } });
});
