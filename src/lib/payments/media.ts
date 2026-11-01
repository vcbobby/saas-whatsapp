import { withTenant } from "@/lib/db";
import { loadIntegration } from "@/lib/whatsapp/integration";
import { fetchWhatsAppMedia, type MediaResult } from "@/lib/whatsapp/media";

export type LoadedMedia = MediaResult | { ok: false; reason: "no_existe" | "sin_whatsapp" };

/** Baja la imagen de un mensaje del negocio. Verifica que el mensaje sea de ESE negocio y tenga imagen. */
export async function loadMessageMedia(tenantId: string, messageId: string, fetchImpl?: typeof fetch): Promise<LoadedMedia> {
  const row = await withTenant(tenantId, async (db) =>
    (await db.query<{ media_id: string | null }>("SELECT media_id FROM messages WHERE tenant_id = $1 AND id = $2", [tenantId, messageId])).rows[0]);
  if (!row?.media_id) return { ok: false, reason: "no_existe" };
  const integ = await loadIntegration(tenantId);
  if (!integ) return { ok: false, reason: "sin_whatsapp" };
  return fetchWhatsAppMedia(row.media_id, integ.accessToken, fetchImpl);
}

export const MEDIA_ERROR: Record<string, { status: number; code: string; message: string }> = {
  no_existe: { status: 404, code: "no_encontrado", message: "No encontrado." },
  sin_whatsapp: { status: 409, code: "sin_whatsapp", message: "Conecta tu WhatsApp para ver las imágenes." },
  expirada: { status: 410, code: "expirada", message: "Esta imagen ya no está disponible (WhatsApp las guarda unos 30 días)." },
  grande: { status: 413, code: "muy_grande", message: "La imagen es demasiado grande para mostrarla." },
  formato: { status: 415, code: "formato", message: "No se puede mostrar este tipo de archivo." },
  red: { status: 502, code: "sin_conexion", message: "No se pudo descargar la imagen ahora. Intenta de nuevo." },
};
