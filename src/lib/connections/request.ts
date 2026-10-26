import { decryptSecret, encryptSecret } from "@/lib/crypto";
import { type AppKind, TELEGRAM_CHAT_RE, TELEGRAM_TOKEN_RE, checkAppUrl, isSealed } from "./apps";
import { formatEventText } from "./format";

/** Datos de acceso de una app, tal como se guardan (cifrados). */
export type AppConfig = { url: string } | { token: string; chatId: string };

export const configAad = (tenantId: string, endpointId: string) => `wc:${tenantId}:${endpointId}`;

export function sealConfig(config: AppConfig, tenantId: string, endpointId: string) {
  const { payload, keyVersion } = encryptSecret(JSON.stringify(config), configAad(tenantId, endpointId));
  return { enc: payload, keyVersion };
}
export function openConfig(enc: string, keyVersion: number, tenantId: string, endpointId: string): AppConfig {
  return JSON.parse(decryptSecret(enc, configAad(tenantId, endpointId), keyVersion)) as AppConfig;
}

export interface AppRequest { url: string; headers: Record<string, string>; body: string }

const slackEscape = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** Arma la petición exacta para una app (dirección oficial + cuerpo propio de esa app). Devuelve un error legible si los datos guardados ya no sirven. */
export function buildAppRequest(kind: AppKind, config: AppConfig, eventType: string, payload: unknown): { ok: true; req: AppRequest } | { ok: false; reason: string } {
  const text = formatEventText(eventType, payload);
  const headers = { "content-type": "application/json" };
  if (kind === "telegram") {
    const c = config as { token?: string; chatId?: string };
    if (!c.token || !c.chatId || !TELEGRAM_TOKEN_RE.test(c.token) || !TELEGRAM_CHAT_RE.test(c.chatId)) return { ok: false, reason: "Los datos de Telegram guardados no son válidos. Vuelve a conectar la app." };
    return { ok: true, req: { url: `https://api.telegram.org/bot${c.token}/sendMessage`, headers, body: JSON.stringify({ chat_id: c.chatId, text, disable_web_page_preview: true }) } };
  }
  if (kind === "discord" || kind === "slack") {
    const u = (config as { url?: string }).url ?? "";
    const check = checkAppUrl(kind, u);
    if (!check.ok) return { ok: false, reason: "El enlace guardado ya no es válido. Vuelve a conectar la app." };
    const body = kind === "discord" ? { content: text, allowed_mentions: { parse: [] } } : { text: slackEscape(text) };
    return { ok: true, req: { url: check.url, headers, body: JSON.stringify(body) } };
  }
  return { ok: false, reason: "Tipo de conexión no soportado." };
}

/** Traduce el fallo de una app a algo que un negocio sin conocimientos técnicos pueda resolver. */
export function friendlyAppError(kind: AppKind, status: number | null, fallback: string | null): string | null {
  if (!isSealed(kind)) return fallback;
  const name = kind === "telegram" ? "Telegram" : kind === "discord" ? "Discord" : "Slack";
  if (status === 401 || status === 403 || status === 404) return `${name} ya no acepta esta conexión (el enlace o el bot fue borrado o cambiado). Bórrala y vuelve a conectar la app.`;
  if (status === 400 && kind === "telegram") return "Telegram no encuentra ese chat. Escríbele de nuevo a tu bot y vuelve a conectar.";
  if (status === 429) return `${name} pidió ir más despacio; se reintentará solo.`;
  return fallback;
}
