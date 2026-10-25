/** Cuando un producto no tiene «avisar cuando queden X», se usa este número (el asistente y el resumen diario ya lo usaban). */
export const DEFAULT_LOW_STOCK = 10;

export type StockStatus = "agotado" | "bajo" | "ok" | "sin_control";

export function stockStatus(stock: number | null, minStock: number | null): StockStatus {
  if (stock === null) return "sin_control";
  if (stock === 0) return "agotado";
  return stock <= (minStock ?? DEFAULT_LOW_STOCK) ? "bajo" : "ok";
}
