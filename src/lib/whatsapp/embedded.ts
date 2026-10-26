import { randomInt } from "node:crypto";
import { getEmbeddedSignupConfig, getWhatsAppEnv } from "@/lib/env";
import { diagnosePhone, tokenExpiry } from "./diagnose";

export type EmbeddedResult =
  | { ok: true; accessToken: string; display: string; verifiedName: string | null; expiresAt: Date | null; warnings: string[] }
  | { ok: false; status: 400 | 404 | 502; code: string; message: string };

/**
 * Cierra la conexión con un clic: la ventana de Facebook entrega un «code» de un solo uso y los IDs del número y la cuenta.
 *  1) se cambia el code por el token del negocio (el secreto de la app solo sale del servidor, por POST),
 *  2) se comprueba que ese token controla ese número,
 *  3) se suscribe nuestra app a los mensajes de esa cuenta de WhatsApp (sin esto no llegarían),
 *  4) se registra el número para la API de la nube (si ya estaba registrado, no es un error).
 */
export async function completeEmbeddedSignup(input: { code: string; phoneNumberId: string; wabaId: string }, fetchImpl: typeof fetch = fetch): Promise<EmbeddedResult> {
  const cfg = getEmbeddedSignupConfig();
  if (!cfg) return { ok: false, status: 404, code: "no_disponible", message: "La conexión con un clic todavía no está activada." };
  const { WHATSAPP_GRAPH_VERSION: v } = getWhatsAppEnv();
  const g = (path: string) => `https://graph.facebook.com/${v}/${path}`;
  const opts = { signal: AbortSignal.timeout(12_000), redirect: "error" as const };

  let token: string;
  try {
    const res = await fetchImpl(g("oauth/access_token"), {
      method: "POST", ...opts,
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: cfg.appId, client_secret: cfg.appSecret, code: input.code }).toString(),
    });
    const j = (await res.json().catch(() => null)) as { access_token?: string } | null;
    if (!res.ok || !j?.access_token || !/^\S{20,1000}$/.test(j.access_token)) return { ok: false, status: 400, code: "codigo_invalido", message: "Facebook no aceptó la autorización (el código ya se usó o venció). Vuelve a pulsar «Conectar con Facebook»." };
    token = j.access_token;
  } catch {
    return { ok: false, status: 502, code: "meta_no_responde", message: "No se pudo hablar con Meta. Inténtalo de nuevo en un momento." };
  }

  const d = await diagnosePhone(input.phoneNumberId, token, fetchImpl);
  if (!d.ok) return { ok: false, status: 400, code: "numero_no_valido", message: d.message };

  const warnings: string[] = [];
  try {
    const sub = await fetchImpl(g(`${input.wabaId}/subscribed_apps`), { method: "POST", ...opts, headers: { Authorization: `Bearer ${token}` } });
    if (!sub.ok) return { ok: false, status: 502, code: "suscripcion_fallo", message: "Se conectó el número, pero no se pudo activar la recepción de mensajes. Inténtalo de nuevo; si sigue igual, avísanos." };
  } catch {
    return { ok: false, status: 502, code: "meta_no_responde", message: "No se pudo hablar con Meta. Inténtalo de nuevo en un momento." };
  }
  try {
    const reg = await fetchImpl(g(`${input.phoneNumberId}/register`), {
      method: "POST", ...opts,
      headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ messaging_product: "whatsapp", pin: String(randomInt(100000, 1000000)) }),
    });
    if (!reg.ok) warnings.push("El número ya estaba registrado o Meta pidió un paso extra; si no recibes mensajes, revisa el estado del número en Meta.");
  } catch {
    warnings.push("No se pudo confirmar el registro del número.");
  }
  const exp = await tokenExpiry(token, fetchImpl);
  return { ok: true, accessToken: token, display: d.info.displayPhoneNumber, verifiedName: d.info.verifiedName, expiresAt: exp instanceof Date ? exp : null, warnings };
}
