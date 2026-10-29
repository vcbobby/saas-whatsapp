/**
 * Lectura de CSV hecha a mano (sin dependencias): acepta BOM, comillas con comas o saltos de línea dentro,
 * separador «,», «;» o tabulación (se detecta solo: Excel en español guarda con «;»), y finales de línea Windows o Unix.
 */
export const MAX_CSV_CHARS = 1_000_000;
export const MAX_CSV_ROWS = 2_000;
export const MAX_CSV_COLS = 30;

export type ParsedCsv = { ok: true; delimiter: string; headers: string[]; rows: string[][]; lines: number[] } | { ok: false; error: string };

function detectDelimiter(text: string): string {
  let inQ = false;
  const n: Record<string, number> = { ",": 0, ";": 0, "\t": 0 };
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (c === '"') inQ = !inQ;
    else if (!inQ && (c === "\n" || c === "\r")) break;
    else if (!inQ && c in n) n[c]!++;
  }
  const best = (Object.entries(n).sort((a, b) => b[1] - a[1])[0] ?? [",", 0]) as [string, number];
  return best[1] > 0 ? best[0] : ",";
}

export function parseCsv(input: string): ParsedCsv {
  if (input.length > MAX_CSV_CHARS) return { ok: false, error: "El archivo es demasiado grande (máximo 1 MB)." };
  const text = input.replace(/^\uFEFF/, "");
  if (!text.trim()) return { ok: false, error: "El archivo está vacío." };
  const delimiter = detectDelimiter(text);
  const all: string[][] = [];
  const lineOf: number[] = [];
  let row: string[] = [];
  let cell = "";
  let inQ = false;
  let line = 1;
  let rowLine = 1;
  const endCell = () => { row.push(cell.trim()); cell = ""; };
  const endRow = () => {
    endCell();
    if (row.some((c) => c !== "")) { all.push(row); lineOf.push(rowLine); }
    row = [];
  };
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (inQ) {
      if (c === '"') {
        if (text[i + 1] === '"') { cell += '"'; i++; } else inQ = false;
      } else { if (c === "\n") line++; cell += c; }
      continue;
    }
    if (c === '"' && cell === "") inQ = true;
    else if (c === delimiter) endCell();
    else if (c === "\r") { if (text[i + 1] === "\n") i++; endRow(); line++; rowLine = line; }
    else if (c === "\n") { endRow(); line++; rowLine = line; }
    else cell += c;
    if (all.length > MAX_CSV_ROWS + 1) return { ok: false, error: `Demasiadas filas (máximo ${MAX_CSV_ROWS}). Divide el archivo en partes.` };
  }
  if (inQ) return { ok: false, error: "Hay unas comillas sin cerrar en el archivo." };
  if (cell !== "" || row.length) endRow();
  if (all.length === 0) return { ok: false, error: "El archivo no tiene datos." };
  const headers = all[0]!;
  if (headers.length > MAX_CSV_COLS) return { ok: false, error: `Demasiadas columnas (máximo ${MAX_CSV_COLS}).` };
  if (all.length > MAX_CSV_ROWS + 1) return { ok: false, error: `Demasiadas filas (máximo ${MAX_CSV_ROWS}). Divide el archivo en partes.` };
  return { ok: true, delimiter, headers, rows: all.slice(1), lines: lineOf.slice(1) };
}

/** «Descripción » → «descripcion»: sin acentos, minúsculas y espacios simples, para reconocer encabezados escritos de varias formas. */
export function normalizeHeader(h: string): string {
  return h.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}
