import { normalizeUntrusted } from "@/lib/agent/safety";

export const CHUNK_TARGET = 800;
export const CHUNK_MAX = 1000;
const OVERLAP = 120;
export const MAX_CHUNKS_PER_DOC = 200;

/** Limpia el texto de un documento: sin caracteres de control ni invisibles; saltos de línea normales. */
export function cleanDocument(raw: string): string {
  return normalizeUntrusted(raw.normalize("NFC"))
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0001-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function splitLong(par: string): string[] {
  if (par.length <= CHUNK_MAX) return [par];
  const out: string[] = [];
  let cur = "";
  for (const s of par.split(/(?<=[.!?…])\s+/)) {
    if (s.length > CHUNK_MAX) {
      if (cur) { out.push(cur); cur = ""; }
      for (let i = 0; i < s.length; i += CHUNK_TARGET) out.push(s.slice(i, i + CHUNK_TARGET));
    } else if (cur && cur.length + 1 + s.length > CHUNK_TARGET) {
      out.push(cur);
      cur = s;
    } else {
      cur = cur ? `${cur} ${s}` : s;
    }
  }
  if (cur) out.push(cur);
  return out;
}

/**
 * Parte el texto en fragmentos de ~800 caracteres respetando párrafos, con un poco de solapamiento
 * para que una respuesta que cae entre dos fragmentos no se pierda.
 */
export function chunkText(text: string): string[] {
  const pieces = cleanDocument(text).split(/\n{2,}/).flatMap((p) => splitLong(p.trim())).filter(Boolean);
  const chunks: string[] = [];
  let cur = "";
  for (const p of pieces) {
    if (cur && cur.length + 2 + p.length > CHUNK_TARGET) {
      chunks.push(cur);
      const tail = cur.length > OVERLAP ? cur.slice(-OVERLAP).replace(/^\S*\s/, "") : "";
      cur = tail ? `${tail}\n\n${p}` : p;
    } else {
      cur = cur ? `${cur}\n\n${p}` : p;
    }
  }
  if (cur) chunks.push(cur);
  return chunks.map((c) => c.slice(0, 2000)).slice(0, MAX_CHUNKS_PER_DOC);
}
