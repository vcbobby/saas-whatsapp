import { describe, expect, it } from "vitest";
import {
  ExtractError, MAX_FILE_BYTES, MAX_PDF_PAGES, MAX_SHEET_ROWS, MAX_TEXT_CHARS, MAX_TEXT_FILE_BYTES, MAX_ZIP_ENTRIES, MAX_ZIP_UNCOMPRESSED,
  checkZip, extractText, kindOf, matchesSignature, rowsToText,
} from "@/lib/kb/extract";
import { DOCX_B64, PDF101_B64, PDF_B64, PDF_VACIO_B64, XLSX11_B64, XLSX1_B64, XLSX_B64 } from "./kb-extract-fixtures";

const bytes = (b64: string) => new Uint8Array(Buffer.from(b64, "base64"));
const file = (name: string, data: Uint8Array | string) => new File([typeof data === "string" ? new TextEncoder().encode(data) : (data as BlobPart)], name);
const fail = async (f: File) => { try { await extractText(f); } catch (e) { return e; } throw new Error("debía fallar"); };

/** Zip falso: solo el directorio central (checkZip no mira nada más). */
function fakeZip(sizes: number[], opts: { entriesField?: number; cdOffset?: number; cdSize?: number } = {}): Uint8Array {
  const cd: number[][] = sizes.map((sz) => {
    const h = new Uint8Array(46); const dv = new DataView(h.buffer);
    dv.setUint32(0, 0x02014b50, true); dv.setUint32(24, sz, true);
    return Array.from(h);
  });
  const cdBytes = Uint8Array.from(cd.flat());
  const eocd = new Uint8Array(22); const dv = new DataView(eocd.buffer);
  dv.setUint32(0, 0x06054b50, true);
  dv.setUint16(10, opts.entriesField ?? sizes.length, true);
  dv.setUint32(12, opts.cdSize ?? cdBytes.length, true);
  dv.setUint32(16, opts.cdOffset ?? 0, true);
  const out = new Uint8Array(cdBytes.length + 22); out.set(cdBytes); out.set(eocd, cdBytes.length);
  return out;
}

describe("kindOf / firma", () => {
  it.each([["a.txt", "texto"], ["a.MD", "texto"], ["a.csv", "texto"], ["Lista.DOCX", "docx"], ["x.xlsx", "xlsx"], ["x.pdf", "pdf"], ["a.doc", null], ["a.xls", null], ["a.exe", null], ["sinextension", null], ["a.pdf.exe", null]])("%s → %s", (n, k) => {
    expect(kindOf(n)).toBe(k);
  });
  it("la firma de cada tipo", () => {
    const enc = (s: string) => new TextEncoder().encode(s);
    expect(matchesSignature("pdf", enc("%PDF-1.7\n"))).toBe(true);
    expect(matchesSignature("pdf", enc("hola"))).toBe(false);
    expect(matchesSignature("docx", Uint8Array.from([0x50, 0x4b, 3, 4]))).toBe(true);
    expect(matchesSignature("docx", Uint8Array.from([0x50, 0x4b, 5, 6]))).toBe(false);
    expect(matchesSignature("xlsx", enc("PK"))).toBe(false);
    expect(matchesSignature("texto", enc("hola\nmundo"))).toBe(true);
    expect(matchesSignature("texto", Uint8Array.from([104, 0, 111]))).toBe(false);
  });
});

describe("checkZip (bombas zip)", () => {
  it("un zip normal pasa", () => { expect(() => checkZip(fakeZip([10, 2000, 5000]))).not.toThrow(); });
  it("justo en el límite de entradas pasa; uno más no", () => {
    expect(() => checkZip(fakeZip(Array(MAX_ZIP_ENTRIES).fill(1)))).not.toThrow();
    expect(() => checkZip(fakeZip(Array(MAX_ZIP_ENTRIES + 1).fill(1)))).toThrow(ExtractError);
  });
  it("tamaño descomprimido: en el límite pasa; uno más no", () => {
    expect(() => checkZip(fakeZip([MAX_ZIP_UNCOMPRESSED]))).not.toThrow();
    expect(() => checkZip(fakeZip([MAX_ZIP_UNCOMPRESSED, 1]))).toThrow(/ocupa demasiado/);
    expect(() => checkZip(fakeZip([30 * 1024 * 1024, 30 * 1024 * 1024]))).toThrow(ExtractError);
  });
  it("una sola entrada gigante declarada se rechaza", () => { expect(() => checkZip(fakeZip([0xfffffff0]))).toThrow(ExtractError); });
  it("sin directorio central, o con campos que mienten, se rechaza", () => {
    expect(() => checkZip(new Uint8Array(100))).toThrow(/dañado/);
    expect(() => checkZip(fakeZip([1, 2], { entriesField: 5 }))).toThrow(ExtractError);
    expect(() => checkZip(fakeZip([1], { cdOffset: 500 }))).toThrow(ExtractError);
    expect(() => checkZip(fakeZip([1], { entriesField: 0xffff }))).toThrow(/complejo/);
    expect(() => checkZip(fakeZip([1], { cdSize: 47 }))).toThrow(/dañado/); // el directorio dice ser más largo que el archivo
  });
});

