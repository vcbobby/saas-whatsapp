import type { PoolClient } from "pg";
import { CURRENCY_INFO, formatMoney, isCurrency, type Currency } from "@/lib/catalog/money";
import { createOrder } from "@/lib/orders/service";
import { cleanCustomerName, cleanLabel } from "./booking";
import { normalizeUntrusted } from "./safety";
import { treatmentOf, type AgentStyle } from "./style";

type Db = Pick<PoolClient, "query">;

/**
 * Pedidos tomados por el asistente (Paso 14C). Mismo diseño cerrado que las citas:
 *  1. El servidor muestra un catálogo con códigos (P1, P2…), precios y disponibilidad reales.
 *  2. Para pedir, el modelo escribe una línea: [[PEDIDO:P1x2,P3x1|Nombre|Entrega]]. No escribe nada más en la base de datos.
 *  3. El servidor comprueba los códigos, vuelve a leer precios y stock, calcula el total y crea el pedido «pendiente».
 *  4. El mensaje al cliente (con el total) lo escribe el servidor. Una persona confirma desde «Pedidos».
 */

export const ORDER_RULES_LINES: readonly string[] = [
  "E. Ofrece solo los productos y precios de la lista del CATÁLOGO. Nunca inventes productos, precios, descuentos, promociones ni disponibilidad.",
  "F. Para tomar un pedido necesitas los productos y cantidades de la lista y el nombre del cliente. Repite al cliente lo que va a pedir y, cuando lo acepte con claridad, responde SOLO con esta línea, sin más texto: [[PEDIDO:P1x2,P3x1|Nombre del cliente|Dirección o forma de entrega]] (la entrega es opcional; usa los códigos de la lista).",
  "G. Nunca digas que el pedido está confirmado ni inventes formas de pago: el sistema le avisará al cliente que queda pendiente de que una persona del equipo lo confirme.",
  "H. Si el cliente quiere cambiar o cancelar un pedido que ya hizo, pide algo que no está en la lista o quiere negociar el precio, responde SOLO con [[HUMANO]] seguido de una frase corta.",
];

export const MAX_MENU_PRODUCTS = 60;
export const MAX_AGENT_LINE_QTY = 99;
export const MAX_AGENT_LINES = 15;
const MAX_PENDING_PER_CONTACT = 2;
export const MAX_PENDING_AGENT_ORDERS = 30;
const LOW_STOCK = 10;

export interface MenuProduct { code: string; id: string; name: string; unit: string | null; priceMinor: number; stock: number | null; min?: number }
export interface CatalogMenu { currency: Currency; products: MenuProduct[]; text: string }

const fold = (s: string) => s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
const words = (s: string) => fold(s).split(/[^a-z0-9ñ]+/).filter((w) => w.length >= 3);

/** Qué productos se muestran si hay más de los que caben: primero los que el cliente nombró, luego por orden alfabético. */
export function rankProducts<T extends { name: string }>(all: T[], hints: string[]): T[] {
  const ws = new Set(hints.flatMap(words));
  const score = (p: T) => words(p.name).filter((w) => [...ws].some((h) => h === w || (h.length >= 4 && (w.startsWith(h) || h.startsWith(w))))).length;
  return all.map((p, i) => ({ p, i, s: score(p) })).sort((a, b) => b.s - a.s || a.i - b.i).map((x) => x.p);
}

const STATUS_LABEL: Record<string, string> = { pendiente: "pendiente de confirmación", confirmado: "confirmado", entregado: "entregado" };

