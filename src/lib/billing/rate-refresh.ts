import { getPool } from "@/lib/db";
import { getRateSources } from "@/lib/env";
import { SOURCES, fetchSource, type RateReading, type SourceDef } from "./rate-source";

export type RefreshResult =
  | { status: "skipped" } // modo manual
  | { status: "ok"; source: string; rate: number }
  | { status: "rejected"; source: string; rate: number }
  | { status: "failed"; error: string };

/**
 * Busca la tasa en las fuentes, en orden, y aplica la primera que responda bien.
 * Si el valor se rechaza por cambio brusco (±15 %) NO se prueba otra fuente: lo decide el admin.
 * Si todas fallan, queda anotado el error y la tasa anterior sigue (a las 36 h sin renovarse, se corta el cobro en bolívares).
 */
export async function refreshRate(
  opts: { sources?: SourceDef[]; read?: (def: SourceDef) => Promise<RateReading> } = {},
): Promise<RefreshResult> {
  const pool = getPool();
  const mode = (await pool.query<{ m: string }>("SELECT rate_mode() AS m")).rows[0]?.m;
  if (mode !== "auto") return { status: "skipped" };
  const sources = opts.sources ?? getRateSources().map((n) => SOURCES[n]);
  const read = opts.read ?? ((d: SourceDef) => fetchSource(d));
  const errors: string[] = [];
  for (const def of sources) {
    let reading: RateReading;
    try {
      reading = await read(def);
    } catch (e) {
      errors.push(e instanceof Error ? e.message : String(e));
      continue;
    }
    const r = await pool.query<{ s: string }>("SELECT rate_apply_auto($1, $2) AS s", [reading.rate, def.name]);
    const s = r.rows[0]!.s;
    if (s === "ok") return { status: "ok", source: def.name, rate: reading.rate };
    if (s === "rejected") return { status: "rejected", source: def.name, rate: reading.rate };
    return { status: "skipped" };
  }
  const error = errors.join(" · ") || "No hay fuentes configuradas";
  await pool.query("SELECT rate_report_failure($1)", [error]);
  return { status: "failed", error };
}
