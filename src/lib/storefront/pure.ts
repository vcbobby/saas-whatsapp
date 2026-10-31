import { formatMoney, type Currency } from "@/lib/catalog/money";

/** Deja solo los dígitos del teléfono; null si no sirve para wa.me (con código de país, sin 0 inicial, 8–15 dígitos). */
export function normalizePhone(input: string): string | null {
  const d = input.replace(/[\s().+-]/g, "");
  if (!/^\d+$/.test(d)) return null;
  return /^[1-9]\d{7,14}$/.test(d) ? d : null;
}

export interface CartLine { name: string; unitMinor: number; qty: number }

/** Texto del pedido que se manda por WhatsApp. */
export function orderText(business: string, lines: CartLine[], currency: Currency): string {
  const items = lines.filter((l) => l.qty > 0);
  if (items.length === 0) return `Hola, vi el catálogo de ${business} y quiero hacer una consulta.`;
  const total = items.reduce((s, l) => s + l.unitMinor * l.qty, 0);
  return [`Hola, quiero hacer un pedido en ${business}:`, ...items.map((l) => `- ${l.qty} x ${l.name}`), `Total aproximado: ${formatMoney(total, currency)}`].join("\n");
}

export const waLink = (phone: string, text: string) => `https://wa.me/${phone}?text=${encodeURIComponent(text)}`;