/** Catálogo para este turno. null = el negocio no tiene productos activos: el asistente actúa como siempre. */
export async function buildCatalogMenu(db: Db, tenantId: string, contactId: string, hints: string[]): Promise<CatalogMenu | null> {
  const r = await db.query("SELECT id, name, unit, price_minor, stock, min_stock FROM catalog_products WHERE tenant_id = $1 AND active ORDER BY lower(name) LIMIT 500", [tenantId]);
  if (r.rowCount === 0) return null;
  const cur = await db.query("SELECT currency FROM catalog_settings WHERE tenant_id = $1", [tenantId]);
  const currency: Currency = isCurrency(cur.rows[0]?.currency) ? cur.rows[0].currency : "USD";

  const all = r.rows.map((p) => ({ id: p.id as string, name: cleanLabel(p.name, 120) || "Producto", unit: p.unit ? cleanLabel(p.unit, 40) : null, priceMinor: Number(p.price_minor), stock: p.stock as number | null, min: (p.min_stock as number | null) ?? LOW_STOCK }));
  const available = rankProducts(all.filter((p) => p.stock === null || p.stock > 0), hints);
  const shown = available.slice(0, MAX_MENU_PRODUCTS);
  const soldOut = all.filter((p) => p.stock === 0).slice(0, 20);
  const products: MenuProduct[] = shown.map((p, i) => ({ code: `P${i + 1}`, ...p }));

  const mine = await db.query(
    "SELECT number, status, total_minor, currency FROM orders WHERE tenant_id = $1 AND contact_id = $2 AND status IN ('pendiente', 'confirmado', 'entregado') ORDER BY number DESC LIMIT 3",
    [tenantId, contactId],
  );
  const lines = [`CATÁLOGO DEL NEGOCIO (datos del sistema; no los inventes ni los cambies). Moneda: ${CURRENCY_INFO[currency].label}.`];
  if (products.length === 0) lines.push("Productos disponibles: ninguno por ahora. No tomes pedidos; ofrece comunicar con una persona.");
  else {
    lines.push("Productos disponibles:");
    for (const p of products) lines.push(`${p.code} = ${p.name}${p.unit ? ` (${p.unit})` : ""} — ${formatMoney(p.priceMinor, currency)}${p.stock !== null && p.stock <= (p.min ?? LOW_STOCK) ? ` — quedan ${p.stock}` : ""}`);
    if (available.length > shown.length) lines.push(`(Hay ${available.length - shown.length} productos más que no se muestran: si el cliente pide algo que no está en la lista, pásalo a una persona.)`);
  }
  if (soldOut.length > 0) lines.push(`Agotados ahora mismo: ${soldOut.map((p) => p.name).join(", ")}.`);
  lines.push(
    mine.rowCount
      ? `Pedidos actuales de este cliente: ${mine.rows.map((o) => `#${o.number} ${STATUS_LABEL[o.status] ?? o.status}, total ${formatMoney(Number(o.total_minor), isCurrency(o.currency) ? o.currency : currency)}`).join("; ")}`
      : "Pedidos actuales de este cliente: ninguno.",
  );
  return { currency, products, text: lines.join("\n") };
}

// ------------------------------------------------------------------ la marca
export interface OrderRequest { lines: { code: string; quantity: number }[]; name: string; delivery: string | null }

const MARKER_RE = /\[\[\s*PEDIDO\s*:\s*([^|\]\n]{1,200})\|([^|\]\n]{0,200})(?:\|([^\]\n]{0,300}))?\]\]/i;
const ANY_MARKER_RE = /\[\[\s*PEDIDO[^\]\n]*(?:\]\]?)?/gi;
const LINE_RE = /^P(\d{1,3})\s*[x×*]\s*(\d{1,3})$/i;

export function parseOrderRequest(raw: string): OrderRequest | null {
  const m = MARKER_RE.exec(raw);
  if (!m) return null;
  const parts = m[1]!.split(",").map((s) => s.trim()).filter(Boolean);
  if (parts.length === 0 || parts.length > MAX_AGENT_LINES) return null;
  const lines: OrderRequest["lines"] = [];
  for (const p of parts) {
    const x = LINE_RE.exec(p);
    if (!x) return null;
    lines.push({ code: `P${Number(x[1])}`, quantity: Number(x[2]) });
  }
  return { lines, name: m[2]!.trim(), delivery: m[3]?.trim() || null };
}

export function stripOrderMarkers(raw: string): string {
  return raw.replace(ANY_MARKER_RE, "").trim();
}

