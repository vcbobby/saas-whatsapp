import { z } from "zod";
import { requireTenant } from "@/lib/auth/guard";
import { checkOrigin, errorResponse, jsonResponse, readJson, route } from "@/lib/auth/http";
import { withTenant } from "@/lib/db";
import { MAX_STOCK } from "@/lib/catalog/money";
import { adjustStock } from "@/lib/inventory/service";

const schema = z.object({
  productId: z.uuid(),
  mode: z.enum(["entrada", "salida", "merma", "conteo"]),
  quantity: z.number().int("Escribe un número entero").min(0).max(MAX_STOCK),
  note: z.string().trim().max(200, "Máximo 200 caracteres").optional(),
}).refine((d) => d.mode === "conteo" || d.quantity > 0, { message: "La cantidad debe ser mayor que 0", path: ["quantity"] });

/** Entrada, salida, merma o conteo de un producto. Queda anotado en el historial con quién lo hizo. */
export const POST = route(async (req) => {
  const blocked = checkOrigin(req);
  if (blocked) return blocked;
  const auth = await requireTenant(req, "catalog:manage");
  if (!auth.ok) return auth.response;
  const body = await readJson(req, schema);
  if (!body.ok) return body.response;
  const { tenantId } = auth.ctx;
  const d = body.data;
  const out = await withTenant(tenantId, (db) => adjustStock(db, tenantId, { productId: d.productId, mode: d.mode, quantity: d.quantity, note: d.note || null, userId: auth.session.userId }));
  switch (out.kind) {
    case "no_existe": return errorResponse(404, "no_encontrado", "No encontrado.");
    case "sin_control": return errorResponse(409, "sin_control", "Ese producto no controla stock todavía. Haz primero un conteo para empezar.");
    case "sin_stock": return errorResponse(409, "sin_stock", `Solo hay ${out.stock} en stock: no se puede sacar más de lo que hay.`);
    case "excede": return errorResponse(409, "stock_excedido", `El stock no puede pasar de ${MAX_STOCK.toLocaleString("es")}.`);
    case "sin_cambio": return jsonResponse({ ok: true, stock: out.stock, changed: false });
    case "ok": return jsonResponse({ ok: true, stock: out.stock, delta: out.delta, changed: true });
  }
});
