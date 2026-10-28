import { randomUUID } from "node:crypto";
import { getSendMode, getWhatsAppEnv } from "@/lib/env";
import type { SendResult } from "./graph";

// ------------------------------------------------------------------ reglas puras (se prueban sin red)
export const MAX_VARIABLES = 10;
export const MAX_BODY = 1024;
export const LANGUAGES = [
  { code: "es", label: "Español" },
  { code: "es_MX", label: "Español (México)" },
  { code: "es_ES", label: "Español (España)" },
  { code: "es_AR", label: "Español (Argentina)" },
  { code: "en_US", label: "Inglés" },
  { code: "pt_BR", label: "Portugués (Brasil)" },
] as const;

/** Nombre aceptado por Meta: minúsculas, números y guion bajo. Convierte «Recordatorio de cita» → «recordatorio_de_cita». */
export function suggestName(raw: string): string {
  return raw.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 60);
}
export const validName = (n: string) => /^[a-z0-9_]{1,100}$/.test(n);

/** Números de variable {{1}} {{2}}… que aparecen en el texto, sin repetir y en orden. */
export function variablesOf(body: string): number[] {
  return [...new Set([...body.matchAll(/\{\{\s*(\d{1,2})\s*\}\}/g)].map((m) => Number(m[1])))].sort((a, b) => a - b);
}