/** Texto de entrega apto para guardar: sin etiquetas ni marcas, sin saltos de línea, máx. 300. */
export function cleanDelivery(s: string | null): string | null {
  if (!s) return null;
  const t = normalizeUntrusted(s).replace(/\[\[|\]\]|[<>\r\n]/g, " ").replace(/\s+/g, " ").trim().slice(0, 300);
  return t || null;
}

// ------------------------------------------------------------------ crear el pedido
export type OrderOutcome =
  | { kind: "ok"; number: number; totalMinor: number; currency: Currency; name: string; lines: { name: string; quantity: number }[] }
  | { kind: "sin_stock"; names: string[] }
  | { kind: "limite" }
  | { kind: "invalido" };

export async function createAgentOrder(
  db: Db,
  a: { tenantId: string; contactId: string; conversationId: string; messageId: string; waId: string; contactName: string | null; menu: CatalogMenu; req: OrderRequest },
): Promise<OrderOutcome> {
  // Cada código debe existir en el menú de ESTE turno y la cantidad ser razonable.
  const picked: { product: MenuProduct; quantity: number }[] = [];
  for (const l of a.req.lines) {
    const product = a.menu.products.find((p) => p.code === l.code);
    if (!product || l.quantity < 1 || l.quantity > MAX_AGENT_LINE_QTY) return { kind: "invalido" };
    picked.push({ product, quantity: l.quantity });
  }
  const name = cleanCustomerName(a.req.name, a.contactName);
  const phone = /^\d{5,31}$/.test(a.waId) ? `+${a.waId}` : a.waId.slice(0, 32);

  const done = async (r: { id: string; number: number; totalMinor: number }): Promise<OrderOutcome> => {
    const rows = await db.query("SELECT name, quantity FROM order_items WHERE tenant_id = $1 AND order_id = $2 ORDER BY position", [a.tenantId, r.id]);
    const cur = await db.query("SELECT currency FROM orders WHERE tenant_id = $1 AND id = $2", [a.tenantId, r.id]);
    return { kind: "ok", number: r.number, totalMinor: r.totalMinor, currency: isCurrency(cur.rows[0]?.currency) ? cur.rows[0].currency : a.menu.currency, name, lines: rows.rows.map((x) => ({ name: x.name as string, quantity: x.quantity as number })) };
  };

  // Reintento del mismo mensaje: el pedido ya existe.
  const prev = await db.query("SELECT id, number, total_minor FROM orders WHERE tenant_id = $1 AND request_message_id = $2", [a.tenantId, a.messageId]);
  if (prev.rowCount === 1) return done({ id: prev.rows[0].id, number: prev.rows[0].number, totalMinor: Number(prev.rows[0].total_minor) });

  const mine = await db.query("SELECT count(*)::int AS n FROM orders WHERE tenant_id = $1 AND contact_id = $2 AND status = 'pendiente'", [a.tenantId, a.contactId]);
  if (mine.rows[0].n >= MAX_PENDING_PER_CONTACT) return { kind: "limite" };
  const pend = await db.query("SELECT count(*)::int AS n FROM orders WHERE tenant_id = $1 AND source = 'agente' AND status = 'pendiente'", [a.tenantId]);
  if (pend.rows[0].n >= MAX_PENDING_AGENT_ORDERS) return { kind: "limite" };

  // El stock se vuelve a mirar ahora (el menú pudo quedar viejo). Un pedido pendiente no lo reserva, pero no se acepta lo que ya no alcanza.
  const ids = [...new Set(picked.map((p) => p.product.id))];
  const fresh = await db.query("SELECT id, name, stock, active FROM catalog_products WHERE tenant_id = $1 AND id = ANY($2::uuid[])", [a.tenantId, ids]);
  const byId = new Map(fresh.rows.map((p) => [p.id as string, p]));
  const asked = new Map<string, number>();
  for (const p of picked) asked.set(p.product.id, (asked.get(p.product.id) ?? 0) + p.quantity);
  const short: string[] = [];
  for (const [id, q] of asked) {
    const p = byId.get(id);
    if (!p || !p.active) return { kind: "invalido" };
    if (p.stock !== null && p.stock < q) short.push(cleanLabel(p.name, 120));
  }
  if (short.length > 0) return { kind: "sin_stock", names: short };

  await db.query("SAVEPOINT pedido");
  try {
    const r = await createOrder(db, {
      tenantId: a.tenantId, source: "agente", status: "pendiente", customerName: name, customerPhone: phone, deliveryNote: cleanDelivery(a.req.delivery),
      contactId: a.contactId, conversationId: a.conversationId, requestMessageId: a.messageId, items: picked.map((p) => ({ productId: p.product.id, quantity: p.quantity })),
    });
    if (r.kind === "producto") { await db.query("ROLLBACK TO SAVEPOINT pedido"); return { kind: "invalido" }; }
    if (r.kind !== "ok" && r.kind !== "repetido") { await db.query("ROLLBACK TO SAVEPOINT pedido"); return { kind: "invalido" }; }
    if (r.kind === "ok") {
      await db.query(
        `INSERT INTO work_items (tenant_id, type, priority, title, detail, conversation_id, contact_id, source, dedupe_key)
         VALUES ($1, 'pedido', 2, $2, $3, $4, $5, 'agente', $6) ON CONFLICT DO NOTHING`,
        [a.tenantId, `Confirmar pedido #${r.number}: ${name} · ${formatMoney(r.totalMinor, a.menu.currency)}`.slice(0, 200), "Pedido tomado por el asistente. Confírmalo o cancélalo en Pedidos.", a.conversationId, a.contactId, `pedido:${r.id}`],
      );
    }
    await db.query("RELEASE SAVEPOINT pedido");
    return done({ id: r.id, number: r.number, totalMinor: r.totalMinor });
  } catch (e) {
    await db.query("ROLLBACK TO SAVEPOINT pedido");
    throw e;
  }
}

