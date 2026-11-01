import { z } from "zod";
import { requireTenant } from "@/lib/auth/guard";
import { errorResponse, route } from "@/lib/auth/http";
import { MEDIA_ERROR, loadMessageMedia } from "@/lib/payments/media";

/** La imagen que mandó un cliente (se descarga de WhatsApp al verla; no se guarda en nuestros servidores). */
export const GET = route(async (req) => {
  const auth = await requireTenant(req, "conversations:read");
  if (!auth.ok) return auth.response;
  const id = z.uuid().safeParse(new URL(req.url).searchParams.get("id"));
  if (!id.success) return errorResponse(400, "datos_invalidos", "Identificador inválido.");
  const out = await loadMessageMedia(auth.ctx.tenantId, id.data);
  if (!out.ok) { const e = MEDIA_ERROR[out.reason]!; return errorResponse(e.status, e.code, e.message); }
  return new Response(new Uint8Array(out.bytes), {
    headers: { "content-type": out.mime, "cache-control": "private, no-store", "x-content-type-options": "nosniff", "content-security-policy": "default-src 'none'; sandbox", "content-disposition": "inline" },
  });
});