/** Valida el cuerpo según las reglas de Meta que se pueden comprobar sin llamarlo. Devuelve el texto de error o null. */
export function bodyError(body: string, examples: string[]): string | null {
  const t = body.trim();
  if (t.length === 0) return "Escribe el texto del mensaje.";
  if (t.length > MAX_BODY) return `El texto es demasiado largo (máximo ${MAX_BODY} caracteres).`;
  if (/\{\{(?!\s*\d{1,2}\s*\}\})/.test(t) || /(?<!\{)\{(?!\{)|(?<!\})\}(?!\})/.test(t.replace(/\{\{\s*\d{1,2}\s*\}\}/g, ""))) return "Las variables se escriben {{1}}, {{2}}… (números entre dobles llaves). No uses otras llaves.";
  const vars = variablesOf(t);
  if (vars.length > MAX_VARIABLES) return `Máximo ${MAX_VARIABLES} variables.`;
  if (vars.some((v, i) => v !== i + 1)) return "Las variables deben ir en orden sin saltos: {{1}}, {{2}}, {{3}}…";
  if (/^\s*\{\{/.test(t) || /\}\}\s*$/.test(t)) return "El texto no puede empezar ni terminar con una variable. Agrega una palabra antes y después (por ejemplo «Hola {{1}},» al inicio y «¡Gracias!» al final).";
  if (/\{\{\s*\d+\s*\}\}\s*\{\{/.test(t)) return "No pongas dos variables pegadas; sepáralas con una palabra.";
  if (/\n{3,}/.test(t) || / {5,}/.test(t)) return "Evita más de 2 saltos de línea seguidos o 4 espacios seguidos.";
  if (examples.length !== vars.length) return `Falta un ejemplo por cada variable (hay ${vars.length}). Meta los pide para revisar la plantilla.`;
  if (examples.some((e) => e.trim().length === 0 || e.length > 100)) return "Cada ejemplo debe tener texto (máximo 100 caracteres).";
  return null;
}

/** Texto final con las variables reemplazadas (lo que verá el cliente; se guarda en la conversación). */
export function renderBody(body: string, params: string[]): string {
  return body.replace(/\{\{\s*(\d{1,2})\s*\}\}/g, (_, n: string) => params[Number(n) - 1] ?? "");
}
/** Meta rechaza saltos de línea, tabulaciones y 4+ espacios dentro de una variable. */
export function cleanParam(v: string): string {
  return v.replace(/[\r\n\t]+/g, " ").replace(/ {2,}/g, " ").trim().slice(0, 600);
}

// ------------------------------------------------------------------ Meta
const graph = () => `https://graph.facebook.com/${getWhatsAppEnv().WHATSAPP_GRAPH_VERSION}`;
export interface MetaError { status: number; code: number | null; message: string }
export type Meta<T> = { ok: true; data: T } | { ok: false; error: MetaError } | { ok: false; error: null; network: string };

async function call<T>(url: string, token: string, init: RequestInit, fetchImpl: typeof fetch): Promise<Meta<T>> {
  try {
    const res = await fetchImpl(url, { ...init, headers: { Authorization: `Bearer ${token}`, ...(init.body ? { "content-type": "application/json" } : {}) }, signal: AbortSignal.timeout(15_000), redirect: "error" });
    const json = (await res.json().catch(() => null)) as (T & { error?: { code?: unknown; message?: unknown; error_user_msg?: unknown } }) | null;
    if (res.ok) return { ok: true, data: (json ?? {}) as T };
    const e = json?.error;
    const msg = typeof e?.error_user_msg === "string" ? e.error_user_msg : typeof e?.message === "string" ? e.message : `HTTP ${res.status}`;
    return { ok: false, error: { status: res.status, code: typeof e?.code === "number" ? e.code : null, message: msg.slice(0, 300) } };
  } catch {
    return { ok: false, error: null, network: "No hay conexión con Meta. Inténtalo de nuevo en un momento." };
  }
}

/** Traduce los errores más comunes de Meta al crear/consultar plantillas. */
export function explainTemplateError(e: MetaError | null, network?: string): string {
  if (!e) return network ?? "No hay conexión con Meta.";
  if (e.code === 190 || e.status === 401) return "El token venció o no es válido. Vuelve a conectar el número en WhatsApp.";
  if (e.code === 10 || e.code === 200 || e.code === 100 && e.status === 403 || e.status === 403) return "El token no tiene permiso para plantillas. Necesita whatsapp_business_management (al generar el token marca ese permiso).";
  if (e.code === 100 && /does not exist|cannot be loaded|unsupported get/i.test(e.message)) return "Meta no encuentra esa cuenta de WhatsApp Business (WABA). Revisa el ID de la cuenta.";
  if (e.code === 2388023 || e.code === 2388024) return "Ya existe una plantilla con ese nombre e idioma (o se borró hace poco y Meta aún no deja reutilizar el nombre: espera unos minutos o cambia el nombre).";
  if (e.code === 2388025 || e.code === 2388299) return "Meta no aceptó el contenido. Revisa las variables y los ejemplos.";
  if (e.code === 4 || e.code === 17 || e.code === 613 || e.status === 429) return "Meta pidió ir más despacio. Espera un minuto e inténtalo de nuevo.";
  return `Meta no aceptó la solicitud: ${e.message}`;
}

export async function createMetaTemplate(
  wabaId: string,
  token: string,
  t: { name: string; language: string; category: "UTILITY" | "MARKETING"; body: string; examples: string[] },
  fetchImpl: typeof fetch = fetch,
): Promise<Meta<{ id: string; status: string }>> {
  const body = {
    name: t.name,
    language: t.language,
    category: t.category,
    components: [{ type: "BODY", text: t.body, ...(t.examples.length ? { example: { body_text: [t.examples] } } : {}) }],
  };
  const r = await call<{ id?: string; status?: string }>(`${graph()}/${wabaId}/message_templates`, token, { method: "POST", body: JSON.stringify(body) }, fetchImpl);
  if (!r.ok) return r;
  return { ok: true, data: { id: String(r.data.id ?? "").slice(0, 60), status: String(r.data.status ?? "PENDING") } };
}

export interface RemoteTemplate { id: string; name: string; language: string; category: string; status: string; body: string; examples: string[]; sendable: boolean; reason: string | null }

/** Interpreta una plantilla tal como la devuelve Meta. Pura. */
export function parseRemote(x: unknown): RemoteTemplate | null {
  const t = x as { id?: unknown; name?: unknown; language?: unknown; category?: unknown; status?: unknown; rejected_reason?: unknown; components?: unknown };
  if (typeof t?.name !== "string" || typeof t.language !== "string" || !validName(t.name) || !/^[a-z]{2,3}(_[A-Z]{2})?$/.test(t.language)) return null;
  const comps = Array.isArray(t.components) ? (t.components as { type?: string; text?: string; example?: { body_text?: string[][] }; buttons?: { url?: string }[] }[]) : [];
  const bodyC = comps.find((c) => c.type === "BODY");
  if (typeof bodyC?.text !== "string") return null;
  const types = new Set(comps.map((c) => c.type));
  const buttonVars = comps.some((c) => c.type === "BUTTONS" && (c.buttons ?? []).some((b) => typeof b.url === "string" && b.url.includes("{{")));
  const category = ["UTILITY", "MARKETING", "AUTHENTICATION"].includes(String(t.category)) ? String(t.category) : "UTILITY";
  const sendable = category !== "AUTHENTICATION" && [...types].every((c) => c === "BODY" || c === "FOOTER" || c === "BUTTONS") && !buttonVars;
  const status = ["PENDING", "APPROVED", "REJECTED", "PAUSED", "DISABLED", "IN_APPEAL"].includes(String(t.status)) ? String(t.status) : "OTHER";
  const ex = bodyC.example?.body_text?.[0];
  return {
    id: String(t.id ?? "").slice(0, 60),
    name: t.name,
    language: t.language,
    category,
    status,
    body: bodyC.text.slice(0, MAX_BODY),
    examples: Array.isArray(ex) ? ex.filter((e): e is string => typeof e === "string").slice(0, MAX_VARIABLES).map((e) => e.slice(0, 100)) : [],
    sendable,
    reason: typeof t.rejected_reason === "string" && t.rejected_reason !== "NONE" ? t.rejected_reason.slice(0, 300) : null,
  };
}

/** Descarga todas las plantillas de la cuenta (hasta 5 páginas de 100). */
export async function listMetaTemplates(wabaId: string, token: string, fetchImpl: typeof fetch = fetch): Promise<Meta<RemoteTemplate[]>> {
  const out: RemoteTemplate[] = [];
  let url: string | null = `${graph()}/${wabaId}/message_templates?fields=name,language,status,category,components,rejected_reason&limit=100`;
  for (let page = 0; page < 5 && url; page++) {
    const r: Meta<{ data?: unknown[]; paging?: { next?: string } }> = await call(url, token, { method: "GET" }, fetchImpl);
    if (!r.ok) return r;
    for (const x of r.data.data ?? []) {
      const p = parseRemote(x);
      if (p) out.push(p);
    }
    const next: string | undefined = r.data.paging?.next;
    // Solo se sigue un enlace de paginación que apunte a Meta (el token viaja en la petición).
    url = next && next.startsWith("https://graph.facebook.com/") ? next : null;
  }
  return { ok: true, data: out };
}

export async function deleteMetaTemplate(wabaId: string, token: string, name: string, fetchImpl: typeof fetch = fetch): Promise<Meta<unknown>> {
  return call(`${graph()}/${wabaId}/message_templates?name=${encodeURIComponent(name)}`, token, { method: "DELETE" }, fetchImpl);
}

/** ¿Este número pertenece a esa cuenta WABA? (evita que alguien enlace la cuenta de otro). */
export async function wabaOwnsPhone(wabaId: string, phoneNumberId: string, token: string, fetchImpl: typeof fetch = fetch): Promise<Meta<boolean>> {
  const r = await call<{ data?: { id?: string }[] }>(`${graph()}/${wabaId}/phone_numbers?fields=id&limit=100`, token, { method: "GET" }, fetchImpl);
  if (!r.ok) return r;
  return { ok: true, data: (r.data.data ?? []).some((p) => p.id === phoneNumberId) };
}

/** Envía una plantilla aprobada a un cliente (vale dentro y fuera de las 24 h). */
export async function sendTemplate(
  phoneNumberId: string,
  token: string,
  to: string,
  t: { name: string; language: string; params: string[] },
  fetchImpl: typeof fetch = fetch,
): Promise<SendResult> {
  if (!/^\d{5,30}$/.test(phoneNumberId) || !/^\d{5,32}$/.test(to)) return { kind: "rejected", status: 0, code: null, message: "Datos inválidos" };
  if (!validName(t.name)) return { kind: "rejected", status: 0, code: null, message: "Nombre de plantilla inválido" };
  if (getSendMode() === "simulate") return { kind: "sent", waMessageId: `wamid.SIM.${randomUUID()}` };
  const components = t.params.length ? [{ type: "body", parameters: t.params.map((p) => ({ type: "text", text: cleanParam(p) })) }] : [];
  try {
    const res = await fetchImpl(`${graph()}/${phoneNumberId}/messages`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ messaging_product: "whatsapp", recipient_type: "individual", to, type: "template", template: { name: t.name, language: { code: t.language }, ...(components.length ? { components } : {}) } }),
      signal: AbortSignal.timeout(10_000),
      redirect: "error",
    });
    const json = (await res.json().catch(() => null)) as { messages?: { id?: unknown }[]; error?: { message?: unknown; code?: unknown; error_data?: { details?: unknown } } } | null;
    if (res.ok) {
      const id = json?.messages?.[0]?.id;
      return typeof id === "string" && /^[\w.=\-+/]{5,200}$/.test(id) ? { kind: "sent", waMessageId: id } : { kind: "unknown", reason: "Meta respondió OK sin id de mensaje" };
    }
    if (res.status === 429) return { kind: "retry", reason: "límite de ritmo de Meta" };
    if (res.status >= 500) return { kind: "unknown", reason: `Meta respondió ${res.status}` };
    const details = typeof json?.error?.error_data?.details === "string" ? ` ${json.error.error_data.details}` : "";
    return { kind: "rejected", status: res.status, code: typeof json?.error?.code === "number" ? json.error.code : null, message: `${typeof json?.error?.message === "string" ? json.error.message : `HTTP ${res.status}`}${details}`.slice(0, 250) };
  } catch (err) {
    const e = err as { name?: string; cause?: { code?: string } };
    if (e.name === "TimeoutError" || e.name === "AbortError") return { kind: "unknown", reason: "tiempo agotado" };
    const c = e.cause?.code;
    if (c && ["ENOTFOUND", "EAI_AGAIN", "ECONNREFUSED", "ENETUNREACH", "EHOSTUNREACH"].includes(c)) return { kind: "retry", reason: c };
    return { kind: "unknown", reason: c ?? "error de red" };
  }
}

/** Frases hechas para empezar sin saber de plantillas. */
export const PRESETS = [
  { title: "Recordatorio de cita", category: "UTILITY" as const, name: "recordatorio_cita", body: "Hola {{1}}, te recordamos tu cita de {{2}} el {{3}}. Si no puedes asistir, responde a este mensaje para reprogramar.", examples: ["María", "corte de cabello", "viernes 10 a. m."] },
  { title: "Pedido listo", category: "UTILITY" as const, name: "pedido_listo", body: "Hola {{1}}, tu pedido {{2}} ya está listo. Responde a este mensaje para coordinar la entrega o el retiro.", examples: ["Carlos", "#1024"] },
  { title: "Seguimiento", category: "UTILITY" as const, name: "seguimiento_cliente", body: "Hola {{1}}, ¿pudiste ver la información que te enviamos? Responde a este mensaje y con gusto te ayudamos.", examples: ["Ana"] },
  { title: "Oferta (marketing)", category: "MARKETING" as const, name: "oferta_semana", body: "Hola {{1}}, esta semana tenemos {{2}} con descuento. Responde a este mensaje si quieres más información.", examples: ["Luis", "nuestros combos"] },
];
