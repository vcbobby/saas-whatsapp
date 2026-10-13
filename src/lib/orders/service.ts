import type { PoolClient } from "pg";
import { isCurrency, type Currency } from "@/lib/catalog/money";

type Db = Pick<PoolClient, "query">;

export const MAX_ORDER_LINES = 50;
export const MAX_LINE_QTY = 9999;
export const MAX_ORDER_TOTAL = 1_000_000_000_000;
const MAX_STOCK = 1_000_000;

export interface OrderInput {
  tenantId: string;
  source: "manual" | "agente";
  /** Los pedidos hechos a mano nacen confirmados (descuentan stock); los del asistente nacen pendientes. */
  status: "pendiente" | "confirmado";
  customerName: string;
  customerPhone?: string | null;
  notes?: string | null;
  deliveryNote?: string | null;
  contactId?: string | null;
  conversationId?: string | null;
  requestMessageId?: string | null;
  createdBy?: string | null;
  items: { productId: string; quantity: number }[];
}

export type CreateResult =
  | { kind: "ok"; id: string; number: number; totalMinor: number }
  | { kind: "producto"; productId: string }
  | { kind: "sin_stock"; names: string[] }
  | { kind: "total_excedido" }
  | { kind: "cantidad" }
  | { kind: "repetido"; id: string; number: number; totalMinor: number };

/** Junta líneas repetidas del mismo producto, respetando el orden en que aparecen por primera vez. */
export function mergeLines(items: { productId: string; quantity: number }[]): { productId: string; quantity: number }[] {
  const m = new Map<string, number>();
  for (const i of items) m.set(i.productId, (m.get(i.productId) ?? 0) + i.quantity);
  return [...m.entries()].map(([productId, quantity]) => ({ productId, quantity }));
}

/**
 * Crea un pedido. Los precios y nombres salen SIEMPRE del catálogo (nunca de quien pide), el total lo calcula el servidor
 * y, si el pedido nace confirmado, se descuenta el stock de los productos que lo controlan.
 */
