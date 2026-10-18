/** Dólares: de centavos a «$12,50». */
export function formatUsd(cents: number): string {
  return `$${(cents / 100).toLocaleString("es-VE", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
/** Bolívares: de céntimos a «Bs. 1.234,56». */
export function formatBs(cents: number): string {
  return `Bs. ${(cents / 100).toLocaleString("es-VE", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/**
 * Lee un monto escrito por una persona («1.234,56», «1234.56», «12,5») y lo devuelve en céntimos enteros.
 * null si no es un monto claro. Sin decimales flotantes: se trabaja con texto.
 */
export function parseAmountToCents(input: string): number | null {
  const s = input.trim().replace(/\s/g, "").replace(/^(bs\.?|\$|usd)/i, "");
  if (!/^\d[\d.,]*$/.test(s)) return null;
  const lastComma = s.lastIndexOf(",");
  const lastDot = s.lastIndexOf(".");
  const sepPos = Math.max(lastComma, lastDot);
  let intPart = s, frac = "";
  if (sepPos >= 0) {
    const after = s.length - sepPos - 1;
    // «1.234» (3 dígitos tras un solo punto/coma) es un millar, no un decimal.
    const isThousands = after === 3 && (s.match(/[.,]/g) ?? []).length === 1 && s[sepPos] === ".";
    if (!isThousands && after >= 1 && after <= 2) { intPart = s.slice(0, sepPos); frac = s.slice(sepPos + 1); }
    else if (!isThousands && after !== 0) return null;
  }
  // La parte entera solo puede llevar separadores de millar bien puestos (1.234.567), nunca sueltos.
  if (!/^(\d{1,3}([.,]\d{3})+|\d+)$/.test(intPart)) return null;
  const digits = intPart.replace(/[.,]/g, "");
  if (!/^\d+$/.test(digits) || digits.length > 12) return null;
  const cents = Number(digits) * 100 + Number((frac + "00").slice(0, 2));
  return cents > 0 && Number.isSafeInteger(cents) ? cents : null;
}

/** ¿Lo declarado coincide con lo esperado? Tolera 1 % (redondeos de comisión/tasa). */
export function amountMatches(declaredCents: number, expectedCents: number): boolean {
  return Math.abs(declaredCents - expectedCents) <= Math.max(1, Math.round(expectedCents * 0.01));
}