// ------------------------------------------------------------------ mensajes fijos (los escribe el servidor)
export interface OrderTexts {
  requested: (name: string, number: number, lines: { name: string; quantity: number }[], total: string) => string;
  unavailable: (names: string[]) => string;
  limit: string;
}
const list = (lines: { name: string; quantity: number }[]) => lines.map((l) => `${l.quantity} × ${l.name}`).join("\n");

const BY_TREATMENT: Record<"tu" | "usted" | "vos", OrderTexts> = {
  tu: {
    requested: (n, num, ls, total) => `Listo, ${n}. Anoté tu pedido #${num}:\n${list(ls)}\nTotal: ${total}.\nQueda pendiente: una persona del equipo lo confirma y te avisa por aquí.`,
    unavailable: (names) => `Ahora mismo no me alcanza el stock de: ${names.join(", ")}. Dime si quieres otra cantidad u otro producto y lo reviso.`,
    limit: "Ya tienes pedidos pendientes con nosotros, así que te comunico con una persona del equipo para ayudarte. En cuanto pueda te responde por aquí.",
  },
  usted: {
    requested: (n, num, ls, total) => `Listo, ${n}. Anoté su pedido #${num}:\n${list(ls)}\nTotal: ${total}.\nQueda pendiente: una persona del equipo lo confirma y le avisa por aquí.`,
    unavailable: (names) => `Ahora mismo no me alcanza el stock de: ${names.join(", ")}. Dígame si desea otra cantidad u otro producto y lo reviso.`,
    limit: "Ya tiene pedidos pendientes con nosotros, así que le comunico con una persona del equipo para ayudarle. En cuanto pueda le responde por aquí.",
  },
  vos: {
    requested: (n, num, ls, total) => `Listo, ${n}. Anoté tu pedido #${num}:\n${list(ls)}\nTotal: ${total}.\nQueda pendiente: una persona del equipo lo confirma y te avisa por acá.`,
    unavailable: (names) => `Ahora mismo no me alcanza el stock de: ${names.join(", ")}. Decime si querés otra cantidad u otro producto y lo reviso.`,
    limit: "Ya tenés pedidos pendientes con nosotros, así que te comunico con una persona del equipo para ayudarte. En cuanto pueda te responde por acá.",
  },
};
export function orderTexts(s: AgentStyle): OrderTexts {
  return BY_TREATMENT[treatmentOf(s)];
}
