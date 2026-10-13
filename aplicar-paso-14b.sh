#!/usr/bin/env bash
# Paso 14B: pedidos (crear, confirmar, entregar, cancelar) con control de stock.
# Ejecútalo desde la raíz del proyecto:  bash aplicar-paso-14b.sh
set -euo pipefail

[ -f package.json ] && grep -q '"name": "saas-whatsapp"' package.json || { echo "✖ Ejecuta esto dentro de ~/proyectos/saas-whatsapp"; exit 1; }
[ -f db/migrations/0013_agenda.sql ] || { echo "✖ Falta el Paso 13A (migración 0013). Aplícalo primero."; exit 1; }
[ -f db/migrations/0015_catalogo.sql ] || { echo "✖ Falta el Paso 14A (migración 0015). Aplícalo primero."; exit 1; }
[ -f src/components/AppHeader.tsx ] || { echo "✖ No encuentro la cabecera de la aplicación"; exit 1; }

if [ "$(git rev-parse --abbrev-ref HEAD 2>/dev/null)" = "main" ]; then
  git checkout -b paso-14b 2>/dev/null || git checkout paso-14b
  echo "✔ Rama paso-14b lista"
fi

BK=".paso14b-backup"
mkdir -p "$BK"
backup() { if [ -f "$1" ]; then mkdir -p "$BK/$(dirname "$1")"; cp "$1" "$BK/$1"; fi; }
grep -q "^.paso14b-backup" .gitignore 2>/dev/null || printf "\n.paso14b-backup/\n" >> .gitignore
backup db/migrations/0016_pedidos.sql
backup src/lib/orders/service.ts
backup src/lib/auth/permissions.ts
backup src/app/api/orders/route.ts
backup src/app/api/orders/update/route.ts
backup src/components/OrdersManager.tsx
backup src/components/AppHeader.tsx
backup src/app/pedidos/page.tsx
backup tests/orders.test.ts

mkdir -p db/migrations
cat > db/migrations/0016_pedidos.sql <<'EOF_DB_MIGRATIONS_0016_PEDIDOS_SQL'
-- Paso 14B: pedidos. Cada pedido guarda una COPIA del nombre y del precio de cada producto (cambiar el catálogo después no altera pedidos viejos).
-- El total se calcula en el servidor y la base de datos verifica que coincida con la suma de las líneas.

-- Número de pedido por negocio (#1, #2, …). Se incrementa dentro de la misma transacción que crea el pedido: sin huecos ni repetidos.
CREATE TABLE order_counters (
  tenant_id uuid PRIMARY KEY REFERENCES tenants (id) ON DELETE CASCADE,
  last_number integer NOT NULL DEFAULT 0 CHECK (last_number >= 0)
);
ALTER TABLE order_counters ENABLE ROW LEVEL SECURITY;
ALTER TABLE order_counters FORCE ROW LEVEL SECURITY;
CREATE POLICY order_counters_aislamiento ON order_counters
  USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());

CREATE TABLE orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  number integer NOT NULL CHECK (number > 0),
  contact_id uuid,
  conversation_id uuid,
  customer_name text NOT NULL CHECK (char_length(customer_name) BETWEEN 1 AND 120),
  customer_phone text CHECK (char_length(customer_phone) <= 32),
  notes text CHECK (char_length(notes) <= 1000),
  delivery_note text CHECK (char_length(delivery_note) <= 300),
  status text NOT NULL DEFAULT 'pendiente' CHECK (status IN ('pendiente', 'confirmado', 'entregado', 'cancelado')),
  source text NOT NULL CHECK (source IN ('manual', 'agente')),
  currency text NOT NULL CHECK (currency IN ('USD', 'VES', 'EUR', 'COP', 'MXN', 'PEN')),
  total_minor bigint NOT NULL CHECK (total_minor BETWEEN 0 AND 1000000000000),
  request_message_id uuid,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  confirmed_at timestamptz,
  delivered_at timestamptz,
  cancelled_at timestamptz,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, number),
  FOREIGN KEY (tenant_id, contact_id) REFERENCES contacts (tenant_id, id) ON DELETE SET NULL (contact_id),
  FOREIGN KEY (tenant_id, conversation_id) REFERENCES conversations (tenant_id, id) ON DELETE SET NULL (conversation_id),
  FOREIGN KEY (tenant_id, request_message_id) REFERENCES messages (tenant_id, id) ON DELETE SET NULL (request_message_id),
  CHECK (request_message_id IS NULL OR source = 'agente'),
  CHECK ((status = 'cancelado') = (cancelled_at IS NOT NULL)),
  CHECK ((status = 'entregado') = (delivered_at IS NOT NULL)),
  CHECK (status = 'pendiente' OR status = 'cancelado' OR confirmed_at IS NOT NULL)
);
CREATE UNIQUE INDEX orders_mensaje_unico_idx ON orders (tenant_id, request_message_id) WHERE request_message_id IS NOT NULL;
CREATE INDEX orders_lista_idx ON orders (tenant_id, status, number DESC);
ALTER TABLE orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE orders FORCE ROW LEVEL SECURITY;
CREATE POLICY orders_aislamiento ON orders
  USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());

CREATE TABLE order_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  order_id uuid NOT NULL,
  product_id uuid NOT NULL,
  position smallint NOT NULL CHECK (position BETWEEN 1 AND 50),
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 120),
  unit text CHECK (char_length(unit) <= 40),
  unit_price_minor bigint NOT NULL CHECK (unit_price_minor BETWEEN 0 AND 10000000000),
  quantity integer NOT NULL CHECK (quantity BETWEEN 1 AND 9999),
  line_total_minor bigint NOT NULL,
  -- true = al confirmar se descontó stock de este producto (al cancelar se devuelve exactamente eso).
  stock_taken boolean NOT NULL DEFAULT false,
  UNIQUE (tenant_id, order_id, product_id),
  CHECK (line_total_minor = unit_price_minor * quantity),
  FOREIGN KEY (tenant_id, order_id) REFERENCES orders (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, product_id) REFERENCES catalog_products (tenant_id, id)
);
CREATE INDEX order_items_pedido_idx ON order_items (tenant_id, order_id, position);
ALTER TABLE order_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE order_items FORCE ROW LEVEL SECURITY;
CREATE POLICY order_items_aislamiento ON order_items
  USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());

-- Al terminar la transacción: todo pedido tiene al menos una línea y su total es la suma de las líneas.
CREATE FUNCTION orders_check_total() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE s bigint; n integer;
BEGIN
  SELECT COALESCE(SUM(line_total_minor), 0), COUNT(*) INTO s, n FROM order_items WHERE tenant_id = NEW.tenant_id AND order_id = NEW.id;
  IF n = 0 OR s <> NEW.total_minor THEN
    RAISE EXCEPTION 'el total del pedido no coincide con sus productos' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END
$$;
CREATE CONSTRAINT TRIGGER orders_total_check AFTER INSERT ON orders
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION orders_check_total();

-- Lo que define un pedido no cambia después de creado: solo su estado, sus fechas y las notas de seguimiento.
CREATE FUNCTION orders_immutable() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.number IS DISTINCT FROM OLD.number OR NEW.total_minor IS DISTINCT FROM OLD.total_minor OR NEW.currency IS DISTINCT FROM OLD.currency
     OR NEW.source IS DISTINCT FROM OLD.source OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id THEN
    RAISE EXCEPTION 'un pedido no puede cambiar su número, total, moneda ni origen' USING ERRCODE = '23514';
  END IF;
  -- Estados finales: un pedido entregado o cancelado ya no cambia de estado.
  IF OLD.status IN ('entregado', 'cancelado') AND NEW.status IS DISTINCT FROM OLD.status THEN
    RAISE EXCEPTION 'un pedido % no puede cambiar de estado', OLD.status USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER orders_immutable BEFORE UPDATE ON orders FOR EACH ROW EXECUTE FUNCTION orders_immutable();

CREATE FUNCTION order_items_immutable() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.order_id IS DISTINCT FROM OLD.order_id OR NEW.product_id IS DISTINCT FROM OLD.product_id OR NEW.name IS DISTINCT FROM OLD.name
     OR NEW.unit IS DISTINCT FROM OLD.unit OR NEW.unit_price_minor IS DISTINCT FROM OLD.unit_price_minor OR NEW.quantity IS DISTINCT FROM OLD.quantity
     OR NEW.line_total_minor IS DISTINCT FROM OLD.line_total_minor OR NEW.position IS DISTINCT FROM OLD.position THEN
    RAISE EXCEPTION 'las líneas de un pedido no se modifican' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER order_items_immutable BEFORE UPDATE ON order_items FOR EACH ROW EXECUTE FUNCTION order_items_immutable();
