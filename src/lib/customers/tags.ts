// Etiquetas libres de un cliente ("mayorista", "VIP"…). Sin dependencias: las usan el servidor y la pantalla.

export const MAX_TAGS = 10;
export const MAX_TAG_LENGTH = 30;

export type TagResult = { ok: true; tags: string[] } | { ok: false; message: string };

/** Limpia una lista de etiquetas: sin espacios de más, sin repetidas (ignora mayúsculas) y dentro de los límites. */
export function normalizeTags(input: readonly string[]): TagResult {
  const seen = new Set<string>();
  const tags: string[] = [];
  for (const raw of input) {
    const t = raw.normalize("NFC").replace(/\s+/g, " ").trim();
    if (!t) continue;
    if (t.length > MAX_TAG_LENGTH) return { ok: false, message: `Cada etiqueta puede tener hasta ${MAX_TAG_LENGTH} caracteres.` };
    // Sin comas ni punto y coma (rompen los archivos de Excel) ni caracteres de control.
    if (/[,;"\u0000-\u001f\u007f]/.test(t)) return { ok: false, message: "Las etiquetas no pueden llevar comas, punto y coma ni comillas." };
    const k = t.toLocaleLowerCase("es");
    if (seen.has(k)) continue;
    seen.add(k);
    tags.push(t);
  }
  if (tags.length > MAX_TAGS) return { ok: false, message: `Puedes poner hasta ${MAX_TAGS} etiquetas por cliente.` };
  return { ok: true, tags };
}

/** «vip, mayorista» → ["vip","mayorista"] (para el campo de texto de la pantalla). */
export function splitTagInput(text: string): string[] {
  return text.split(/[,;\n]/);
}

/** Escapa % _ \ para usar el texto de búsqueda dentro de un LIKE. */
export function likeEscape(s: string): string {
  return s.replace(/[\\%_]/g, (c) => "\\" + c);
}

export const CONSENT_SOURCES = ["whatsapp", "tienda", "formulario", "importado", "otro"] as const;
export type ConsentSource = (typeof CONSENT_SOURCES)[number];
export const CONSENT_SOURCE_TEXT: Record<ConsentSource, string> = {
  whatsapp: "Lo aceptó por WhatsApp",
  tienda: "Lo aceptó en la tienda",
  formulario: "Lo aceptó en un formulario",
  importado: "Viene de una lista con su permiso",
  otro: "Otro",
};