export async function createOrder(db: Db, o: OrderInput): Promise<CreateResult> {
  if (o.requestMessageId) {
    const prev = await db.query("SELECT id, number, total_minor FROM orders WHERE tenant_id = $1 AND request_message_id = $2", [o.tenantId, o.requestMessageId]);
    if (prev.rowCount === 1) return { kind: "repetido", id: prev.rows[0].id, number: prev.rows[0].number, totalMinor: Number(prev.rows[0].total_minor) };
  }
  const lines = mergeLines(o.items);
  if (lines.some((l) => l.quantity > MAX_LINE_QTY)) return { kind: "cantidad" };
  const prods = await db.query(
    "SELECT id, name, unit, price_minor, stock, active FROM catalog_products WHERE tenant_id = $1 AND id = ANY($2::uuid[]) ORDER BY id FOR UPDATE", // siempre en el mismo orden: dos pedidos a la vez no se bloquean entre sí
    [o.tenantId, lines.map((l) => l.productId)],
  );
  const byId = new Map(prods.rows.map((p) => [p.id as string, p]));
  let total = 0;
  const short: string[] = [];
  for (const l of lines) {
    const p = byId.get(l.productId);
    if (!p || !p.active) return { kind: "producto", productId: l.productId };
    total += Number(p.price_minor) * l.quantity;
    if (o.status === "confirmado" && p.stock !== null && p.stock < l.quantity) short.push(p.name as string);
  }
  if (total > MAX_ORDER_TOTAL) return { kind: "total_excedido" };
  if (short.length > 0) return { kind: "sin_stock", names: short };

  const cur = await db.query("SELECT currency FROM catalog_settings WHERE tenant_id = $1", [o.tenantId]);
  const currency: Currency = isCurrency(cur.rows[0]?.currency) ? cur.rows[0].currency : "USD";
  const num = await db.query(
    `INSERT INTO order_counters (tenant_id, last_number) VALUES ($1, 1)
     ON CONFLICT (tenant_id) DO UPDATE SET last_number = order_counters.last_number + 1 RETURNING last_number`,
    [o.tenantId],
  );
  const number = num.rows[0].last_number as number;
  const ins = await db.query(
    `INSERT INTO orders (tenant_id, number, contact_id, conversation_id, customer_name, customer_phone, notes, delivery_note, status, source, currency, total_minor, request_message_id, created_by, confirmed_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, CASE WHEN $9 = 'confirmado' THEN now() END) RETURNING id`,
    [o.tenantId, number, o.contactId ?? null, o.conversationId ?? null, o.customerName, o.customerPhone || null, o.notes || null, o.deliveryNote || null, o.status, o.source, currency, total, o.requestMessageId ?? null, o.createdBy ?? null],
  );
  const id = ins.rows[0].id as string;
  let pos = 0;
  for (const l of lines) {
    const p = byId.get(l.productId)!;
    const takes = o.status === "confirmado" && p.stock !== null;
    await db.query(
      `INSERT INTO order_items (tenant_id, order_id, product_id, position, name, unit, unit_price_minor, quantity, line_total_minor, stock_taken)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [o.tenantId, id, l.productId, ++pos, p.name, p.unit, p.price_minor, l.quantity, Number(p.price_minor) * l.quantity, takes],
    );
    if (takes) await db.query("UPDATE catalog_products SET stock = stock - $3, updated_at = now() WHERE tenant_id = $1 AND id = $2", [o.tenantId, l.productId, l.quantity]);
  }
  return { kind: "ok", id, number, totalMinor: total };
}

export type OrderAction = "confirm" | "deliver" | "cancel";
export type TransitionResult = { kind: "ok" } | { kind: "no_existe" } | { kind: "estado" } | { kind: "sin_stock"; names: string[] };

/** Cambia el estado de un pedido. Confirmar descuenta stock; cancelar un pedido confirmado lo devuelve. Entregado y cancelado son finales. */
export async function transitionOrder(db: Db, tenantId: string, id: string, action: OrderAction): Promise<TransitionResult> {
  const cur = await db.query("SELECT status FROM orders WHERE tenant_id = $1 AND id = $2 FOR UPDATE", [tenantId, id]);
  if (cur.rowCount !== 1) return { kind: "no_existe" };
  const status = cur.rows[0].status as string;

  if (action === "confirm") {
    if (status !== "pendiente") return { kind: "estado" };
    const items = await db.query(
      `SELECT i.id, i.product_id, i.quantity, p.name, p.stock FROM order_items i JOIN catalog_products p ON p.tenant_id = i.tenant_id AND p.id = i.product_id
        WHERE i.tenant_id = $1 AND i.order_id = $2 ORDER BY i.product_id FOR UPDATE OF p`,
      [tenantId, id],
    );
    const short = items.rows.filter((r) => r.stock !== null && r.stock < r.quantity).map((r) => r.name as string);
    if (short.length > 0) return { kind: "sin_stock", names: short };
    for (const r of items.rows) {
      if (r.stock === null) continue;
      await db.query("UPDATE catalog_products SET stock = stock - $3, updated_at = now() WHERE tenant_id = $1 AND id = $2", [tenantId, r.product_id, r.quantity]);
      await db.query("UPDATE order_items SET stock_taken = true WHERE tenant_id = $1 AND id = $2", [tenantId, r.id]);
    }
    await db.query("UPDATE orders SET status = 'confirmado', confirmed_at = now(), updated_at = now() WHERE tenant_id = $1 AND id = $2", [tenantId, id]);
    return { kind: "ok" };
  }

  if (action === "deliver") {
    if (status !== "confirmado") return { kind: "estado" };
    await db.query("UPDATE orders SET status = 'entregado', delivered_at = now(), updated_at = now() WHERE tenant_id = $1 AND id = $2", [tenantId, id]);
    return { kind: "ok" };
  }

  // cancel
  if (status !== "pendiente" && status !== "confirmado") return { kind: "estado" };
  const taken = await db.query("SELECT id, product_id, quantity FROM order_items WHERE tenant_id = $1 AND order_id = $2 AND stock_taken ORDER BY product_id", [tenantId, id]);
  for (const r of taken.rows) {
    await db.query("UPDATE catalog_products SET stock = LEAST(stock + $3, $4), updated_at = now() WHERE tenant_id = $1 AND id = $2 AND stock IS NOT NULL", [tenantId, r.product_id, r.quantity, MAX_STOCK]);
    await db.query("UPDATE order_items SET stock_taken = false WHERE tenant_id = $1 AND id = $2", [tenantId, r.id]);
  }
  await db.query("UPDATE orders SET status = 'cancelado', cancelled_at = now(), updated_at = now() WHERE tenant_id = $1 AND id = $2", [tenantId, id]);
  return { kind: "ok" };
}