describe("rowsToText", () => {
  it("usa la primera fila como encabezados, salta filas y celdas vacías, y formatea fechas", () => {
    const r = rowsToText("Hoja", [["Producto", "Precio"], ["Arroz", 2.5], [null, null], ["Harina", null], ["Pan", new Date("2030-05-04T00:00:00Z")]]);
    expect(r.text).toBe("# Hoja\nProducto: Arroz | Precio: 2.5\nProducto: Harina\nProducto: Pan | Precio: 2030-05-04");
    expect(r.cut).toBe(false);
  });
  it("sin nombre de hoja no pone título; hoja vacía da texto vacío", () => {
    expect(rowsToText(null, [["A"], ["x"]]).text).toBe("A: x");
    expect(rowsToText("H", [[null], []]).text).toBe("");
  });
  it("corta en MAX_SHEET_ROWS filas de datos", () => {
    const rows: unknown[][] = [["n"], ...Array.from({ length: MAX_SHEET_ROWS + 5 }, (_, i) => [i])];
    const r = rowsToText(null, rows);
    expect(r.cut).toBe(true);
    expect(r.rowsUsed).toBe(MAX_SHEET_ROWS);
    expect(r.text.split("\n")).toHaveLength(MAX_SHEET_ROWS);
    expect(rowsToText(null, [["n"], ...Array.from({ length: MAX_SHEET_ROWS }, (_, i) => [i])]).cut).toBe(false);
  });
  it("las celdas se limpian de saltos de línea", () => { expect(rowsToText(null, [["A"], ["uno\n\ndos   tres"]]).text).toBe("A: uno dos tres"); });
});

describe("extractText: texto", () => {
  it("lee txt/md/csv y normaliza", async () => {
    const r = await extractText(file("a.txt", "Hola\r\n\r\n\r\n\r\nmundo \u0001 ok  \n"));
    expect(r).toMatchObject({ kind: "texto", truncated: false });
    expect(r.text).toBe("Hola\n\nmundo  ok");
  });
  it("rechaza vacío, tipo desconocido, demasiado grande y contenido que no coincide", async () => {
    expect(((await fail(file("a.txt", ""))) as Error).message).toMatch(/vacío/);
    expect(((await fail(file("a.exe", "x"))) as Error).message).toMatch(/tipo de archivo/);
    expect(((await fail(file("a.txt", "x".repeat(MAX_TEXT_FILE_BYTES + 1)))) as Error).message).toMatch(/200 KB/);
    expect(((await fail(file("a.txt", Uint8Array.from([65, 0, 66])))) as Error).message).toMatch(/no coincide/);
    expect(((await fail(file("a.pdf", "esto es texto"))) as Error).message).toMatch(/no coincide/);
    expect(((await fail(file("a.docx", "PK nope"))) as Error).message).toMatch(/no coincide/);
  });
  it("un txt del tamaño máximo exacto se acepta (y se corta a 50 000)", async () => {
    const r = await extractText(file("a.txt", "a".repeat(MAX_TEXT_FILE_BYTES)));
    expect(r.text.length).toBe(MAX_TEXT_CHARS);
    expect(r.truncated).toBe(true);
  });
  it("corta a 50 000 caracteres y lo avisa", async () => {
    const r = await extractText(file("a.txt", "palabra ".repeat(10_000)));
    expect(r.text.length).toBeLessThanOrEqual(MAX_TEXT_CHARS);
    expect(r.truncated).toBe(true);
    expect(r.notes.join(" ")).toMatch(/se cortó/);
  });
  it("justo 50 000 caracteres no se corta", async () => {
    const r = await extractText(file("a.md", "a".repeat(MAX_TEXT_CHARS)));
    expect(r.text.length).toBe(MAX_TEXT_CHARS);
    expect(r.truncated).toBe(false);
  });
});

describe("extractText: Word", () => {
  it("saca párrafos y la tabla", async () => {
    const r = await extractText(file("politicas.docx", bytes(DOCX_B64)));
    expect(r.kind).toBe("docx");
    expect(r.text).toContain("Políticas de la tienda");
    expect(r.text).toContain("Hacemos envíos a todo el país en 48 horas.");
    expect(r.text).toContain("Pago Móvil y Binance");
    expect(r.text).toMatch(/Arroz/);
    expect(r.text).toMatch(/2,50/);
    expect(r.notes.join(" ")).toMatch(/Word/);
  });
  it("un docx dañado da un error claro y no revienta", async () => {
    const data = bytes(DOCX_B64); data.fill(7, 200, 900);
    expect(await fail(file("x.docx", data))).toBeInstanceOf(ExtractError);
  });
  it("un docx que declara un tamaño enorme se rechaza antes de abrirlo", async () => {
    const data = bytes(DOCX_B64);
    const dv = new DataView(data.buffer);
    let eocd = data.length - 22; while (dv.getUint32(eocd, true) !== 0x06054b50) eocd--;
    const cd = dv.getUint32(eocd + 16, true);
    dv.setUint32(cd + 24, MAX_ZIP_UNCOMPRESSED + 1, true);
    expect(((await fail(file("x.docx", data))) as Error).message).toMatch(/ocupa demasiado/);
  });
});

