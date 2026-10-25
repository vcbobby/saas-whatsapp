import type { PoolClient } from "pg";
import { MAX_STOCK } from "@/lib/catalog/money";
import { stockStatus, type StockStatus } from "@/lib/inventory/levels";

type Db = Pick<PoolClient, "query">;

export type MovementKind = "inicial" | "entrada" | "salida" | "merma" | "ajuste" | "pedido" | "devolucion" | "edicion";
export interface StockContext { kind: MovementKind; note?: string | null; orderId?: string | null; userId?: string | null }

/**
 * Dice por qué va a cambiar el stock en esta transacción (el disparador de la base lo anota). Siempre se usa dentro de
 * withTenant: los valores duran solo hasta el final de la transacción. `clearStockContext` los quita antes, por si sigue más trabajo.
 */
export async function setStockContext(db: Db, c: StockContext): Promise<void> {
  await db.query(
    `SELECT set_config('app.stock_kind', $1, true), set_config('app.stock_note', $2, true), set_config('app.stock_order', $3, true), set_config('app.stock_user', $4, true)`,
    [c.kind, c.note ?? "", c.orderId ?? "", c.userId ?? ""],
  );
}
export async function clearStockContext(db: Db): Promise<void> {
  await db.query(`SELECT set_config('app.stock_kind', '', true), set_config('app.stock_note', '', true), set_config('app.stock_order', '', true), set_config('app.stock_user', '', true)`);
}

export type AdjustMode = "entrada" | "salida" | "merma" | "conteo";
export type AdjustResult =
  | { kind: "ok"; stock: number; delta: number }
  | { kind: "no_existe" }
  | { kind: "sin_control" }
  | { kind: "sin_stock"; stock: number }
  | { kind: "excede" }
  | { kind: "sin_cambio"; stock: number };

/**
 * Ajuste manual. entrada = suma, salida/merma = resta (sin dejar negativo), conteo = «en el estante hay N» (fija el valor).
 * Un conteo también sirve para EMPEZAR a controlar el stock de un producto que no lo tenía.
 */
export async function adjustStock(db: Db, tenantId: string, a: { productId: string; mode: AdjustMode; quantity: number; note?: string | null; userId?: string | null }): Promise<AdjustResult> {
  const cur = await db.query("SELECT stock FROM catalog_products WHERE tenant_id = $1 AND id = $2 FOR UPDATE", [tenantId, a.productId]);
  if (cur.rowCount !== 1) return { kind: "no_existe" };
  const before = cur.rows[0].stock as number | null;
  let next: number;
  if (a.mode === "conteo") {
    next = a.quantity;
  } else {
    if (before === null) return { kind: "sin_control" };
    next = a.mode === "entrada" ? before + a.quantity : before - a.quantity;
    if (next < 0) return { kind: "sin_stock", stock: before };
  }
  if (next > MAX_STOCK) return { kind: "excede" };
  if (before === next) return { kind: "sin_cambio", stock: next };
  const kind: MovementKind = a.mode === "conteo" ? "ajuste" : a.mode;
  await setStockContext(db, { kind, note: a.note, userId: a.userId });
  await db.query("UPDATE catalog_products SET stock = $3, updated_at = now() WHERE tenant_id = $1 AND id = $2", [tenantId, a.productId, next]);
  await clearStockContext(db);
  return { kind: "ok", stock: next, delta: next - (before ?? 0) };
}

export interface InventoryRow { id: string; name: string; unit: string | null; stock: number | null; minStock: number | null; status: StockStatus }
export interface InventorySummary { tracked: number; low: number; out: number; untracked: number }
export type InventoryFilter = "all" | "low" | "out" | "untracked";

const ORDER = { agotado: 0, bajo: 1, ok: 2, sin_control: 3 } as const;

/** Productos activos con su estado de stock, más urgentes primero. */
export async function listInventory(db: Db, tenantId: string, o: { filter?: InventoryFilter; q?: string; limit?: number } = {}): Promise<{ rows: InventoryRow[]; summary: InventorySummary }> {
  const r = await db.query("SELECT id, name, unit, stock, min_stock FROM catalog_products WHERE tenant_id = $1 AND active ORDER BY lower(name) LIMIT 500", [tenantId]);
  const all: InventoryRow[] = r.rows.map((p) => ({ id: p.id, name: p.name, unit: p.unit, stock: p.stock, minStock: p.min_stock, status: stockStatus(p.stock, p.min_stock) }));
  const summary: InventorySummary = { tracked: 0, low: 0, out: 0, untracked: 0 };
  for (const p of all) {
    if (p.status === "sin_control") summary.untracked++;
    else summary.tracked++;
    if (p.status === "bajo") summary.low++;
    if (p.status === "agotado") summary.out++;
  }
  const q = (o.q ?? "").trim().toLowerCase();
  let rows = all.filter((p) => !q || p.name.toLowerCase().includes(q));
  const f = o.filter ?? "all";
  if (f === "low") rows = rows.filter((p) => p.status === "bajo");
  else if (f === "out") rows = rows.filter((p) => p.status === "agotado");
  else if (f === "untracked") rows = rows.filter((p) => p.status === "sin_control");
  rows.sort((a, b) => ORDER[a.status] - ORDER[b.status] || a.name.localeCompare(b.name, "es"));
  return { rows: rows.slice(0, o.limit ?? 500), summary };
}

export interface MovementRow { id: string; productId: string; productName: string; kind: MovementKind; delta: number; stockAfter: number; note: string | null; orderNumber: number | null; /** yo = quien consulta; equipo = otra persona del negocio; sistema = pedido o automático. */ actor: "yo" | "equipo" | "sistema"; at: string }

export async function listMovements(db: Db, tenantId: string, o: { productId?: string; limit?: number; viewerId?: string | null } = {}): Promise<MovementRow[]> {
  const r = await db.query(
    `SELECT m.id, m.product_id, p.name AS product_name, m.kind, m.delta, m.stock_after, m.note, od.number AS order_number, m.created_by, m.created_at
       FROM stock_movements m
       JOIN catalog_products p ON p.tenant_id = m.tenant_id AND p.id = m.product_id
       LEFT JOIN orders od ON od.tenant_id = m.tenant_id AND od.id = m.order_id
      WHERE m.tenant_id = $1 AND ($2::uuid IS NULL OR m.product_id = $2)
      ORDER BY m.created_at DESC, m.id DESC LIMIT $3`,
    [tenantId, o.productId ?? null, Math.min(o.limit ?? 100, 1000)],
  );
  return r.rows.map((x) => ({ id: x.id, productId: x.product_id, productName: x.product_name, kind: x.kind, delta: x.delta, stockAfter: x.stock_after, note: x.note, orderNumber: x.order_number, actor: x.created_by ? (x.created_by === o.viewerId ? "yo" : "equipo") : "sistema", at: new Date(x.created_at).toISOString() }));
}

/** Celdas que Excel o Sheets podrían leer como fórmula se marcan con una comilla: así un nombre malicioso no ejecuta nada. */
export function csvCell(v: unknown): string {
  let s = v === null || v === undefined ? "" : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
export const csvLine = (cells: unknown[]) => cells.map(csvCell).join(",");