EOF_DB_MIGRATIONS_0016_PEDIDOS_SQL
echo "✔ db/migrations/0016_pedidos.sql"
mkdir -p src/lib/orders
cat > src/lib/orders/service.ts <<'EOF_SRC_LIB_ORDERS_SERVICE_TS'
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
EOF_SRC_LIB_ORDERS_SERVICE_TS
echo "✔ src/lib/orders/service.ts"
mkdir -p src/lib/auth
cat > src/lib/auth/permissions.ts <<'EOF_SRC_LIB_AUTH_PERMISSIONS_TS'
export const ROLES = ["owner", "admin", "agent"] as const;
export type Role = (typeof ROLES)[number];

const MATRIX = {
  "conversations:read": ["owner", "admin", "agent"],
  "conversations:reply": ["owner", "admin", "agent"],
  "contacts:manage": ["owner", "admin"],
  "team:manage": ["owner", "admin"],
  "team:roles": ["owner"],
  "settings:edit": ["owner", "admin"],
  "integrations:manage": ["owner", "admin"],
  "agent:manage": ["owner", "admin"],
  "agenda:read": ["owner", "admin", "agent"],
  "agenda:manage": ["owner", "admin"],
  "agenda:book": ["owner", "admin", "agent"],
  "catalog:read": ["owner", "admin", "agent"],
  "catalog:manage": ["owner", "admin"],
  "orders:read": ["owner", "admin", "agent"],
  "orders:write": ["owner", "admin", "agent"],
  "billing:manage": ["owner"],
  "tenant:delete": ["owner"],
} as const satisfies Record<string, readonly Role[]>;

export type Permission = keyof typeof MATRIX;

