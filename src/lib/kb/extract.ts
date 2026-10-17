/**
 * Extrae el texto de un archivo (TXT, MD, CSV, DOCX, XLSX, PDF) EN EL NAVEGADOR de quien lo sube.
 * El servidor solo recibe el texto ya extraído, por la misma API de siempre: no hay endpoint de subida
 * de archivos (menos superficie de ataque) y la persona revisa y corrige el texto antes de guardar.
 */
export const MAX_FILE_BYTES = 5 * 1024 * 1024; // archivos binarios
export const MAX_TEXT_FILE_BYTES = 200_000; // txt / md / csv (igual que antes)
export const MAX_TEXT_CHARS = 50_000; // tope del servidor por documento
export const MAX_PDF_PAGES = 100;
export const MAX_SHEET_ROWS = 5_000;
export const MAX_SHEETS = 10;
export const MAX_ZIP_ENTRIES = 2_000;
export const MAX_ZIP_UNCOMPRESSED = 50 * 1024 * 1024;

export type FileKind = "texto" | "docx" | "xlsx" | "pdf";
export interface Extracted { text: string; kind: FileKind; truncated: boolean; notes: string[] }
export class ExtractError extends Error {}

const EXT: Record<string, FileKind> = { txt: "texto", md: "texto", csv: "texto", docx: "docx", xlsx: "xlsx", pdf: "pdf" };
export const ACCEPT = ".txt,.md,.csv,.docx,.xlsx,.pdf";

export function kindOf(name: string): FileKind | null {
  const m = /\.([a-z0-9]+)$/i.exec(name.trim());
  return (m && EXT[m[1]!.toLowerCase()]) || null;
}

/** Revisa la «firma» del archivo: que de verdad sea lo que dice su extensión. */
export function matchesSignature(kind: FileKind, head: Uint8Array): boolean {
  const starts = (...b: number[]) => b.every((v, i) => head[i] === v);
  if (kind === "pdf") {
    // «%PDF-» puede ir precedido por unos pocos bytes de basura (lo permite el formato).
    const s = new TextDecoder("latin1").decode(head.subarray(0, 1024));
    return s.includes("%PDF-");
  }
  if (kind === "docx" || kind === "xlsx") return starts(0x50, 0x4b, 0x03, 0x04); // zip
  return !head.subarray(0, 4096).includes(0); // texto: sin bytes nulos
}

/**
 * Mira el directorio central de un zip (DOCX/XLSX) y rechaza «bombas zip»:
 * demasiadas entradas o un tamaño descomprimido enorme. No descomprime nada.
 */
export function checkZip(buf: Uint8Array): void {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65_535); i--) {
    if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new ExtractError("El archivo está dañado o no es un documento válido.");
  const entries = dv.getUint16(eocd + 10, true);
  const cdSize = dv.getUint32(eocd + 12, true);
  const cdOffset = dv.getUint32(eocd + 16, true);
  if (entries === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) throw new ExtractError("Ese archivo es demasiado complejo para leerlo aquí.");
  if (entries > MAX_ZIP_ENTRIES) throw new ExtractError("El archivo tiene demasiadas partes internas; no se puede leer con seguridad.");
  if (cdOffset + cdSize > eocd) throw new ExtractError("El archivo está dañado o no es un documento válido.");
  let total = 0;
  let p = cdOffset;
  for (let n = 0; n < entries; n++) {
    if (p + 46 > eocd || dv.getUint32(p, true) !== 0x02014b50) throw new ExtractError("El archivo está dañado o no es un documento válido.");
    total += dv.getUint32(p + 24, true);
    if (total > MAX_ZIP_UNCOMPRESSED) throw new ExtractError("El archivo ocupa demasiado al abrirse; no se puede leer con seguridad.");
    p += 46 + dv.getUint16(p + 28, true) + dv.getUint16(p + 30, true) + dv.getUint16(p + 32, true);
  }
}

const norm = (s: string) => s.normalize("NFC").replace(/\r\n?/g, "\n").replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
const cell = (v: unknown): string => {
  if (v === null || v === undefined) return "";
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? "" : v.toISOString().slice(0, 10);
  return String(v).replace(/\s+/g, " ").trim();
};