describe("extractText: Excel", () => {
  it("varias hojas: título por hoja, encabezados repetidos, filas vacías fuera", async () => {
    const r = await extractText(file("precios.xlsx", bytes(XLSX_B64)));
    expect(r.kind).toBe("xlsx");
    expect(r.text).toBe("# Precios\nProducto: Arroz 1kg | Precio: 2.5 | Stock: 40\nProducto: Harina | Stock: 12\nProducto: Café | Precio: 4\n\n# Horarios\nDía: Lunes | Horario: 8am a 5pm");
    expect(r.notes.join(" ")).toMatch(/encabezados/);
  });
  it("una sola hoja: sin título", async () => {
    const r = await extractText(file("una.xlsx", bytes(XLSX1_B64)));
    expect(r.text).toBe("Solo: a | una hoja: b");
  });
  it("más de 10 hojas: solo se leen las primeras 10 y se avisa", async () => {
    const r = await extractText(file("muchas.xlsx", bytes(XLSX11_B64)));
    expect(r.text).toContain("fila10");
    expect(r.text).not.toContain("fila11");
    expect(r.notes.join(" ")).toMatch(/primeras 10 hojas/);
  });
  it("un xlsx que declara un tamaño enorme se rechaza antes de abrirlo", async () => {
    const data = bytes(XLSX_B64);
    const dv = new DataView(data.buffer);
    let eocd = data.length - 22; while (dv.getUint32(eocd, true) !== 0x06054b50) eocd--;
    dv.setUint32(dv.getUint32(eocd + 16, true) + 24, MAX_ZIP_UNCOMPRESSED + 1, true);
    expect(((await fail(file("x.xlsx", data))) as Error).message).toMatch(/ocupa demasiado/);
  });
  it("un .xlsx dañado da error claro", async () => {
    const data = bytes(XLSX_B64); data.fill(9, 100, 400);
    expect(await fail(file("x.xlsx", data))).toBeInstanceOf(ExtractError);
  });
});

describe("extractText: PDF", () => {
  it("saca el texto de todas las páginas", async () => {
    const r = await extractText(file("info.pdf", bytes(PDF_B64)));
    expect(r.kind).toBe("pdf");
    expect(r.text).toContain("Horario de atencion: lunes a viernes de 8 a 5.");
    expect(r.text).toContain("Delivery gratis");
    expect(r.text).toContain("Segunda pagina: devoluciones en 7 dias.");
  });
  it("un PDF de 101 páginas: se leen solo las primeras 100 y se avisa", async () => {
    const r = await extractText(file("largo.pdf", bytes(PDF101_B64)));
    expect(r.text).toContain("PAGINA-100");
    expect(r.text).not.toContain("PAGINA-101");
    expect(r.notes.join(" ")).toMatch(/101 páginas.*primeras 100/);
  });
  it("un PDF sin texto (imagen/escaneo) explica qué hacer", async () => {
    expect(((await fail(file("scan.pdf", bytes(PDF_VACIO_B64)))) as Error).message).toMatch(/no tiene texto/);
  });
  it("un PDF cortado o corrupto no revienta", async () => {
    const data = bytes(PDF_B64).slice(0, 400);
    expect(await fail(file("roto.pdf", data))).toBeInstanceOf(ExtractError);
  });
});

describe("límites", () => {
  it("binarios: tope de 5 MB", async () => {
    const big = new Uint8Array(MAX_FILE_BYTES + 1); big.set([0x25, 0x50, 0x44, 0x46, 0x2d]);
    expect(((await fail(file("g.pdf", big))) as Error).message).toMatch(/5 MB/);
  });
  it("un binario de exactamente 5 MB todavía no se rechaza por tamaño", async () => {
    const edge = new Uint8Array(MAX_FILE_BYTES); edge.set([0x25, 0x50, 0x44, 0x46, 0x2d]);
    expect(((await fail(file("g.pdf", edge))) as Error).message).not.toMatch(/5 MB/);
  });
  it("constantes razonables", () => {
    expect(MAX_PDF_PAGES).toBe(100);
    expect(MAX_SHEET_ROWS).toBe(5000);
    expect(MAX_TEXT_CHARS).toBe(50_000);
  });
});
