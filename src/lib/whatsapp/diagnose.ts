import { getMetaAppId, getWhatsAppEnv } from "@/lib/env";

/** Limpia lo que la gente pega: comillas, «Bearer », saltos de línea. */
export function normalizeToken(raw: string): string {
  const q = (v: string) => v.trim().replace(/^["'`]+|["'`]+$/g, "").trim();
  return q(q(raw).replace(/^bearer\s+/i, "")).replace(/\s+/g, "");
}
export function normalizePhoneId(raw: string): string {
  return raw.trim().replace(/[\s.]/g, "");
}
/** ¿Parece un número de teléfono y no el «ID del número»? (con +, guiones, paréntesis o muy parecido a un teléfono). */
export function looksLikePhoneNumber(raw: string): boolean {
  const t = raw.trim();
  return /^\+/.test(t) || /[\s\-()]/.test(t) || /^(58|1|52|57|54|34)\d{9,11}$/.test(t.replace(/\D/g, ""));
}

export interface PhoneStatus {
  displayPhoneNumber: string;
  verifiedName: string | null;
  quality: string | null;
}
export type Diagnosis =
  | { ok: true; info: PhoneStatus }
  | { ok: false; reason: "token" | "permisos" | "id" | "red" | "limite" | "otro"; message: string };

/** Traduce el error de Meta a una instrucción que pueda seguir alguien sin conocimientos técnicos. */
export function explainMetaError(status: number, code: number | null, message?: string): Diagnosis & { ok: false } {
  if (code === 190 || status === 401) return { ok: false, reason: "token", message: "El token venció o no es válido. Los tokens temporales de Meta duran solo unas 24 horas: genera uno nuevo en «Configuración de la API» (o crea un token permanente con un usuario del sistema)." };
  if (code === 10 || code === 200 || code === 299 || code === 3 || status === 403) return { ok: false, reason: "permisos", message: "El token no tiene permiso para este número. Al generarlo marca los permisos whatsapp_business_messaging y whatsapp_business_management, y asigna tu cuenta de WhatsApp al usuario del sistema." };
  if (code === 100 || code === 33 || status === 404 || status === 400) return { ok: false, reason: "id", message: "Meta no encuentra ese ID de número. Recuerda que no es el número de teléfono: es el «Phone number ID», un código largo de solo dígitos que aparece en «Configuración de la API», justo debajo del número." };
  if (code === 4 || code === 17 || code === 613 || status === 429) return { ok: false, reason: "limite", message: "Meta pidió ir más despacio. Espera un minuto e inténtalo de nuevo." };
  return { ok: false, reason: "otro", message: `Meta respondió con un error${message ? `: ${message.slice(0, 120)}` : ""}. Revisa el ID y el token e inténtalo de nuevo.` };
}

/** Comprueba ID + token con Meta y explica qué falla. Usa los mismos datos que fetchPhoneInfo, más la calidad del número. */
export async function diagnosePhone(phoneNumberId: string, accessToken: string, fetchImpl: typeof fetch = fetch, extra = false): Promise<Diagnosis> {
  if (!/^\d{5,30}$/.test(phoneNumberId)) return { ok: false, reason: "id", message: "El ID del número son solo dígitos (sin +, espacios ni guiones). No es el número de teléfono." };
  const { WHATSAPP_GRAPH_VERSION } = getWhatsAppEnv();
  const fields = extra ? "display_phone_number,verified_name,quality_rating" : "display_phone_number,verified_name";
  let res: Response;
  try {
    res = await fetchImpl(`https://graph.facebook.com/${WHATSAPP_GRAPH_VERSION}/${phoneNumberId}?fields=${fields}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(8_000),
      redirect: "error",
    });
  } catch {
    return { ok: false, reason: "red", message: "No se pudo hablar con Meta ahora mismo. Revisa tu internet e inténtalo de nuevo en un momento." };
  }
  const json = (await res.json().catch(() => null)) as { id?: string; display_phone_number?: string; verified_name?: string; quality_rating?: string; error?: { code?: number; message?: string } } | null;
  if (!res.ok) return explainMetaError(res.status, typeof json?.error?.code === "number" ? json.error.code : null, json?.error?.message);
  if ((json?.id !== undefined && json.id !== phoneNumberId) || !json?.display_phone_number) return { ok: false, reason: "id", message: "Meta respondió, pero ese ID no corresponde a un número de WhatsApp. Revisa que copiaste el «Phone number ID»." };
  return { ok: true, info: { displayPhoneNumber: String(json.display_phone_number).slice(0, 40), verifiedName: json.verified_name ? String(json.verified_name).slice(0, 200) : null, quality: json.quality_rating ? String(json.quality_rating).slice(0, 20) : null } };
}

/** Cuándo vence un token (solo si se configuró META_APP_ID). null = no vence; undefined = no se pudo saber. */
export async function tokenExpiry(accessToken: string, fetchImpl: typeof fetch = fetch): Promise<Date | null | undefined> {
  const appId = getMetaAppId();
  const secret = process.env.WHATSAPP_APP_SECRET;
  if (!appId || !secret) return undefined;
  const { WHATSAPP_GRAPH_VERSION } = getWhatsAppEnv();
  try {
    const res = await fetchImpl(`https://graph.facebook.com/${WHATSAPP_GRAPH_VERSION}/debug_token?input_token=${encodeURIComponent(accessToken)}`, {
      headers: { Authorization: `Bearer ${appId}|${secret}` },
      signal: AbortSignal.timeout(8_000),
      redirect: "error",
    });
    if (!res.ok) return undefined;
    const j = (await res.json()) as { data?: { is_valid?: boolean; expires_at?: number; data_access_expires_at?: number } };
    if (!j.data || j.data.is_valid === false) return undefined;
    const e = j.data.expires_at;
    if (e === 0) return null; // no vence
    return typeof e === "number" && e > 0 ? new Date(e * 1000) : undefined;
  } catch {
    return undefined;
  }
}