/** Hoja → líneas «A | B | C». La primera fila se trata como encabezados y se repite en cada fila para que cada línea tenga sentido sola. */
export function rowsToText(sheetName: string | null, rows: unknown[][]): { text: string; rowsUsed: number; cut: boolean } {
  const grid = rows.map((r) => r.map(cell)).filter((r) => r.some((c) => c !== ""));
  if (grid.length === 0) return { text: "", rowsUsed: 0, cut: false };
  const [head, ...body] = grid as [string[], ...string[][]];
  const cut = body.length > MAX_SHEET_ROWS;
  const used = body.slice(0, MAX_SHEET_ROWS);
  const lines = used.map((r) => r.map((c, i) => (c === "" ? null : head[i] ? `${head[i]}: ${c}` : c)).filter((x) => x !== null).join(" | "));
  const title = sheetName ? `# ${sheetName}\n` : "";
  return { text: `${title}${lines.filter(Boolean).join("\n")}`, rowsUsed: used.length, cut };
}

export async function extractText(file: File): Promise<Extracted> {
  const kind = kindOf(file.name);
  if (!kind) throw new ExtractError("Ese tipo de archivo no se puede leer. Usa TXT, MD, CSV, DOCX, XLSX o PDF.");
  if (file.size === 0) throw new ExtractError("El archivo está vacío.");
  if (kind === "texto" ? file.size > MAX_TEXT_FILE_BYTES : file.size > MAX_FILE_BYTES) {
    throw new ExtractError(kind === "texto" ? "El archivo es muy grande (máximo 200 KB de texto)." : "El archivo es muy grande (máximo 5 MB).");
  }
  const buf = new Uint8Array(await file.arrayBuffer());
  if (!matchesSignature(kind, buf)) throw new ExtractError("El contenido no coincide con el tipo de archivo. ¿Cambiaste su extensión?");
  const notes: string[] = [];
  let raw = "";

  try {
    if (kind === "texto") {
      raw = new TextDecoder("utf-8").decode(buf);
    } else if (kind === "docx") {
      checkZip(buf);
      const mammoth = await import("mammoth/mammoth.browser");
      const r = await mammoth.extractRawText({ arrayBuffer: buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer });
      raw = r.value;
      notes.push("Las imágenes y las tablas complejas de Word no se copian; revisa que el texto esté completo.");
    } else if (kind === "xlsx") {
      checkZip(buf);
      const { default: readExcel } = await import("read-excel-file/browser");
      const sheets = await readExcel(new Blob([buf]));
      const parts: string[] = [];
      let cutRows = false;
      for (const sh of sheets.slice(0, MAX_SHEETS)) {
        const r = rowsToText(sheets.length > 1 ? sh.sheet : null, sh.data as unknown[][]);
        if (r.text) parts.push(r.text);
        cutRows ||= r.cut;
      }
      raw = parts.join("\n\n");
      notes.push("Cada fila se guardó como «Columna: valor | Columna: valor» usando la primera fila como encabezados.");
      if (cutRows) notes.push(`Solo se leyeron las primeras ${MAX_SHEET_ROWS} filas de cada hoja.`);
      if (sheets.length > MAX_SHEETS) notes.push(`Solo se leyeron las primeras ${MAX_SHEETS} hojas.`);
    } else {
      const { getDocumentProxy } = await import("unpdf");
      const pdf = await getDocumentProxy(buf);
      try {
        if (pdf.numPages > MAX_PDF_PAGES) {
          notes.push(`El PDF tiene ${pdf.numPages} páginas; solo se leyeron las primeras ${MAX_PDF_PAGES}.`);
        }
        const out: string[] = [];
        for (let i = 1; i <= Math.min(pdf.numPages, MAX_PDF_PAGES); i++) {
          const page = await pdf.getPage(i);
          const tc = await page.getTextContent();
          out.push(tc.items.map((it) => ("str" in it ? it.str + ("hasEOL" in it && it.hasEOL ? "\n" : " ") : "")).join(""));
        }
        raw = out.join("\n\n");
      } finally {
        await (pdf as unknown as { destroy?: () => Promise<void> }).destroy?.();
      }
      if (norm(raw).length === 0) throw new ExtractError("Este PDF no tiene texto (parece una foto o un escaneo). Pega el texto a mano o usa un PDF con texto seleccionable.");
    }
  } catch (e) {
    if (e instanceof ExtractError) throw e;
    throw new ExtractError("No se pudo leer el archivo. Puede estar dañado, protegido con contraseña o en un formato raro.");
  }

  let text = norm(raw);
  if (text.length === 0) throw new ExtractError("No se encontró texto en el archivo.");
  let truncated = false;
  if (text.length > MAX_TEXT_CHARS) {
    text = text.slice(0, MAX_TEXT_CHARS);
    truncated = true;
    notes.push(`El texto era más largo que el máximo (${MAX_TEXT_CHARS.toLocaleString("es")} caracteres) y se cortó. Divide el archivo en varios documentos si necesitas todo.`);
  }
  return { text, kind, truncated, notes };
}
