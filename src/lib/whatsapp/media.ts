import { getWhatsAppEnv } from "@/lib/env";

export const MAX_MEDIA_BYTES = 5 * 1024 * 1024;
export type MediaResult = { ok: true; bytes: Buffer; mime: "image/jpeg" | "image/png" | "image/webp" } | { ok: false; reason: "expirada" | "grande" | "formato" | "red" };

const MIMES = new Set(["image/jpeg", "image/png", "image/webp"]);

/**
 * Descarga una imagen recibida por WhatsApp (dos pasos: pedir a Meta su dirección temporal y bajar el archivo con el mismo token).
 * Meta guarda los archivos unos 30 días: pasado ese tiempo responde que ya no existe ("expirada").
 * `fetchImpl` se puede cambiar en los tests.
 */
export async function fetchWhatsAppMedia(mediaId: string, accessToken: string, fetchImpl: typeof fetch = fetch): Promise<MediaResult> {
  if (!/^[A-Za-z0-9_-]{1,200}$/.test(mediaId)) return { ok: false, reason: "formato" };
  const { WHATSAPP_GRAPH_VERSION } = getWhatsAppEnv();
  const headers = { Authorization: `Bearer ${accessToken}` };
  try {
    const meta = await fetchImpl(`https://graph.facebook.com/${WHATSAPP_GRAPH_VERSION}/${mediaId}`, { headers, signal: AbortSignal.timeout(8_000), redirect: "error" });
    if (meta.status === 404 || meta.status === 400) return { ok: false, reason: "expirada" };
    if (!meta.ok) return { ok: false, reason: "red" };
    const info = (await meta.json()) as { url?: string; mime_type?: string; file_size?: number };
    const mime = (info.mime_type ?? "").toLowerCase().split(";")[0]!.trim();
    if (!MIMES.has(mime)) return { ok: false, reason: "formato" };
    if (typeof info.file_size === "number" && info.file_size > MAX_MEDIA_BYTES) return { ok: false, reason: "grande" };
    // Solo se descarga de los servidores de Meta (nunca de una dirección que venga en otro dominio).
    let host = "";
    try { host = new URL(String(info.url)).hostname; } catch { return { ok: false, reason: "red" }; }
    if (!/(^|\.)(facebook\.com|fbcdn\.net|fbsbx\.com|whatsapp\.net|whatsapp\.com)$/.test(host)) return { ok: false, reason: "red" };
    const file = await fetchImpl(String(info.url), { headers, signal: AbortSignal.timeout(15_000), redirect: "error" });
    if (file.status === 404 || file.status === 410) return { ok: false, reason: "expirada" };
    if (!file.ok) return { ok: false, reason: "red" };
    const buf = Buffer.from(await file.arrayBuffer());
    if (buf.length > MAX_MEDIA_BYTES) return { ok: false, reason: "grande" };
    return { ok: true, bytes: buf, mime: mime as "image/jpeg" | "image/png" | "image/webp" };
  } catch {
    return { ok: false, reason: "red" };
  }
}
