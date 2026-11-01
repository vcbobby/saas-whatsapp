import { z } from "zod";
import { requireTenant } from "@/lib/auth/guard";
import { errorResponse, route } from "@/lib/auth/http";
import { withTenant } from "@/lib/db";
import { MEDIA_ERROR, loadMessageMedia } from "@/lib/payments/media";

/** La imagen del comprobante de un pedido. */
export const GET = route(async (req) => {
  const auth = await requireTenant(req, "orders:read");
  if (!auth.ok) return auth.response;
  const id = z.uuid().safeParse(new URL(req.url).searchParams.get("id"));
  if (!id.success) return errorResponse(400, "datos_invalidos", "Identificador inválido.");
  const { tenantId } = auth.ctx;
  const proof = await withTenant(tenantId, async (db) => (await db.query<{ proof_message_id: string | null }>("SELECT proof_message_id FROM orders WHERE tenant_id = $1 AND id = $2", [tenantId, id.data])).rows[0]?.proof_message_id);
  if (!proof) return errorResponse(404, "no_encontrado", "Este pedido no tiene comprobante.");
  const out = await loadMessageMedia(tenantId, proof);
  if (!out.ok) { const e = MEDIA_ERROR[out.reason]!; return errorResponse(e.status, e.code, e.message); }
  return new Response(new Uint8Array(out.bytes), {
    headers: { "content-type": out.mime, "cache-control": "private, no-store", "x-content-type-options": "nosniff", "content-security-policy": "default-src 'none'; sandbox", "content-disposition": "inline" },
  });
});
