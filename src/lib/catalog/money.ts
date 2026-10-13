/**
 * Dinero del catálogo. Se guarda como entero en la unidad menor (2 decimales): nunca con decimales flotantes.
 * Todas las monedas usan 2 decimales aquí, para mantener una sola regla simple.
 */
export const CURRENCIES = ["USD", "VES", "EUR", "COP", "MXN", "PEN"] as const;
export type Currency = (typeof CURRENCIES)[number];

export const CURRENCY_INFO: Record<Currency, { label: string; prefix: string }> = {
  USD: { label: "Dólares (USD)", prefix: "$" },
  VES: { label: "Bolívares (VES)", prefix: "Bs. " },
  EUR: { label: "Euros (EUR)", prefix: "€" },
  COP: { label: "Pesos colombianos (COP)", prefix: "COP " },
  MXN: { label: "Pesos mexicanos (MXN)", prefix: "MXN " },
  PEN: { label: "Soles (PEN)", prefix: "S/ " },
};

export const MAX_MINOR = 10_000_000_000;
export const MAX_STOCK = 1_000_000;

export function isCurrency(v: unknown): v is Currency {
  return typeof v === "string" && (CURRENCIES as readonly string[]).includes(v);
}

/**
 * Lee un precio escrito por una persona: «10», «10.5», «10,50». Sin separadores de miles
 * («1.250» sería ambiguo) y como máximo 2 decimales. Devuelve la unidad menor o null si no es válido.
 */
export function parseMoney(input: string): number | null {
  const s = input.trim();
  const m = /^(\d{1,10})(?:[.,](\d{1,2}))?$/.exec(s);
  if (!m) return null;
  const minor = Number(m[1]) * 100 + Number((m[2] ?? "").padEnd(2, "0") || "0");
  return minor <= MAX_MINOR ? minor : null;
}

/** «1050» → «$10,50»; «1000» → «$10». Separador de miles con punto, decimales con coma. */
export function formatMoney(minor: number, currency: Currency): string {
  const whole = Math.floor(minor / 100);
  const cents = minor % 100;
  const w = String(whole).replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  return `${CURRENCY_INFO[currency].prefix}${w}${cents ? `,${String(cents).padStart(2, "0")}` : ""}`;
}

/** Para rellenar un campo de texto al editar: 1050 → «10,50». */
export function minorToInput(minor: number): string {
  const cents = minor % 100;
  return `${Math.floor(minor / 100)}${cents ? `,${String(cents).padStart(2, "0")}` : ""}`;
}
