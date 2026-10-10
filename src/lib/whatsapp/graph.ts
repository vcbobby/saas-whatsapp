import { getWhatsAppEnv } from "@/lib/env";

export interface PhoneInfo {
  displayPhoneNumber: string;
  verifiedName: string | null;
}

/**
 * Comprueba con Meta que el token realmente controla ese número.
 * Evita que alguien "reserve" el número de otro negocio solo conociendo su id.
 * `fetchImpl` se puede cambiar en los tests.
 */
export async function fetchPhoneInfo(
  phoneNumberId: string,
  accessToken: string,
  fetchImpl: typeof fetch = fetch,
): Promise<PhoneInfo | null> {
  if (!/^\d{5,30}$/.test(phoneNumberId)) return null;
  const { WHATSAPP_GRAPH_VERSION } = getWhatsAppEnv();
  const url = `https://graph.facebook.com/${WHATSAPP_GRAPH_VERSION}/${phoneNumberId}?fields=display_phone_number,verified_name`;
  try {
    const res = await fetchImpl(url, {
      headers: { Authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(8_000),
      redirect: "error",
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { id?: string; display_phone_number?: string; verified_name?: string };
    if (data.id !== undefined && data.id !== phoneNumberId) return null;
    if (!data.display_phone_number) return null;
    return {
      displayPhoneNumber: String(data.display_phone_number).slice(0, 40),
      verifiedName: data.verified_name ? String(data.verified_name).slice(0, 200) : null,
    };
  } catch {
    return null;
  }
}

// ------------------------------------------------------------------ envío
/**
 * Resultado de intentar enviar un texto. La diferencia importa:
 *  - sent:     Meta lo aceptó.
 *  - rejected: Meta respondió con error 4xx (token vencido, ventana de 24 h cerrada…): NO se envió.
 *  - retry:    falló antes de llegar a Meta (sin red, límite de ritmo): NO se envió, se puede reintentar.
 *  - unknown:  tiempo agotado o error 5xx: pudo enviarse o no. NO se reintenta (evita mensajes duplicados).
 */
export type SendResult =
  | { kind: "sent"; waMessageId: string }
  | { kind: "rejected"; status: number; code: number | null; message: string }
  | { kind: "retry"; reason: string }
  | { kind: "unknown"; reason: string };

// Errores de red que ocurren ANTES de enviar la petición: seguro reintentar.
const PRE_SEND_CODES = new Set(["ENOTFOUND", "EAI_AGAIN", "ECONNREFUSED", "ENETUNREACH", "EHOSTUNREACH", "ERR_SSL_PROTOCOL_ERROR", "CERT_HAS_EXPIRED"]);

export async function sendText(
  phoneNumberId: string,
  accessToken: string,
  to: string,
  body: string,
  fetchImpl: typeof fetch = fetch,
): Promise<SendResult> {
  if (!/^\d{5,30}$/.test(phoneNumberId)) return { kind: "rejected", status: 0, code: null, message: "ID de número inválido" };
  if (!/^\d{5,32}$/.test(to)) return { kind: "rejected", status: 0, code: null, message: "Número de destino inválido" };
  if (body.length === 0 || body.length > 4096) return { kind: "rejected", status: 0, code: null, message: "Texto vacío o demasiado largo" };
  const { WHATSAPP_GRAPH_VERSION } = getWhatsAppEnv();
  let res: Response;
  try {
    res = await fetchImpl(`https://graph.facebook.com/${WHATSAPP_GRAPH_VERSION}/${phoneNumberId}/messages`, {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}`, "content-type": "application/json" },
      body: JSON.stringify({ messaging_product: "whatsapp", recipient_type: "individual", to, type: "text", text: { preview_url: false, body } }),
      signal: AbortSignal.timeout(10_000),
      redirect: "error",
    });
  } catch (err) {
    const e = err as { name?: string; cause?: { code?: string } };
    if (e.name === "TimeoutError" || e.name === "AbortError") return { kind: "unknown", reason: "tiempo agotado" };
    const code = e.cause?.code;
    if (code && PRE_SEND_CODES.has(code)) return { kind: "retry", reason: code };
    return { kind: "unknown", reason: code ?? "error de red" };
  }

  type SendResponse = { messages?: { id?: unknown }[]; error?: { message?: unknown; code?: unknown } };
  const json = (await res.json().catch(() => null)) as SendResponse | null;
  if (res.ok) {
    const id = json?.messages?.[0]?.id;
    if (typeof id === "string" && /^[\w.=\-+/]{5,200}$/.test(id)) return { kind: "sent", waMessageId: id };
    return { kind: "unknown", reason: "Meta respondió OK sin id de mensaje" };
  }
  if (res.status === 429) return { kind: "retry", reason: "límite de ritmo de Meta" };
  if (res.status >= 500) return { kind: "unknown", reason: `Meta respondió ${res.status}` };
  const code = typeof json?.error?.code === "number" ? json.error.code : null;
  const message = typeof json?.error?.message === "string" ? json.error.message.slice(0, 250) : `HTTP ${res.status}`;
  return { kind: "rejected", status: res.status, code, message };
}
