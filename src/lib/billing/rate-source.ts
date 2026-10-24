import type { RateSourceName } from "@/lib/env";

/** Una tasa leída de una fuente externa: bolívares por 1 USD. */
export interface RateReading {
  rate: number;
  /** Cuándo dice la fuente que actualizó el dato (si lo informa). */
  publishedAt: Date | null;
}

export class RateSourceError extends Error {}

/** Una lectura solo vale si es un número razonable (descarta 0, negativos, NaN y absurdos). */
export const PLAUSIBLE_MIN = 0.01;
export const PLAUSIBLE_MAX = 10_000_000;
/** Si la fuente dice que su dato tiene más de 7 días, no se usa (fuente congelada). */
export const MAX_SOURCE_AGE_MS = 7 * 86_400_000;

function checkRate(n: unknown, where: string): number {
  if (typeof n !== "number" || !Number.isFinite(n) || n < PLAUSIBLE_MIN || n > PLAUSIBLE_MAX) throw new RateSourceError(`${where}: tasa no válida`);
  return Math.round(n * 10_000) / 10_000;
}

/** DolarAPI (Venezuela, tasa oficial): {"promedio": 301.37, "fechaActualizacion": "…Z"}. */
export function parseDolarApi(json: unknown, now = Date.now()): RateReading {
  if (typeof json !== "object" || json === null) throw new RateSourceError("dolarapi: respuesta inesperada");
  const o = json as Record<string, unknown>;
  const rate = checkRate(o.promedio ?? o.venta, "dolarapi");
  let publishedAt: Date | null = null;
  if (typeof o.fechaActualizacion === "string") {
    const d = new Date(o.fechaActualizacion);
    if (Number.isNaN(d.getTime())) throw new RateSourceError("dolarapi: fecha no válida");
    publishedAt = d;
    if (now - d.getTime() > MAX_SOURCE_AGE_MS) throw new RateSourceError("dolarapi: el dato tiene más de 7 días");
  }
  return { rate, publishedAt };
}

/** Número con coma decimal («301,37290000») o con punto, con o sin separador de miles. */
export function parseVeNumber(text: string): number {
  const t = text.trim().replace(/\s/g, "");
  if (!/^[0-9][0-9.,]*$/.test(t)) throw new RateSourceError("número no válido");
  const lastComma = t.lastIndexOf(","), lastDot = t.lastIndexOf(".");
  const dec = Math.max(lastComma, lastDot);
  if (dec === -1) return Number(t);
  const intPart = t.slice(0, dec).replace(/[.,]/g, "");
  return Number(`${intPart}.${t.slice(dec + 1)}`);
}

/** Página del BCV: bloque con id="dolar" y el valor dentro de un <strong>, con coma decimal. */
export function parseBcvHtml(html: string): RateReading {
  const at = html.search(/id=["']dolar["']/i);
  if (at === -1) throw new RateSourceError("bcv: no se encontró el bloque del dólar");
  const block = html.slice(at, at + 1500);
  const m = /<strong[^>]*>\s*([0-9][0-9.,\s]*)\s*<\/strong>/i.exec(block);
  if (!m) throw new RateSourceError("bcv: no se encontró el valor");
  return { rate: checkRate(parseVeNumber(m[1]!), "bcv"), publishedAt: null };
}

export interface SourceDef {
  name: RateSourceName;
  url: string;
  parse: (body: string) => RateReading;
}

export const SOURCES: Record<RateSourceName, SourceDef> = {
  dolarapi: { name: "dolarapi", url: "https://ve.dolarapi.com/v1/dolares/oficial", parse: (b) => parseDolarApi(JSON.parse(b)) },
  bcv: { name: "bcv", url: "https://www.bcv.org.ve/", parse: parseBcvHtml },
};

const MAX_BYTES = 1_500_000;

/** Descarga con tiempo límite, sin seguir redirecciones y con tope de tamaño. La dirección es fija (no viene de ningún usuario). */
export async function fetchSource(def: SourceDef, fetchFn: typeof fetch = fetch): Promise<RateReading> {
  let res: Response;
  try {
    res = await fetchFn(def.url, { redirect: "error", signal: AbortSignal.timeout(8_000), headers: { accept: "application/json, text/html", "user-agent": "tasa-bcv/1.0" } });
  } catch (e) {
    throw new RateSourceError(`${def.name}: no respondió (${e instanceof Error ? e.message : "error"})`);
  }
  if (!res.ok) throw new RateSourceError(`${def.name}: respondió ${res.status}`);
  const text = await res.text();
  if (text.length > MAX_BYTES) throw new RateSourceError(`${def.name}: respuesta demasiado grande`);
  try {
    return def.parse(text);
  } catch (e) {
    if (e instanceof RateSourceError) throw e;
    throw new RateSourceError(`${def.name}: respuesta ilegible`);
  }
}
