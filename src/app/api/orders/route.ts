import { z } from "zod";
import { requireTenant } from "@/lib/auth/guard";
import { checkOrigin, errorResponse, jsonResponse, readJson, route } from "@/lib/auth/http";
import { withTenant } from "@/lib/db";
import { MAX_LINE_QTY, MAX_ORDER_LINES, createOrder } from "@/lib/orders/service";

const STATUSES = ["pendiente", "confirmado", "entregado", "cancelado"] as const;
const PAGE = 100;

/** Pedidos más recientes primero. `status` filtra; `before` (número de pedido) pide la página anterior. */
export const GET = route(async (req) => {
  const auth = await requireTenant(req, "orders:read");
  if (!auth.ok) return auth.response;
  const sp = new URL(req.url).searchParams;
  const q = z.object({ status: z.enum(STATUSES).optional(), before: z.coerce.number().int().positive().optional() }).safeParse({ status: sp.get("status") ?? undefined, before: sp.get("before") ?? undefined });
  if (!q.success) return errorResponse(400, "datos_invalidos", "Filtro inválido.");
  const { tenantId } = auth.ctx;
  const data = await withTenant(tenantId, async (db) => {
    const orders = await db.query(
      `SELECT id, number, status, source, customer_name, customer_phone, notes, delivery_note, currency, total_minor, conversation_id, created_at, confirmed_at, delivered_at, cancelled_at,
              payment_state, paid_at, payment_method, (proof_message_id IS NOT NULL) AS has_proof
         FROM orders WHERE tenant_id = $1 AND ($2::text IS NULL OR status = $2) AND ($3::int IS NULL OR number < $3)
        ORDER BY number DESC LIMIT $4`,
      [tenantId, q.data.status ?? null, q.data.before ?? null, PAGE + 1],
    );
    const page = orders.rows.slice(0, PAGE);
    const items = page.length
      ? await db.query("SELECT order_id, name, unit, unit_price_minor, quantity, line_total_minor FROM order_items WHERE tenant_id = $1 AND order_id = ANY($2::uuid[]) ORDER BY order_id, position", [tenantId, page.map((o) => o.id)])
      : { rows: [] as Record<string, unknown>[] };
    const counts = await db.query("SELECT status, count(*)::int AS n FROM orders WHERE tenant_id = $1 GROUP BY status", [tenantId]);
    return { page, more: orders.rows.length > PAGE, items: items.rows, counts: counts.rows };
  });
  const counts: Record<string, number> = { pendiente: 0, confirmado: 0, entregado: 0, cancelado: 0 };
  for (const c of data.counts) counts[c.status as string] = c.n as number;
  return jsonResponse({
    counts,
    more: data.more,
    orders: data.page.map((o) => ({
      id: o.id, number: o.number, status: o.status, source: o.source, customerName: o.customer_name, customerPhone: o.customer_phone,
      notes: o.notes, deliveryNote: o.delivery_note, currency: o.currency, totalMinor: Number(o.total_minor), conversationId: o.conversation_id,
      paymentState: o.payment_state, paidAt: o.paid_at, paymentMethod: o.payment_method, hasProof: o.has_proof === true,
      createdAt: o.created_at, confirmedAt: o.confirmed_at, deliveredAt: o.delivered_at, cancelledAt: o.cancelled_at,
      items: data.items.filter((i) => i.order_id === o.id).map((i) => ({ name: i.name, unit: i.unit, unitPriceMinor: Number(i.unit_price_minor), quantity: i.quantity, lineTotalMinor: Number(i.line_total_minor) })),
    })),
  });
});

const createSchema = z.object({
  customerName: z.string().trim().min(1, "Escribe el nombre del cliente").max(120, "Máximo 120 caracteres"),
  customerPhone: z.string().trim().regex(/^\+?[0-9 ()-]{5,32}$/, "Teléfono inválido").optional(),
  notes: z.string().trim().max(1000, "Máximo 1000 caracteres").optional(),
  deliveryNote: z.string().trim().max(300, "Máximo 300 caracteres").optional(),
  conversationId: z.uuid().optional(),
  items: z.array(z.object({ productId: z.uuid(), quantity: z.number().int("La cantidad debe ser un número entero").min(1, "La cantidad mínima es 1").max(MAX_LINE_QTY, `La cantidad máxima es ${MAX_LINE_QTY}`) })).min(1, "Agrega al menos un producto").max(MAX_ORDER_LINES, `Máximo ${MAX_ORDER_LINES} productos por pedido`),
});

/** Pedido hecho a mano: nace confirmado y descuenta stock. Los precios los pone el servidor, desde el catálogo. */
export const POST = route(async (req) => {
  const blocked = checkOrigin(req);
  if (blocked) return blocked;
  const auth = await requireTenant(req, "orders:write");
  if (!auth.ok) return auth.response;
  const body = await readJson(req, createSchema);
  if (!body.ok) return body.response;
  const { tenantId } = auth.ctx;
  const d = body.data;
  const out = await withTenant(tenantId, async (db) => {
    let contactId: string | null = null;
    if (d.conversationId) {
      const c = await db.query("SELECT contact_id FROM conversations WHERE tenant_id = $1 AND id = $2", [tenantId, d.conversationId]);
      if (c.rowCount !== 1) return { kind: "conversacion" as const };
      contactId = c.rows[0].contact_id as string;
    }
    return createOrder(db, { tenantId, source: "manual", status: "confirmado", customerName: d.customerName, customerPhone: d.customerPhone, notes: d.notes, deliveryNote: d.deliveryNote, contactId, conversationId: d.conversationId ?? null, createdBy: auth.session.userId, items: d.items });
  });
  if (out.kind === "conversacion") return errorResponse(404, "no_encontrado", "Conversación no encontrada.");
  if (out.kind === "producto") return errorResponse(404, "producto_no_disponible", "Uno de los productos no existe o está desactivado.");
  if (out.kind === "sin_stock") return errorResponse(409, "sin_stock", `No hay stock suficiente de: ${out.names.join(", ")}.`);
  if (out.kind === "cantidad") return errorResponse(400, "cantidad_excedida", `La cantidad máxima por producto es ${MAX_LINE_QTY}.`);
  if (out.kind === "total_excedido") return errorResponse(400, "total_excedido", "El total del pedido es demasiado grande.");
  if (out.kind === "repetido") return jsonResponse({ ok: true, id: out.id, number: out.number }, 200);
  return jsonResponse({ ok: true, id: out.id, number: out.number, totalMinor: out.totalMinor }, 201);
});
