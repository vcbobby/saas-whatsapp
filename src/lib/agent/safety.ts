import { randomBytes } from "node:crypto";

/**
 * Defensas del asistente (Paso 9B). Ninguna es perfecta por sí sola: se apilan.
 *  1. Entrada: se normaliza el texto no confiable (Unicode, caracteres invisibles) antes de ponerlo en el prompt.
 *  2. Detección de intentos de manipulación (solo para registrar y cortar a quien insiste; no bloquea por sí sola).
 *  3. Salida: se revisa lo que dice el modelo ANTES de enviarlo (fuga de reglas, enlaces/correos inventados).
 */

/** Caracteres invisibles o de dirección que se usan para esconder texto o romper filtros. */
const INVISIBLE_RE = /[\u0000­​-‏‪-‮⁠-⁤⁦-⁩﻿]/g;

/** NFKC convierte variantes (＜ ＞ de ancho completo, letras estilizadas) a su forma normal; luego se quitan los invisibles. */
export function normalizeUntrusted(s: string): string {
  return s.normalize("NFKC").replace(INVISIBLE_RE, "");
}

// ------------------------------------------------------------------ detección de inyección
const INJECTION_PATTERNS: RegExp[] = [
  /\b(ignor[ae]|olvida|descarta|omite|desobedece)\b[^.\n]{0,40}\b(instrucciones|reglas|indicaciones|lo anterior|todo lo anterior|prompt)\b/i,
  /\b(ignore|disregard|forget|override)\b[^.\n]{0,40}\b(previous|prior|above|all|your)\b[^.\n]{0,30}\b(instructions|rules|prompt)\b/i,
  /\b(muestra|muestrame|revela|repite|dime|imprime|escribe|comparte|copia)\b[^.\n]{0,40}\b(tus|tu|sus|su)\b[^.\n]{0,25}\b(instrucciones|reglas|prompt|configuraci[oó]n)\b/i,
  /\b(instrucciones|reglas) (internas|ocultas|del sistema|que te (dieron|programaron|dio))\b/i,
  /\b(system prompt|prompt del sistema|mensaje del sistema|instrucciones (internas|del sistema|ocultas))\b/i,
  /\b(ahora eres|a partir de ahora eres|act[uú]a como|finge (ser|que)|compórtate como|pretend (to be|you are)|you are now)\b/i,
  /\b(modo (desarrollador|dios|admin|sin restricciones)|developer mode|jailbreak)\b/i,
  /\bDAN\b/, // solo en mayúsculas: "dan" en español es un verbo común
  /<\s*\/?\s*(system|sistema|assistant|asistente|instructions?|negocio|cliente)\b[^>]*>/i,
  /\[\s*(system|sistema|inst)\s*\]/i,
];

export function looksLikeInjection(text: string | null): boolean {
  if (!text) return false;
  const t = normalizeUntrusted(text).slice(0, 2_000);
  return INJECTION_PATTERNS.some((re) => re.test(t));
}

// ------------------------------------------------------------------ canario
/** Código aleatorio por respuesta. Si aparece en la salida, el modelo está filtrando su prompt. */
export function newCanary(): string {
  return `ZX-${randomBytes(6).toString("hex")}`;
}

// ------------------------------------------------------------------ revisión de salida
const squash = (s: string) => normalizeUntrusted(s).toLowerCase().replace(/\s+/g, " ").trim();
const WINDOW = 35;

/** ¿La respuesta contiene un trozo largo de las reglas internas? (fuga aunque el modelo la reformatee un poco) */
function leaksRules(output: string, rulesLines: readonly string[]): boolean {
  const out = squash(output);
  for (const line of rulesLines) {
    const l = squash(line);
    if (l.length < WINDOW) continue;
    for (let i = 0; i + WINDOW <= l.length; i += 5) {
      if (out.includes(l.slice(i, i + WINDOW))) return true;
    }
  }
  return false;
}

const URL_RE = /\b(?:https?:\/\/|www\.)[^\s<>"'()\[\]]+/gi;
const TLDS = "com|net|org|io|co|ve|app|dev|me|info|biz|xyz|ly|link|site|online|store|shop|click|top|cc|tv|gl|page|live|tk|ru|cn";
const BARE_DOMAIN_RE = new RegExp(`\\b(?:[a-z0-9-]+\\.)+(?:${TLDS})\\b`, "gi");
const EMAIL_RE = /\b[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}\b/gi;

function hostOf(raw: string): string | null {
  try {
    const u = new URL(/^https?:\/\//i.test(raw) ? raw : `http://${raw}`);
    return u.hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return null;
  }
}

function collectHosts(text: string): Set<string> {
  const hosts = new Set<string>();
  const t = normalizeUntrusted(text);
  for (const m of t.match(URL_RE) ?? []) { const h = hostOf(m); if (h) hosts.add(h); }
  const noEmails = t.replace(EMAIL_RE, " ");
  for (const m of noEmails.match(BARE_DOMAIN_RE) ?? []) { const h = hostOf(m); if (h) hosts.add(h); }
  return hosts;
}

/** Enlaces y correos que el negocio escribió en su información: lo único que el asistente puede repetir. */
export function allowedContacts(instructions: string): { hosts: Set<string>; emails: Set<string> } {
  const t = normalizeUntrusted(instructions);
  return { hosts: collectHosts(t), emails: new Set((t.match(EMAIL_RE) ?? []).map((e) => e.toLowerCase())) };
}

export type OutputVerdict = { ok: true } | { ok: false; kind: "fuga_prompt" | "salida_bloqueada" };

/**
 * Revisa la respuesta del modelo antes de enviarla.
 *  - fuga_prompt: contiene el canario o un trozo largo de las reglas internas.
 *  - salida_bloqueada: trae un enlace o correo que el negocio no escribió (típico de un intento de robo de datos o estafa).
 */
export function checkOutput(
  text: string,
  opts: { canary: string; rulesLines: readonly string[]; allowed: { hosts: Set<string>; emails: Set<string> } },
): OutputVerdict {
  const flat = normalizeUntrusted(text);
  if (flat.toLowerCase().includes(opts.canary.toLowerCase())) return { ok: false, kind: "fuga_prompt" };
  if (leaksRules(text, opts.rulesLines)) return { ok: false, kind: "fuga_prompt" };

  for (const e of flat.match(EMAIL_RE) ?? []) {
    if (!opts.allowed.emails.has(e.toLowerCase())) return { ok: false, kind: "salida_bloqueada" };
  }
  for (const h of collectHosts(flat)) {
    const ok = [...opts.allowed.hosts].some((a) => h === a || h.endsWith(`.${a}`));
    if (!ok) return { ok: false, kind: "salida_bloqueada" };
  }
  return { ok: true };
}
