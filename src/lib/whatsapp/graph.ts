import { randomUUID } from "node:crypto";
import { getSendMode, getWhatsAppEnv } from "@/lib/env";

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
  // Modo simulación (solo desarrollo): no se contacta a Meta; el mensaje queda como enviado.
  if (getSendMode() === "simulate") return { kind: "sent", waMessageId: `wamid.SIM.${randomUUID()}` };
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

/**
 * Mensaje de prueba con la plantilla «hello_world» (la trae todo número de prueba de Meta). Sirve cuando el texto libre no se
 * puede enviar porque el destinatario no ha escrito en las últimas 24 h.
 */
export async function sendHelloTemplate(phoneNumberId: string, accessToken: string, to: string, fetchImpl: typeof fetch = fetch): Promise<SendResult> {
  if (!/^\d{5,30}$/.test(phoneNumberId) || !/^\d{5,32}$/.test(to)) return { kind: "rejected", status: 0, code: null, message: "Datos inválidos" };
  if (getSendMode() === "simulate") return { kind: "sent", waMessageId: `wamid.SIM.${randomUUID()}` };
  const { WHATSAPP_GRAPH_VERSION } = getWhatsAppEnv();
  try {
    const res = await fetchImpl(`https://graph.facebook.com/${WHATSAPP_GRAPH_VERSION}/${phoneNumberId}/messages`, {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}`, "content-type": "application/json" },
      body: JSON.stringify({ messaging_product: "whatsapp", to, type: "template", template: { name: "hello_world", language: { code: "en_US" } } }),
      signal: AbortSignal.timeout(10_000),
      redirect: "error",
    });
    const json = (await res.json().catch(() => null)) as { messages?: { id?: unknown }[]; error?: { message?: unknown; code?: unknown } } | null;
    if (res.ok) {
      const id = json?.messages?.[0]?.id;
      return typeof id === "string" ? { kind: "sent", waMessageId: id } : { kind: "unknown", reason: "sin id de mensaje" };
    }
    if (res.status >= 500 || res.status === 429) return { kind: "retry", reason: `Meta respondió ${res.status}` };
    return { kind: "rejected", status: res.status, code: typeof json?.error?.code === "number" ? json.error.code : null, message: typeof json?.error?.message === "string" ? json.error.message.slice(0, 250) : `HTTP ${res.status}` };
  } catch {
    return { kind: "unknown", reason: "error de red" };
  }
}

/** Traduce por qué falló un envío de prueba a una instrucción clara. */
export function explainSendError(status: number, code: number | null): string {
  if (code === 190 || status === 401) return "El token venció o no es válido. Genera uno nuevo y vuelve a conectar el número.";
  if (code === 131030) return "Ese teléfono no está en la lista de destinatarios de prueba de Meta. En Meta: WhatsApp → Configuración de la API → «Para» → agrega ese número y confirma el código que te llega.";
  if (code === 131047 || code === 131026) return "Ese teléfono no ha escrito en las últimas 24 horas (o no tiene WhatsApp). Escríbele primero un mensaje al número del negocio y vuelve a probar.";
  if (code === 131042) return "Meta pide un método de pago en tu cuenta de WhatsApp Business para poder enviar. Agrégalo en Meta → Facturación.";
  if (code === 133010 || code === 133004) return "El número todavía no está registrado en Meta para enviar. Termina de verificar el número en el panel de Meta.";
  if (code === 131031) return "Meta bloqueó la cuenta de WhatsApp Business. Revisa el aviso en tu administrador de Meta.";
  if (code === 10 || code === 200 || status === 403) return "El token no tiene permiso para enviar mensajes. Genera uno con el permiso whatsapp_business_messaging.";
  return "Meta no aceptó el mensaje de prueba. Revisa el panel de Meta o inténtalo de nuevo en un momento.";
}
