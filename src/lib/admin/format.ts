// Formatos de cifras para pantallas (sin acceso a la base de datos: se pueden usar también en componentes del navegador).

/** «1.234» / «12,3 mil» / «1,2 M» (millones) / «3 mil M» (miles de millones): tokens legibles. */
export function formatTokens(v: number): string {
  if (v < 10_000) return Math.round(v).toLocaleString("es");
  if (v < 1_000_000) return `${(v / 1000).toLocaleString("es", { maximumFractionDigits: 1 })} mil`;
  if (v < 1_000_000_000) return `${(v / 1_000_000).toLocaleString("es", { maximumFractionDigits: 2 })} M`;
  return `${(v / 1_000_000_000).toLocaleString("es", { maximumFractionDigits: 2 })} mil M`; // mil millones
}

export const formatUsd = (v: number): string => `US$ ${v.toLocaleString("es", { minimumFractionDigits: 2, maximumFractionDigits: v < 1 ? 4 : 2 })}`;
