/**
 * Escritura de CSV. Excel en español espera «;» como separador (la coma es el decimal), por eso hay dos formatos:
 * «csv» (coma, estándar) y «excel» (punto y coma). Ambos llevan BOM para que Excel respete los acentos.
 */
export type CsvFormat = "csv" | "excel";
export const delimiterOf = (f: CsvFormat) => (f === "excel" ? ";" : ",");

/** Texto ya comprobado como inofensivo (p. ej. un teléfono «+58412…»): no se le antepone la comilla de protección. */
export class SafeText { constructor(readonly text: string) {} }
/** Un teléfono con solo dígitos, espacios y + - ( ) . no puede ser una fórmula. */
export const phoneCell = (v: unknown): unknown => (typeof v === "string" && /^\+?[\d\s().-]{5,32}$/.test(v) ? new SafeText(v) : v);

/** Celdas que Excel o Sheets podrían leer como fórmula se marcan con una comilla: así un nombre malicioso no ejecuta nada. Los números reales no se tocan (-3 sigue siendo -3). */
export function csvCell(v: unknown, delimiter = ","): string {
  if (v instanceof SafeText) return v.text.includes(delimiter) ? `"${v.text}"` : v.text;
  if (typeof v === "number" && Number.isFinite(v)) return String(v).replace(".", delimiter === ";" ? "," : ".");
  let s = v === null || v === undefined ? "" : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return s.includes(delimiter) || /["\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
export const csvLine = (cells: unknown[], delimiter = ",") => cells.map((c) => csvCell(c, delimiter)).join(delimiter);

export function csvFile(lines: string[][] | string[]): string {
  return lines.join("\r\n") + "\r\n";
}

/** Respuesta de descarga con las cabeceras de seguridad habituales. */
export function csvDownload(name: string, header: unknown[], rows: unknown[][], format: CsvFormat): Response {
  const d = delimiterOf(format);
  const body = "\uFEFF" + [csvLine(header, d), ...rows.map((r) => csvLine(r, d))].join("\r\n") + "\r\n";
  return new Response(body, {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="${name}"`,
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
  });
}