export function can(role: Role | null | undefined, permission: Permission): boolean {
  if (!role) return false;
  return (MATRIX[permission] as readonly Role[]).includes(role);
}
EOF_SRC_LIB_AUTH_PERMISSIONS_TS
echo "✔ src/lib/auth/permissions.ts"
mkdir -p src/app/api/orders
cat > src/app/api/orders/route.ts <<'EOF_SRC_APP_API_ORDERS_ROUTE_TS'
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
      `SELECT id, number, status, source, customer_name, customer_phone, notes, delivery_note, currency, total_minor, conversation_id, created_at, confirmed_at, delivered_at, cancelled_at
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
EOF_SRC_APP_API_ORDERS_ROUTE_TS
echo "✔ src/app/api/orders/route.ts"
mkdir -p src/app/api/orders/update
cat > src/app/api/orders/update/route.ts <<'EOF_SRC_APP_API_ORDERS_UPDATE_ROUTE_TS'
import { z } from "zod";
import { requireTenant } from "@/lib/auth/guard";
import { checkOrigin, errorResponse, jsonResponse, readJson, route } from "@/lib/auth/http";
import { withTenant } from "@/lib/db";
import { transitionOrder } from "@/lib/orders/service";

const schema = z.object({ id: z.uuid(), action: z.enum(["confirm", "deliver", "cancel"]) });

/** Confirmar (descuenta stock), marcar entregado o cancelar (devuelve el stock). La tarea «Confirmar pedido» del asistente se cierra sola. */
export const POST = route(async (req) => {
  const blocked = checkOrigin(req);
  if (blocked) return blocked;
  const auth = await requireTenant(req, "orders:write");
  if (!auth.ok) return auth.response;
  const body = await readJson(req, schema);
  if (!body.ok) return body.response;
  const { tenantId } = auth.ctx;
  const { id, action } = body.data;
  const out = await withTenant(tenantId, async (db) => {
    await db.query("SELECT set_config('app.actor', $1, true)", [auth.session.userId]);
    const r = await transitionOrder(db, tenantId, id, action);
    if (r.kind === "ok" && (action === "confirm" || action === "cancel")) {
      await db.query(
        "UPDATE work_items SET status = $3, resolved_at = now(), resolved_by = $4 WHERE tenant_id = $1 AND dedupe_key = $2 AND status IN ('abierto', 'en_proceso')",
        [tenantId, `pedido:${id}`, action === "confirm" ? "resuelto" : "descartado", auth.session.userId],
      );
    }
    return r;
  });
  if (out.kind === "no_existe") return errorResponse(404, "no_encontrado", "No encontrado.");
  if (out.kind === "estado") return errorResponse(409, "estado_invalido", "El pedido ya cambió. Actualiza la pantalla.");
  if (out.kind === "sin_stock") return errorResponse(409, "sin_stock", `No hay stock suficiente de: ${out.names.join(", ")}.`);
  return jsonResponse({ ok: true });
});
EOF_SRC_APP_API_ORDERS_UPDATE_ROUTE_TS
echo "✔ src/app/api/orders/update/route.ts"
mkdir -p src/components
cat > src/components/OrdersManager.tsx <<'EOF_SRC_COMPONENTS_ORDERSMANAGER_TSX'
"use client";

import { useCallback, useEffect, useId, useMemo, useState, type FormEvent } from "react";
import { formatMoney, type Currency } from "@/lib/catalog/money";

type Status = "pendiente" | "confirmado" | "entregado" | "cancelado";
interface Item { name: string; unit: string | null; unitPriceMinor: number; quantity: number; lineTotalMinor: number }
interface Order { id: string; number: number; status: Status; source: "manual" | "agente"; customerName: string; customerPhone: string | null; notes: string | null; deliveryNote: string | null; currency: Currency; totalMinor: number; createdAt: string; items: Item[] }
interface Product { id: string; name: string; unit: string | null; priceMinor: number; stock: number | null; active: boolean }
type Counts = Record<Status, number>;

const STATUS_LABEL: Record<Status, string> = { pendiente: "Por confirmar", confirmado: "Confirmado", entregado: "Entregado", cancelado: "Cancelado" };
const FILTER_LABEL: Record<Status, string> = { pendiente: "Por confirmar", confirmado: "Confirmados", entregado: "Entregados", cancelado: "Cancelados" };
const ORDER: Status[] = ["pendiente", "confirmado", "entregado", "cancelado"];

async function call(url: string, method: string, body?: unknown): Promise<{ ok: boolean; data: Record<string, unknown> }> {
  try {
    const res = await fetch(url, { method, headers: body !== undefined ? { "content-type": "application/json" } : undefined, body: body !== undefined ? JSON.stringify(body) : undefined, cache: "no-store" });
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    return { ok: res.ok, data };
  } catch {
    return { ok: false, data: { message: "No hay conexión con el servidor. Revisa tu internet e intenta de nuevo." } };
  }
}
const msg = (d: Record<string, unknown>, fallback: string) => (typeof d.message === "string" ? d.message : fallback);
const when = (iso: string) => new Intl.DateTimeFormat("es-VE", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit", hour12: true }).format(new Date(iso));

export function OrdersManager() {
  const uid = useId();
  const [filter, setFilter] = useState<Status | null>(null);
  const [orders, setOrders] = useState<Order[] | null>(null);
  const [counts, setCounts] = useState<Counts | null>(null);
  const [more, setMore] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [cancelId, setCancelId] = useState<string | null>(null);
  const [showNew, setShowNew] = useState(false);
  const [catalog, setCatalog] = useState<{ currency: Currency; products: Product[] } | null>(null);

  const load = useCallback(async (f: Status | null, append = false, before?: number) => {
    const qs = new URLSearchParams();
    if (f) qs.set("status", f);
    if (before) qs.set("before", String(before));
    const r = await call(`/api/orders${qs.size ? `?${qs}` : ""}`, "GET");
    if (!r.ok) return setLoadError(true);
    const d = r.data as unknown as { orders: Order[]; counts: Counts; more: boolean };
    setLoadError(false);
    setCounts(d.counts);
    setMore(d.more);
    setOrders((prev) => (append && prev ? [...prev, ...d.orders] : d.orders));
  }, []);

  // Primera carga: se muestra «Por confirmar» si hay algo, y si no «Confirmados».
  useEffect(() => {
    const t = setTimeout(async () => {
      const r = await call("/api/orders?status=pendiente", "GET");
      if (!r.ok) return setLoadError(true);
      const d = r.data as unknown as { orders: Order[]; counts: Counts; more: boolean };
      if (d.counts.pendiente > 0) { setFilter("pendiente"); setOrders(d.orders); setCounts(d.counts); setMore(d.more); }
      else { setFilter("confirmado"); await load("confirmado"); }
    }, 0);
    return () => clearTimeout(t);
  }, [load]);

  useEffect(() => {
    if (!filter) return;
    const t = setInterval(() => { if (document.visibilityState === "visible") void load(filter); }, 15_000);
    return () => clearInterval(t);
  }, [filter, load]);

  async function pick(f: Status) {
    setFilter(f); setOrders(null); setCancelId(null); setError(null);
    await load(f);
  }
  async function act(id: string, action: "confirm" | "deliver" | "cancel") {
    if (busy) return;
    setBusy(true); setError(null);
    const r = await call("/api/orders/update", "POST", { id, action });
    if (!r.ok) setError(msg(r.data, "No se pudo completar la acción."));
    else setCancelId(null);
    await load(filter);
    setBusy(false);
  }
  async function openNew() {
    setShowNew((v) => !v);
    if (!catalog) {
      const r = await call("/api/catalog/config", "GET");
      if (r.ok) setCatalog({ currency: r.data.currency as Currency, products: (r.data.products as Product[]).filter((p) => p.active) });
    }
  }

  if (loadError && !orders) return <p className="alert-error" role="alert">No se pudieron cargar los pedidos. Recarga la página.</p>;
  if (!counts || !filter) return <p className="muted-dark" role="status">Cargando…</p>;

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center gap-3">
        <button type="button" className="btn btn-sm btn-primary" onClick={() => void openNew()}>{showNew ? "Cerrar" : "Nuevo pedido"}</button>
      </div>
      {counts.pendiente > 0 && filter !== "pendiente" && <p className="alert-warn" style={{ maxWidth: 820 }} role="status">Tienes {counts.pendiente} pedido(s) por confirmar.</p>}
      {showNew && (
        <NewOrder uid={uid} catalog={catalog} onCreated={async () => { setShowNew(false); await pick("confirmado"); }} />
      )}
      <div role="group" aria-label="Filtrar pedidos" className="flex flex-wrap gap-2">
        {ORDER.map((s) => (
          <button key={s} type="button" aria-pressed={filter === s} className={`btn btn-sm ${filter === s ? "btn-primary" : "btn-ghost-dark"}`} onClick={() => void pick(s)}>{FILTER_LABEL[s]} · {counts[s]}</button>
        ))}
      </div>
      <div role="alert" aria-live="assertive">{error && <p className="alert-error" style={{ maxWidth: 820 }}>{error}</p>}</div>
      {!orders ? (
        <p className="muted-dark" role="status">Cargando pedidos…</p>
      ) : orders.length === 0 ? (
        <div className="card-light" style={{ maxWidth: 820 }}><p className="muted">No hay pedidos en esta lista.</p></div>
      ) : (
        <ul className="flex flex-col gap-4" style={{ maxWidth: 820 }} aria-label="Pedidos">
          {orders.map((o) => (
            <li key={o.id} className="card-light" style={{ opacity: o.status === "cancelado" ? 0.75 : 1 }}>
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <p className="text-[20px] font-medium">Pedido #{o.number} · {o.customerName}</p>
                  <p className="muted text-[14px]">{o.customerPhone ? `${o.customerPhone} · ` : ""}{when(o.createdAt)}</p>
                </div>
                <div className="flex flex-col items-end gap-1">
                  <span className="rounded-full px-3 py-1 text-[12px] font-medium" style={o.status === "pendiente" ? { background: "var(--color-signal-yellow)", color: "var(--color-ink)" } : { background: "var(--color-pure-white)", color: "var(--color-ink)", border: "1px solid var(--color-field-border)" }}>{STATUS_LABEL[o.status]}</span>
                  {o.source === "agente" && <span className="muted text-[12px]">Pedido por el asistente</span>}
                </div>
              </div>
              <ul className="mt-4 flex flex-col gap-1" aria-label={`Productos del pedido ${o.number}`}>
                {o.items.map((i, k) => (
                  <li key={k} className="flex flex-wrap justify-between gap-2 text-[14px]">
                    <span>{i.quantity} × {i.name}{i.unit ? ` (${i.unit})` : ""}</span>
                    <span>{formatMoney(i.lineTotalMinor, o.currency)}</span>
                  </li>
                ))}
              </ul>
              <p className="mt-3 text-right font-medium">Total {formatMoney(o.totalMinor, o.currency)}</p>
              {o.deliveryNote && <p className="muted mt-2 text-[14px]">Entrega: {o.deliveryNote}</p>}
              {o.notes && <p className="muted mt-1 text-[14px]">Notas: {o.notes}</p>}
              {(o.status === "pendiente" || o.status === "confirmado") && (
                <div className="mt-4 flex flex-wrap items-center gap-2">
                  {o.status === "pendiente" && <button type="button" className="btn btn-sm btn-primary" disabled={busy} onClick={() => void act(o.id, "confirm")}>Confirmar</button>}
                  {o.status === "confirmado" && <button type="button" className="btn btn-sm btn-primary" disabled={busy} onClick={() => void act(o.id, "deliver")}>Marcar entregado</button>}
                  {cancelId === o.id ? (
                    <span className="flex flex-wrap items-center gap-2" role="group" aria-label="Confirmar cancelación">
                      <span className="text-[14px]">¿Cancelar este pedido?{o.status === "confirmado" ? " Se devuelve el stock." : ""}</span>
                      <button type="button" className="btn btn-sm btn-ghost-light" disabled={busy} onClick={() => void act(o.id, "cancel")}>Sí, cancelar</button>
                      <button type="button" className="btn btn-sm btn-text" style={{ color: "var(--color-ink)", textDecoration: "underline" }} onClick={() => setCancelId(null)}>No</button>
                    </span>
                  ) : (
                    <button type="button" className="btn btn-sm btn-text" style={{ color: "var(--color-ink)", textDecoration: "underline" }} disabled={busy} onClick={() => setCancelId(o.id)}>Cancelar pedido</button>
                  )}
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
      {more && orders && orders.length > 0 && (
        <button type="button" className="btn btn-sm btn-ghost-dark" style={{ alignSelf: "flex-start" }} onClick={() => void load(filter, true, orders[orders.length - 1]!.number)}>Cargar más</button>
      )}
    </div>
  );
}

function NewOrder({ uid, catalog, onCreated }: { uid: string; catalog: { currency: Currency; products: Product[] } | null; onCreated: () => Promise<void> }) {
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [lines, setLines] = useState<{ productId: string; quantity: string }[]>([{ productId: "", quantity: "1" }]);
  const [delivery, setDelivery] = useState("");
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const byId = useMemo(() => new Map((catalog?.products ?? []).map((p) => [p.id, p])), [catalog]);
  const total = lines.reduce((s, l) => {
    const p = byId.get(l.productId); const q = Number(l.quantity);
    return p && Number.isInteger(q) && q > 0 ? s + p.priceMinor * q : s;
  }, 0);

  if (!catalog) return <p className="muted-dark" role="status">Cargando productos…</p>;
  if (catalog.products.length === 0) return <section className="card-light" style={{ maxWidth: 820 }}><p className="muted">Primero agrega productos en el <a className="link" href="/catalogo">Catálogo</a>.</p></section>;

  const setLine = (i: number, patch: Partial<{ productId: string; quantity: string }>) => setLines((ls) => ls.map((l, k) => (k === i ? { ...l, ...patch } : l)));

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    const items = lines.filter((l) => l.productId).map((l) => ({ productId: l.productId, quantity: Number(l.quantity) }));
    if (items.length === 0) return setError("Agrega al menos un producto.");
    if (items.some((i) => !Number.isInteger(i.quantity) || i.quantity < 1)) return setError("Las cantidades deben ser números enteros desde 1.");
    setBusy(true); setError(null);
    const r = await call("/api/orders", "POST", { customerName: name, items, ...(phone.trim() ? { customerPhone: phone } : {}), ...(delivery.trim() ? { deliveryNote: delivery } : {}), ...(notes.trim() ? { notes } : {}) });
    if (r.ok) await onCreated();
    else setError(msg(r.data, "No se pudo crear el pedido."));
    setBusy(false);
  }

  return (
    <section className="card-light" style={{ maxWidth: 820 }} aria-label="Nuevo pedido">
      <h2 className="text-[22px]">Nuevo pedido</h2>
      <p className="muted mt-2 text-[14px]">Se crea confirmado y descuenta el stock de los productos que lo controlan.</p>
      <form onSubmit={submit} className="mt-5 flex flex-col gap-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="field"><label htmlFor={`${uid}-cn`}>Nombre del cliente</label><input id={`${uid}-cn`} className="input" value={name} maxLength={120} required onChange={(e) => setName(e.target.value)} /></div>
          <div className="field"><label htmlFor={`${uid}-cp`}>Teléfono (opcional)</label><input id={`${uid}-cp`} className="input" inputMode="tel" value={phone} maxLength={32} onChange={(e) => setPhone(e.target.value)} placeholder="0414-1234567" /></div>
        </div>
        <fieldset className="flex flex-col gap-3">
          <legend className="mb-2 text-[14px] font-medium">Productos</legend>
          {lines.map((l, i) => {
            const p = byId.get(l.productId);
            return (
              <div key={i} className="grid items-end gap-3 sm:grid-cols-[3fr_1fr_auto]">
                <div className="field">
                  <label htmlFor={`${uid}-lp-${i}`}>Producto</label>
                  <select id={`${uid}-lp-${i}`} className="input" value={l.productId} onChange={(e) => setLine(i, { productId: e.target.value })}>
                    <option value="">Elige un producto</option>
                    {catalog.products.map((x) => <option key={x.id} value={x.id} disabled={x.stock === 0}>{x.name} — {formatMoney(x.priceMinor, catalog.currency)}{x.stock === 0 ? " (agotado)" : ""}</option>)}
                  </select>
                </div>
                <div className="field">
                  <label htmlFor={`${uid}-lq-${i}`}>Cantidad</label>
                  <input id={`${uid}-lq-${i}`} className="input" inputMode="numeric" value={l.quantity} onChange={(e) => setLine(i, { quantity: e.target.value })} />
                </div>
                {lines.length > 1 ? <button type="button" className="btn btn-sm btn-ghost-light" onClick={() => setLines((ls) => ls.filter((_, k) => k !== i))}>Quitar</button> : <span />}
                {p && p.stock !== null && <p className="muted text-[12px] sm:col-span-3">Quedan {p.stock} de {p.name}.</p>}
              </div>
            );
          })}
          <button type="button" className="btn btn-sm btn-ghost-light" style={{ alignSelf: "flex-start" }} onClick={() => setLines((ls) => [...ls, { productId: "", quantity: "1" }])} disabled={lines.length >= 50}>Agregar otro producto</button>
        </fieldset>
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="field"><label htmlFor={`${uid}-cd`}>Entrega (opcional)</label><input id={`${uid}-cd`} className="input" value={delivery} maxLength={300} onChange={(e) => setDelivery(e.target.value)} placeholder="Retira en tienda / dirección" /></div>
          <div className="field"><label htmlFor={`${uid}-cx`}>Notas (opcional)</label><input id={`${uid}-cx`} className="input" value={notes} maxLength={1000} onChange={(e) => setNotes(e.target.value)} /></div>
        </div>
        <p className="font-medium" aria-live="polite">Total: {formatMoney(total, catalog.currency)}</p>
        <div role="alert" aria-live="assertive">{error && <p className="alert-error">{error}</p>}</div>
        <button type="submit" className="btn btn-primary btn-sm" style={{ alignSelf: "flex-start" }} disabled={busy}>{busy ? "Guardando…" : "Crear pedido"}</button>
      </form>
    </section>
  );
}
EOF_SRC_COMPONENTS_ORDERSMANAGER_TSX
echo "✔ src/components/OrdersManager.tsx"
mkdir -p src/components
cat > src/components/AppHeader.tsx <<'EOF_SRC_COMPONENTS_APPHEADER_TSX'
import Link from "next/link";
import { brand } from "@/config/brand";
import { LogoutButton } from "./LogoutButton";

export const ROLE_LABEL: Record<string, string> = {
  owner: "Dueño",
  admin: "Administrador",
  agent: "Agente",
};

export function AppHeader({
  email,
  roleLabel,
  showAdmin,
  showTeam,
  showWork = true,
}: {
  email: string;
  roleLabel?: string;
  showAdmin?: boolean;
  showTeam?: boolean;
  /** Enlaces «Hoy» y «Conversaciones». Se ocultan donde no hay negocio (p. ej. administración). */
  showWork?: boolean;
}) {
  return (
    <header className="container-app flex min-h-20 flex-wrap items-center justify-between gap-4 py-4">
      <Link href="/panel" className="text-lg font-medium" style={{ letterSpacing: "-0.01em" }}>
        {brand.name}
      </Link>
      <div className="flex flex-wrap items-center gap-3">
        {showWork && (
          <>
            <Link href="/hoy" className="btn btn-text btn-sm">
              Hoy
            </Link>
            <Link href="/conversaciones" className="btn btn-text btn-sm">
              Conversaciones
            </Link>
            <Link href="/agenda" className="btn btn-text btn-sm">
              Agenda
            </Link>
            <Link href="/catalogo" className="btn btn-text btn-sm">
              Catálogo
            </Link>
            <Link href="/pedidos" className="btn btn-text btn-sm">
              Pedidos
            </Link>
          </>
        )}
        {showAdmin && (
          <Link href="/admin" className="btn btn-text btn-sm">
            Administración
          </Link>
        )}
        {showTeam && (
          // Quien puede gestionar el equipo (dueño y administrador) también gestiona el asistente.
          <>
            <Link href="/agente" className="btn btn-text btn-sm">
              Asistente
            </Link>
            <Link href="/conocimiento" className="btn btn-text btn-sm">
              Conocimiento
            </Link>
            <Link href="/equipo" className="btn btn-text btn-sm">
              Equipo
            </Link>
          </>
        )}
        <Link href="/seguridad" className="btn btn-text btn-sm">
          Seguridad
        </Link>
        <span className="muted-dark text-sm">{email}</span>
        {roleLabel && <span className="badge badge-neutral">{roleLabel}</span>}
        <LogoutButton />
      </div>
    </header>
  );
}
EOF_SRC_COMPONENTS_APPHEADER_TSX
echo "✔ src/components/AppHeader.tsx"
mkdir -p src/app/pedidos
cat > src/app/pedidos/page.tsx <<'EOF_SRC_APP_PEDIDOS_PAGE_TSX'
import type { Metadata } from "next";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { Suspense } from "react";
import { OrdersManager } from "@/components/OrdersManager";
import { AppHeader, ROLE_LABEL } from "@/components/AppHeader";
import { can } from "@/lib/auth/permissions";
import { effectiveTenant, getSessionFromHeaders } from "@/lib/auth/session";

export const metadata: Metadata = { title: "Pedidos" };

export default function OrdersPage() {
  return (
    <Suspense fallback={<div className="container-app py-24 muted-dark" role="status">Cargando…</div>}>
      <OrdersContent />
    </Suspense>
  );
}

async function OrdersContent() {
  const auth = await getSessionFromHeaders(await headers());
  if (!auth) redirect("/entrar");
  const { session } = auth;
  if (session.needsMfaSetup) redirect("/seguridad");
  const ctx = effectiveTenant(session);
  if (!ctx) redirect("/panel");

  return (
    <div className="flex min-h-screen flex-col">
      <AppHeader
        email={session.email}
        roleLabel={ctx.impersonating ? "Soporte" : ROLE_LABEL[ctx.role]}
        showAdmin={session.isSuperAdmin}
        showTeam={can(ctx.role, "team:manage")}
      />
      <main className="container-app flex-1 pb-24 pt-8">
        <p className="eyebrow eyebrow--dark">Tu negocio</p>
        <h1 className="mt-3 text-[32px] sm:text-[48px]">Pedidos</h1>
        <p className="muted-dark mt-3 max-w-[640px]">Los pedidos de tus clientes. Confirmar descuenta el stock; cancelar un pedido confirmado lo devuelve.</p>
        <div className="mt-10">
          <OrdersManager />
        </div>
      </main>
    </div>
  );
}
EOF_SRC_APP_PEDIDOS_PAGE_TSX
echo "✔ src/app/pedidos/page.tsx"
mkdir -p tests
cat > tests/orders.test.ts <<'EOF_TESTS_ORDERS_TEST_TS'
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { POST as signup } from "@/app/api/auth/signup/route";
import { GET as me } from "@/app/api/me/route";
import { POST as teamInvite } from "@/app/api/team/invite/route";
import { POST as inviteSignup } from "@/app/api/invitations/signup/route";
import { GET as getConfig } from "@/app/api/catalog/config/route";
import { PUT as putSettings } from "@/app/api/catalog/settings/route";
import { POST as createProduct } from "@/app/api/catalog/products/route";
import { POST as updateProduct } from "@/app/api/catalog/products/update/route";
import { can } from "@/lib/auth/permissions";
import { GET as listOrders, POST as createOrderApi } from "@/app/api/orders/route";
import { POST as updateOrder } from "@/app/api/orders/update/route";
import { createOrder, mergeLines, type OrderInput } from "@/lib/orders/service";
import { ingestBatch } from "@/lib/whatsapp/ingest";
import { encryptSecret } from "@/lib/crypto";
import { getPool, withTenant } from "@/lib/db";

const RUN = randomUUID().slice(0, 8);
const ORIGIN = new URL(process.env.APP_URL!).origin;
const PASSWORD = "contraseña-de-prueba-123";
const owner = new Pool({ connectionString: process.env.MIGRATION_DATABASE_URL, max: 2 });
const tenantIds: string[] = [];
let seq = 0;

function api(method: string, path: string, cookie?: string, body?: unknown, origin = ORIGIN) {
  return new Request(`${ORIGIN}${path}`, {
    method,
    headers: { origin, ...(body !== undefined ? { "content-type": "application/json" } : {}), ...(cookie ? { cookie } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

async function register(name: string) {
  const email = `od-${RUN}-${name}@example.test`;
  const res = await signup(api("POST", "/api/auth/signup", undefined, { email, password: PASSWORD, businessName: `Negocio ${name}` }));
  expect(res.status).toBe(201);
  const cookie = (res.headers.get("set-cookie") ?? "").split(";")[0]!;
  const info = await (await me(api("GET", "/api/me", cookie))).json();
  tenantIds.push(info.tenant.id);
  const phoneId = `8${RUN.replace(/\D/g, "").padEnd(4, "7").slice(0, 4)}${Date.now() % 100000}${seq++}`.slice(0, 18);
  const { payload, keyVersion } = encryptSecret("EAAtoken-de-prueba-del-negocio-1234567890", `wa:${info.tenant.id}:${phoneId}`);
  await owner.query("INSERT INTO tenant_integrations (tenant_id, provider, external_id, secret_enc, key_version) VALUES ($1,'whatsapp',$2,$3,$4)", [info.tenant.id, phoneId, payload, keyVersion]);
  return { tenantId: info.tenant.id as string, cookie, phoneId };
}
type T = Awaited<ReturnType<typeof register>>;

type Handler = (req: Request) => Promise<Response>;
const send = (h: Handler, path: string, t: T | null, body: unknown, method = "POST", origin = ORIGIN) => h(api(method, path, t?.cookie, body, origin));
const create = (t: T, body: Record<string, unknown>) => send(createProduct, "/api/catalog/products", t, { priceMinor: 1000, ...body });
const update = (t: T, body: Record<string, unknown>) => send(updateProduct, "/api/catalog/products/update", t, body);
const config = async (t: T) => (await getConfig(api("GET", "/api/catalog/config", t.cookie))).json() as Promise<{ currency: string; canManage: boolean; products: { id: string; name: string; description: string | null; unit: string | null; priceMinor: number; stock: number | null; active: boolean }[] }>;
const idOf = async (res: Response) => (await res.json()).id as string;

/** Invita a alguien con ese rol, acepta la invitación y devuelve su sesión dentro del negocio. */
async function member(t: T, role: "admin" | "agent"): Promise<T> {
  const inv = await teamInvite(api("POST", "/api/team/invite", t.cookie, { email: `od-${RUN}-${role}-${randomUUID().slice(0, 6)}@example.test`, role }));
  expect(inv.status).toBe(201);
  const token = ((await inv.json()).inviteUrl as string).split("/").pop()!;
  const ok = await inviteSignup(api("POST", "/api/invitations/signup", undefined, { token, password: PASSWORD }));
  expect(ok.status).toBe(201);
  return { tenantId: t.tenantId, cookie: (ok.headers.get("set-cookie") ?? "").split(";")[0]!, phoneId: t.phoneId };
}

beforeAll(async () => { await getPool().query("SELECT 1"); });
afterAll(async () => {
  await owner.query("DELETE FROM users WHERE email LIKE $1", [`od-${RUN}-%`]);
  for (const id of tenantIds) {
    const c = await owner.connect();
    try {
      await c.query("BEGIN");
      await c.query("SELECT set_config('app.tenant_id', $1, true)", [id]);
      await c.query("ALTER TABLE audit_log DISABLE TRIGGER audit_log_sin_cambios");
      await c.query("DELETE FROM audit_log WHERE tenant_id = $1", [id]);
      await c.query("ALTER TABLE audit_log ENABLE TRIGGER audit_log_sin_cambios");
      const del = await c.query("DELETE FROM tenants WHERE id = $1", [id]);
      if (del.rowCount !== 1) throw new Error("La limpieza no borró el negocio de prueba " + id);
      await c.query("COMMIT");
    } catch (e) {
      await c.query("ROLLBACK");
      throw e;
    } finally {
      c.release();
    }
  }
  await owner.end();
  await getPool().end();
});


type Order = { id: string; number: number; status: string; source: string; customerName: string; customerPhone: string | null; notes: string | null; deliveryNote: string | null; currency: string; totalMinor: number; conversationId: string | null; items: { name: string; unit: string | null; unitPriceMinor: number; quantity: number; lineTotalMinor: number }[] };
type Listing = { counts: Record<string, number>; more: boolean; orders: Order[] };
const list = async (t: T, qs = "") => (await listOrders(api("GET", `/api/orders${qs}`, t.cookie))).json() as Promise<Listing>;
const place = (t: T, body: Record<string, unknown>) => send(createOrderApi, "/api/orders", t, { customerName: "María Pérez", ...body });
const act = (t: T, id: string, action: string) => send(updateOrder, "/api/orders/update", t, { id, action });
const stockOf = async (t: T, id: string) => (await config(t)).products.find((p) => p.id === id)!.stock;

/** Un negocio con productos: Harina $10,50 (stock 5), Aceite $5 (sin control de stock), Sal $1 (stock 0). */
async function shop(name: string) {
  const t = await register(name);
  const mk = async (n: string, priceMinor: number, stock: number | null, unit?: string) => idOf(await create(t, { name: n, priceMinor, stock, ...(unit ? { unit } : {}) }));
  const harina = await mk("Harina", 1050, 5, "paquete 1 kg");
  const aceite = await mk("Aceite", 500, null);
  const sal = await mk("Sal", 100, 0);
  return { t, harina, aceite, sal };
}
const rawOrder = (tenantId: string, over: Partial<OrderInput> & { items: OrderInput["items"] }): OrderInput => ({ tenantId, source: "agente", status: "pendiente", customerName: "Cliente", ...over });
const inTx = <T2,>(tenantId: string, fn: (db: Parameters<Parameters<typeof withTenant>[1]>[0]) => Promise<T2>) => withTenant(tenantId, fn);
const dbErr = async (tenantId: string, sql: string, args: unknown[] = []) =>
  inTx(tenantId, async (db) => { try { await db.query("SAVEPOINT s"); await db.query(sql, args); return null; } catch (e) { return (e as { code?: string }).code ?? "?"; } });

describe("crear pedidos", () => {
  it("calcula el total en el servidor con los precios del catálogo y guarda una copia de cada línea", async () => {
    const { t, harina, aceite } = await shop("crea");
    const res = await place(t, { customerPhone: "0414-1234567", notes: "sin prisa", deliveryNote: "Retira en tienda", items: [{ productId: harina, quantity: 2 }, { productId: aceite, quantity: 3 }] });
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ ok: true, number: 1, totalMinor: 2 * 1050 + 3 * 500 });
    const { orders, counts } = await list(t);
    expect(counts).toEqual({ pendiente: 0, confirmado: 1, entregado: 0, cancelado: 0 });
    expect(orders[0]).toMatchObject({ number: 1, status: "confirmado", source: "manual", customerName: "María Pérez", customerPhone: "0414-1234567", notes: "sin prisa", deliveryNote: "Retira en tienda", currency: "USD", totalMinor: 3600 });
    expect(orders[0]!.items.map((i) => i.name)).toEqual(["Harina", "Aceite"]); // el orden en que se pidieron
    const byName = Object.fromEntries(orders[0]!.items.map((i) => [i.name, i]));
    expect(byName.Harina).toEqual({ name: "Harina", unit: "paquete 1 kg", unitPriceMinor: 1050, quantity: 2, lineTotalMinor: 2100 });
    expect(byName.Aceite).toEqual({ name: "Aceite", unit: null, unitPriceMinor: 500, quantity: 3, lineTotalMinor: 1500 });
  });

  it("ignora precios o totales que mande el cliente", async () => {
    const { t, harina } = await shop("precio");
    const res = await place(t, { totalMinor: 1, priceMinor: 1, items: [{ productId: harina, quantity: 1, unitPriceMinor: 1, priceMinor: 1, name: "Gratis" }] });
    expect(res.status).toBe(201);
    const o = (await list(t)).orders[0]!;
    expect(o.totalMinor).toBe(1050);
    expect(o.items[0]).toMatchObject({ name: "Harina", unitPriceMinor: 1050 });
  });

  it("junta líneas repetidas del mismo producto", async () => {
    const { t, harina } = await shop("junta");
    await place(t, { items: [{ productId: harina, quantity: 2 }, { productId: harina, quantity: 3 }] });
    const o = (await list(t)).orders[0]!;
    expect(o.items).toHaveLength(1);
    expect(o.items[0]).toMatchObject({ quantity: 5, lineTotalMinor: 5250 });
    expect(mergeLines([{ productId: "b", quantity: 1 }, { productId: "a", quantity: 1 }, { productId: "b", quantity: 2 }])).toEqual([{ productId: "b", quantity: 3 }, { productId: "a", quantity: 1 }]);
  });

  it("numera 1, 2, 3… por negocio, sin repetir ni dejar huecos ni siquiera con pedidos simultáneos", async () => {
    const a = await shop("numA");
    const b = await shop("numB");
    const rs = await Promise.all(Array.from({ length: 8 }, () => place(a.t, { items: [{ productId: a.aceite, quantity: 1 }] })));
    expect(rs.map((r) => r.status)).toEqual(Array(8).fill(201));
    const nums = (await list(a.t)).orders.map((o) => o.number).sort((x, y) => x - y);
    expect(nums).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    await place(b.t, { items: [{ productId: b.aceite, quantity: 1 }] });
    expect((await list(b.t)).orders[0]!.number).toBe(1);
  });

  it("al crear confirmado se descuenta el stock de los productos que lo controlan, y solo de esos", async () => {
    const { t, harina, aceite } = await shop("stock");
    await place(t, { items: [{ productId: harina, quantity: 2 }, { productId: aceite, quantity: 4 }] });
    expect(await stockOf(t, harina)).toBe(3);
    expect(await stockOf(t, aceite)).toBeNull();
  });

  it("sin stock suficiente: 409, no se crea nada, no se toca el stock de otras líneas y no se gasta el número", async () => {
    const { t, harina, aceite, sal } = await shop("sinstock");
    const r = await place(t, { items: [{ productId: aceite, quantity: 1 }, { productId: harina, quantity: 6 }, { productId: sal, quantity: 1 }] });
    expect(r.status).toBe(409);
    const j = await r.json();
    expect(j.error).toBe("sin_stock");
    expect(j.message).toContain("Harina");
    expect(j.message).toContain("Sal");
    expect((await list(t)).orders).toHaveLength(0);
    expect(await stockOf(t, harina)).toBe(5);
    expect((await place(t, { items: [{ productId: aceite, quantity: 1 }] })).status).toBe(201);
    expect((await list(t)).orders[0]!.number).toBe(1);
  });

  it("el límite exacto de stock se puede vender entero y luego ya no", async () => {
    const { t, harina } = await shop("limite");
    expect((await place(t, { items: [{ productId: harina, quantity: 5 }] })).status).toBe(201);
    expect(await stockOf(t, harina)).toBe(0);
    expect((await place(t, { items: [{ productId: harina, quantity: 1 }] })).status).toBe(409);
  });

  it("dos pedidos simultáneos por la última unidad: solo uno entra y el stock nunca baja de cero", async () => {
    const { t, harina } = await shop("carrera");
    await update(t, { id: harina, stock: 1 });
    const rs = await Promise.all(Array.from({ length: 6 }, () => place(t, { items: [{ productId: harina, quantity: 1 }] })));
    expect(rs.filter((r) => r.status === 201)).toHaveLength(1);
    expect(rs.filter((r) => r.status === 409)).toHaveLength(5);
    expect(await stockOf(t, harina)).toBe(0);
    expect((await list(t)).orders).toHaveLength(1);
  });

  it("productos desactivados, inexistentes o de otro negocio dan 404", async () => {
    const a = await shop("prodA");
    const b = await shop("prodB");
    await update(a.t, { id: a.aceite, active: false });
    for (const productId of [a.aceite, randomUUID(), b.harina]) {
      const r = await place(a.t, { items: [{ productId, quantity: 1 }] });
      expect(r.status).toBe(404);
      expect((await r.json()).error).toBe("producto_no_disponible");
    }
    expect((await list(a.t)).orders).toHaveLength(0);
    expect(await stockOf(b.t, b.harina)).toBe(5);
  });

  it("rechaza datos inválidos con 400 y no guarda nada", async () => {
    const { t, harina } = await shop("invalidos");
    const ok = [{ productId: harina, quantity: 1 }];
    const bads: Record<string, unknown>[] = [
      { items: [] }, { items: undefined }, { items: Array.from({ length: 51 }, () => ({ productId: harina, quantity: 1 })) },
      { items: [{ productId: harina, quantity: 0 }] }, { items: [{ productId: harina, quantity: -1 }] }, { items: [{ productId: harina, quantity: 1.5 }] },
      { items: [{ productId: harina, quantity: "2" }] }, { items: [{ productId: harina, quantity: 10000 }] }, { items: [{ productId: "no-uuid", quantity: 1 }] },
      { items: ok, customerName: "" }, { items: ok, customerName: "x".repeat(121) }, { items: ok, customerPhone: "abc" }, { items: ok, notes: "x".repeat(1001) },
      { items: ok, deliveryNote: "x".repeat(301) }, { items: ok, conversationId: "no-uuid" },
    ];
    for (const b of bads) expect((await place(t, b)).status, JSON.stringify(b).slice(0, 80)).toBe(400);
    expect((await list(t)).orders).toHaveLength(0);
    expect(await stockOf(t, harina)).toBe(5);
    const big = await place(t, { items: [{ productId: harina, quantity: 10000 }] });
    expect((await big.json()).error).toBe("datos_invalidos"); // lo frena la validación de la API, no solo el servicio
  });

  it("líneas repetidas que juntas pasan de 9999 unidades, o un total gigante, se rechazan con 400", async () => {
    const { t, aceite } = await shop("enorme");
    const r1 = await place(t, { items: [{ productId: aceite, quantity: 6000 }, { productId: aceite, quantity: 6000 }] });
    expect(r1.status).toBe(400);
    expect((await r1.json()).error).toBe("cantidad_excedida");
    await update(t, { id: aceite, priceMinor: 10_000_000_000 });
    const r2 = await place(t, { items: [{ productId: aceite, quantity: 200 }] });
    expect(r2.status).toBe(400);
    expect((await r2.json()).error).toBe("total_excedido");
    expect((await place(t, { items: [{ productId: aceite, quantity: 100 }] })).status).toBe(201);
    expect((await list(t)).orders).toHaveLength(1);
  });

  it("cambiar el catálogo después no altera pedidos viejos (nombre, precio, moneda)", async () => {
    const { t, harina } = await shop("copia");
    await place(t, { items: [{ productId: harina, quantity: 2 }] });
    await update(t, { id: harina, name: "Harina PAN", priceMinor: 9999 });
    await send(putSettings, "/api/catalog/settings", t, { currency: "VES" }, "PUT");
    await update(t, { id: harina, active: false });
    const o = (await list(t)).orders[0]!;
    expect(o.currency).toBe("USD");
    expect(o.totalMinor).toBe(2100);
    expect(o.items[0]).toMatchObject({ name: "Harina", unitPriceMinor: 1050 });
    const nuevo = await idOf(await create(t, { name: "Nuevo", priceMinor: 100 }));
    await place(t, { items: [{ productId: nuevo, quantity: 1 }] });
    expect((await list(t)).orders[0]!.currency).toBe("VES");
  });

  it("puede enlazarse a una conversación del mismo negocio; una ajena o inexistente da 404", async () => {
    const a = await shop("convA");
    const b = await shop("convB");
    const conv = async (t: T) => inTx(t.tenantId, async (db) => {
      const c = (await db.query("INSERT INTO contacts (tenant_id, wa_id) VALUES ($1, $2) RETURNING id", [t.tenantId, `58412${Date.now() % 10000000}${seq++}`])).rows[0].id as string;
      return (await db.query("INSERT INTO conversations (tenant_id, contact_id) VALUES ($1, $2) RETURNING id", [t.tenantId, c])).rows[0].id as string;
    });
    const ca = await conv(a.t);
    const cb = await conv(b.t);
    expect((await place(a.t, { conversationId: ca, items: [{ productId: a.aceite, quantity: 1 }] })).status).toBe(201);
    expect((await list(a.t)).orders[0]!.conversationId).toBe(ca);
    expect((await place(a.t, { conversationId: cb, items: [{ productId: a.aceite, quantity: 1 }] })).status).toBe(404);
    expect((await place(a.t, { conversationId: randomUUID(), items: [{ productId: a.aceite, quantity: 1 }] })).status).toBe(404);
  });
});

describe("estados y stock", () => {
  /** Pedido del asistente (pendiente, sin descontar stock) con su tarea «Confirmar pedido». */
  async function pending(t: T, items: { productId: string; quantity: number }[]) {
    return inTx(t.tenantId, async (db) => {
      const r = await createOrder(db, rawOrder(t.tenantId, { items }));
      if (r.kind !== "ok") throw new Error("no se creó " + r.kind);
      await db.query("INSERT INTO work_items (tenant_id, type, title, source, dedupe_key) VALUES ($1, 'pedido', 'Confirmar pedido', 'agente', $2)", [t.tenantId, `pedido:${r.id}`]);
      return r.id;
    });
  }
  const task = (t: T, id: string) => inTx(t.tenantId, async (db) => (await db.query("SELECT status, resolved_at FROM work_items WHERE dedupe_key = $1", [`pedido:${id}`])).rows[0] as { status: string; resolved_at: Date | null });
  const status = async (t: T, id: string) => (await list(t)).orders.find((o) => o.id === id)!.status;

  it("un pedido del asistente nace pendiente y no descuenta stock", async () => {
    const { t, harina } = await shop("pend");
    const id = await pending(t, [{ productId: harina, quantity: 2 }]);
    expect(await status(t, id)).toBe("pendiente");
    expect(await stockOf(t, harina)).toBe(5);
  });

  it("confirmar descuenta el stock, fija la fecha y cierra la tarea como resuelta", async () => {
    const { t, harina, aceite } = await shop("conf");
    const id = await pending(t, [{ productId: harina, quantity: 2 }, { productId: aceite, quantity: 1 }]);
    expect((await act(t, id, "confirm")).status).toBe(200);
    expect(await status(t, id)).toBe("confirmado");
    expect(await stockOf(t, harina)).toBe(3);
    expect(await stockOf(t, aceite)).toBeNull();
    expect((await task(t, id)).status).toBe("resuelto");
    expect((await task(t, id)).resolved_at).not.toBeNull();
  });

  it("confirmar sin stock suficiente: 409, sigue pendiente y no cambia nada; con stock repuesto sí se puede", async () => {
    const { t, harina } = await shop("conf-sin");
    const id = await pending(t, [{ productId: harina, quantity: 4 }]);
    await update(t, { id: harina, stock: 3 });
    const r = await act(t, id, "confirm");
    expect(r.status).toBe(409);
    expect((await r.json()).error).toBe("sin_stock");
    expect(await status(t, id)).toBe("pendiente");
    expect(await stockOf(t, harina)).toBe(3);
    expect((await task(t, id)).status).toBe("abierto");
    await update(t, { id: harina, stock: 4 });
    expect((await act(t, id, "confirm")).status).toBe(200);
    expect(await stockOf(t, harina)).toBe(0);
  });

  it("confirmar dos veces (incluso a la vez) descuenta una sola vez", async () => {
    const { t, harina } = await shop("doble");
    const id = await pending(t, [{ productId: harina, quantity: 2 }]);
    const rs = await Promise.all([act(t, id, "confirm"), act(t, id, "confirm"), act(t, id, "confirm")]);
    expect(rs.filter((r) => r.status === 200)).toHaveLength(1);
    expect(rs.filter((r) => r.status === 409)).toHaveLength(2);
    expect(await stockOf(t, harina)).toBe(3);
  });

  it("dos pedidos pendientes por la última unidad: al confirmar los dos a la vez solo uno entra", async () => {
    const { t, harina } = await shop("ultima");
    await update(t, { id: harina, stock: 1 });
    const a = await pending(t, [{ productId: harina, quantity: 1 }]);
    const b = await pending(t, [{ productId: harina, quantity: 1 }]);
    const rs = await Promise.all([act(t, a, "confirm"), act(t, b, "confirm")]);
    expect(rs.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(await stockOf(t, harina)).toBe(0);
  });

  it("entregar solo desde confirmado; entregado y cancelado son finales", async () => {
    const { t, harina } = await shop("final");
    const id = await pending(t, [{ productId: harina, quantity: 1 }]);
    expect((await act(t, id, "deliver")).status).toBe(409);
    await act(t, id, "confirm");
    expect((await act(t, id, "deliver")).status).toBe(200);
    expect(await status(t, id)).toBe("entregado");
    for (const a of ["confirm", "deliver", "cancel"]) expect((await act(t, id, a)).status, a).toBe(409);
    expect(await stockOf(t, harina)).toBe(4);
  });

  it("cancelar un pedido confirmado devuelve exactamente el stock descontado; cancelar uno pendiente no toca el stock", async () => {
    const { t, harina } = await shop("cancel");
    const conf = await pending(t, [{ productId: harina, quantity: 3 }]);
    await act(t, conf, "confirm");
    expect(await stockOf(t, harina)).toBe(2);
    expect((await act(t, conf, "cancel")).status).toBe(200);
    expect(await stockOf(t, harina)).toBe(5);
    expect((await task(t, conf)).status).toBe("resuelto"); // ya estaba resuelta al confirmar
    const pend = await pending(t, [{ productId: harina, quantity: 2 }]);
    expect((await act(t, pend, "cancel")).status).toBe(200);
    expect(await stockOf(t, harina)).toBe(5);
    expect(await inTx(t.tenantId, async (db) => (await db.query("SELECT count(*)::int AS n FROM order_items WHERE order_id = $1 AND stock_taken", [conf])).rows[0].n)).toBe(0);
    expect((await task(t, pend)).status).toBe("descartado");
    expect(await status(t, pend)).toBe("cancelado");
  });

  it("cancelar dos veces no devuelve el stock dos veces", async () => {
    const { t, harina } = await shop("cancel2");
    const r = await place(t, { items: [{ productId: harina, quantity: 2 }] });
    const id = (await r.json()).id as string;
    const rs = await Promise.all([act(t, id, "cancel"), act(t, id, "cancel")]);
    expect(rs.map((x) => x.status).sort()).toEqual([200, 409]);
    expect(await stockOf(t, harina)).toBe(5);
  });

  it("al cancelar, un producto que ya no controla stock sigue sin controlarlo, y el stock nunca pasa del máximo", async () => {
    const { t, harina, aceite } = await shop("cancel3");
    await update(t, { id: aceite, stock: 10 });
    const id = (await (await place(t, { items: [{ productId: harina, quantity: 2 }, { productId: aceite, quantity: 4 }] })).json()).id as string;
    await update(t, { id: harina, stock: null });
    await update(t, { id: aceite, stock: 999_999 });
    expect((await act(t, id, "cancel")).status).toBe(200);
    expect(await stockOf(t, harina)).toBeNull();
    expect(await stockOf(t, aceite)).toBe(1_000_000);
  });

  it("pedidos y acciones inexistentes", async () => {
    const { t } = await shop("noexiste");
    expect((await act(t, randomUUID(), "confirm")).status).toBe(404);
    expect((await act(t, randomUUID(), "borrar")).status).toBe(400);
    expect((await send(updateOrder, "/api/orders/update", t, { id: "x", action: "confirm" })).status).toBe(400);
  });

  it("un pedido de otro negocio no se puede tocar", async () => {
    const a = await shop("tocaA");
    const b = await shop("tocaB");
    const id = await pending(a.t, [{ productId: a.harina, quantity: 1 }]);
    expect((await act(b.t, id, "confirm")).status).toBe(404);
    expect((await act(b.t, id, "cancel")).status).toBe(404);
    expect(await status(a.t, id)).toBe("pendiente");
  });
});

describe("lista de pedidos", () => {
  it("filtra por estado, cuenta por estado y ordena del más nuevo al más viejo", async () => {
    const { t, aceite } = await shop("lista");
    const ids: string[] = [];
    for (let i = 0; i < 4; i++) ids.push((await (await place(t, { customerName: `C${i}`, items: [{ productId: aceite, quantity: 1 }] })).json()).id);
    await act(t, ids[0]!, "deliver");
    await act(t, ids[1]!, "cancel");
    const all = await list(t);
    expect(all.orders.map((o) => o.number)).toEqual([4, 3, 2, 1]);
    expect(all.counts).toEqual({ pendiente: 0, confirmado: 2, entregado: 1, cancelado: 1 });
    expect((await list(t, "?status=confirmado")).orders.map((o) => o.number)).toEqual([4, 3]);
    expect((await list(t, "?status=cancelado")).orders.map((o) => o.number)).toEqual([2]);
    expect((await list(t, "?status=pendiente")).orders).toEqual([]);
  });

  it("filtros inválidos dan 400", async () => {
    const { t } = await shop("filtro");
    for (const qs of ["?status=raro", "?before=abc", "?before=-1", "?before=0"]) expect((await listOrders(api("GET", `/api/orders${qs}`, t.cookie))).status, qs).toBe(400);
  });

  it("pagina de 100 en 100 con «before»", async () => {
    const { t, aceite } = await shop("pagina");
    await inTx(t.tenantId, async (db) => { for (let i = 0; i < 103; i++) await createOrder(db, rawOrder(t.tenantId, { status: "confirmado", source: "manual", items: [{ productId: aceite, quantity: 1 }] })); });
    const p1 = await list(t);
    expect(p1.orders).toHaveLength(100);
    expect(p1.more).toBe(true);
    expect(p1.orders[0]!.number).toBe(103);
    const p2 = await list(t, `?before=${p1.orders.at(-1)!.number}`);
    expect(p2.orders.map((o) => o.number)).toEqual([3, 2, 1]);
    expect(p2.more).toBe(false);
  });

  it("cada negocio ve solo sus pedidos", async () => {
    const a = await shop("veA");
    const b = await shop("veB");
    await place(a.t, { customerName: "Solo de A", items: [{ productId: a.aceite, quantity: 1 }] });
    expect((await list(b.t)).orders).toEqual([]);
    expect((await list(b.t)).counts.confirmado).toBe(0);
    const seen = await inTx(b.t.tenantId, async (db) => (await db.query("SELECT (SELECT count(*) FROM orders WHERE tenant_id = $1) AS o, (SELECT count(*) FROM order_items WHERE tenant_id = $1) AS i", [a.t.tenantId])).rows[0]);
    expect(seen).toEqual({ o: "0", i: "0" });
  });
});

describe("seguridad", () => {
  it("sin sesión: 401; desde otro sitio: 403; no cambia nada", async () => {
    const { t, harina } = await shop("seg");
    expect((await listOrders(api("GET", "/api/orders"))).status).toBe(401);
    expect((await send(createOrderApi, "/api/orders", null, { customerName: "A", items: [{ productId: harina, quantity: 1 }] })).status).toBe(401);
    expect((await send(updateOrder, "/api/orders/update", null, { id: randomUUID(), action: "cancel" })).status).toBe(401);
    const evil = "https://evil.example";
    expect((await send(createOrderApi, "/api/orders", t, { customerName: "A", items: [{ productId: harina, quantity: 1 }] }, "POST", evil)).status).toBe(403);
    const id = (await (await place(t, { items: [{ productId: harina, quantity: 1 }] })).json()).id as string;
    expect((await send(updateOrder, "/api/orders/update", t, { id, action: "cancel" }, "POST", evil)).status).toBe(403);
    expect((await list(t)).orders[0]!.status).toBe("confirmado");
    expect(await stockOf(t, harina)).toBe(4);
  });

  it("los agentes también pueden tomar y gestionar pedidos", async () => {
    const { t, harina } = await shop("rol");
    for (const r of ["owner", "admin", "agent"] as const) { expect(can(r, "orders:read")).toBe(true); expect(can(r, "orders:write")).toBe(true); }
    expect(can(null, "orders:read")).toBe(false);
    const ag = await member(t, "agent");
    const r = await place(ag, { items: [{ productId: harina, quantity: 1 }] });
    expect(r.status).toBe(201);
    const id = (await r.json()).id as string;
    expect((await act(ag, id, "deliver")).status).toBe(200);
    expect((await list(ag)).orders).toHaveLength(1);
  });
});

describe("base de datos", () => {
  it("un pedido sin líneas, o con un total que no es la suma de sus líneas, no se guarda", async () => {
    const { t, aceite } = await shop("db1");
    const tx = (total: number, withItem: boolean) => inTx(t.tenantId, async (db) => {
      const o = await db.query("INSERT INTO orders (tenant_id, number, customer_name, source, currency, total_minor) VALUES ($1, 99, 'X', 'manual', 'USD', $2) RETURNING id", [t.tenantId, total]);
      if (withItem) await db.query("INSERT INTO order_items (tenant_id, order_id, product_id, position, name, unit_price_minor, quantity, line_total_minor) VALUES ($1, $2, $3, 1, 'Aceite', 500, 2, 1000)", [t.tenantId, o.rows[0].id, aceite]);
    }).then(() => null, (e: { code?: string }) => e.code);
    expect(await tx(1000, false)).toBe("23514");
    expect(await tx(999, true)).toBe("23514");
    expect(await tx(1000, true)).toBeNull();
  });

  it("número, total, moneda y origen de un pedido no cambian; las líneas tampoco; los estados finales no se reabren", async () => {
    const { t, aceite } = await shop("db2");
    const id = (await (await place(t, { items: [{ productId: aceite, quantity: 2 }] })).json()).id as string;
    for (const sql of ["UPDATE orders SET total_minor = 1 WHERE id = $1", "UPDATE orders SET number = 50 WHERE id = $1", "UPDATE orders SET currency = 'VES' WHERE id = $1", "UPDATE orders SET source = 'agente' WHERE id = $1",
      "UPDATE order_items SET unit_price_minor = 1, line_total_minor = 2 WHERE order_id = $1", "UPDATE order_items SET quantity = 3, line_total_minor = 1500 WHERE order_id = $1", "UPDATE order_items SET name = 'Otro' WHERE order_id = $1"]) {
      expect(await dbErr(t.tenantId, sql, [id]), sql).toBe("23514");
    }
    expect(await dbErr(t.tenantId, "UPDATE order_items SET stock_taken = NOT stock_taken WHERE order_id = $1", [id])).toBeNull();
    await act(t, id, "cancel");
    expect(await dbErr(t.tenantId, "UPDATE orders SET status = 'confirmado', cancelled_at = NULL, confirmed_at = now() WHERE id = $1", [id])).toBe("23514");
  });

  it("la base también protege cantidades, líneas mal sumadas, fechas incoherentes y estados raros", async () => {
    const { t, aceite } = await shop("db3");
    const id = (await (await place(t, { items: [{ productId: aceite, quantity: 1 }] })).json()).id as string;
    const item = (sql: string) => dbErr(t.tenantId, `INSERT INTO order_items (tenant_id, order_id, product_id, position, name, unit_price_minor, quantity, line_total_minor) VALUES ($1, $2, $3, ${sql})`, [t.tenantId, id, aceite]);
    expect(await item("2, 'A', 500, 0, 0")).toBe("23514");
    expect(await item("2, 'A', 500, 10000, 5000000")).toBe("23514");
    expect(await item("2, 'A', 500, 2, 999")).toBe("23514");
    expect(await dbErr(t.tenantId, "UPDATE orders SET status = 'raro' WHERE id = $1", [id])).toBe("23514");
    expect(await dbErr(t.tenantId, "UPDATE orders SET status = 'cancelado' WHERE id = $1", [id])).toBe("23514"); // cancelado sin fecha
    expect(await dbErr(t.tenantId, "UPDATE orders SET status = 'entregado' WHERE id = $1", [id])).toBe("23514"); // entregado sin fecha
  });

  it("un negocio no puede escribir pedidos a nombre de otro", async () => {
    const a = await shop("dbA");
    const b = await shop("dbB");
    expect(await dbErr(a.t.tenantId, "INSERT INTO orders (tenant_id, number, customer_name, source, currency, total_minor) VALUES ($1, 1, 'X', 'manual', 'USD', 0)", [b.t.tenantId])).toBe("42501");
    expect(await dbErr(a.t.tenantId, "INSERT INTO order_counters (tenant_id, last_number) VALUES ($1, 5)", [b.t.tenantId])).toBe("42501");
  });

  it("el mismo mensaje del cliente no genera dos pedidos ni descuenta dos veces", async () => {
    const { t, harina } = await shop("idem");
    const m = (await ingestBatch({ phoneNumberId: t.phoneId, statuses: [], messages: [{ waId: `58414${Date.now() % 10000000}1`, name: "Ana", waMessageId: `wamid.od.${RUN}.${seq++}`, at: new Date(), type: "text", body: "quiero harina" }] })).inbound[0]!.messageId;
    const first = await inTx(t.tenantId, (db) => createOrder(db, rawOrder(t.tenantId, { requestMessageId: m, items: [{ productId: harina, quantity: 2 }] })));
    expect(first.kind).toBe("ok");
    const again = await inTx(t.tenantId, (db) => createOrder(db, rawOrder(t.tenantId, { requestMessageId: m, items: [{ productId: harina, quantity: 4 }] })));
    expect(again.kind).toBe("repetido");
    expect(again.kind === "repetido" && again.id).toBe(first.kind === "ok" && first.id);
    expect((await list(t)).orders).toHaveLength(1);
    expect((await list(t)).orders[0]!.totalMinor).toBe(2100);
    expect(await dbErr(t.tenantId, "INSERT INTO orders (tenant_id, number, customer_name, source, currency, total_minor, request_message_id) VALUES ($1, 77, 'X', 'manual', 'USD', 0, $2)", [t.tenantId, m])).toBe("23514");
  });
});
EOF_TESTS_ORDERS_TEST_TS
echo "✔ tests/orders.test.ts"

cat <<'FIN'

══════════════════════════════════════════════════════════
 Paso 14B aplicado. Ahora, en este orden:

   1) Abre Docker Desktop y:   npm run db:up
   2) npm run db:migrate       # aplica 0016 (pedidos)
   3) npm run typecheck && npm run lint && npm test
   4) npm run dev:all          # reinícialo
   5) Prueba (necesitas productos en «Catálogo», con algún stock):
        - «Pedidos» → «Nuevo pedido»: elige productos y cantidades; el total se calcula solo.
        - Pide más unidades que el stock: te avisa y no crea nada.
        - Marca un pedido «entregado» y cancela otro: al cancelar uno confirmado, el stock vuelve.
        - Entregado y cancelado son estados finales.

   Notas:
   - Los pedidos hechos por una persona nacen CONFIRMADOS (descuentan stock). Los que pedirá
     el asistente (Paso 14C) nacerán «Por confirmar»: no descuentan stock hasta que los confirmes.
   - Cada pedido guarda una copia del nombre y precio; cambiar el catálogo no altera pedidos viejos.
   - El asistente todavía no toma pedidos: llega en el Paso 14C.
══════════════════════════════════════════════════════════
FIN