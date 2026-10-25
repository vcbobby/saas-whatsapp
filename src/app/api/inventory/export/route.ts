import { requireTenant } from "@/lib/auth/guard";
import { errorResponse, route } from "@/lib/auth/http";
import { withTenant } from "@/lib/db";
import { csvLine, listInventory, listMovements } from "@/lib/inventory/service";

const STATUS: Record<string, string> = { agotado: "Agotado", bajo: "Poco stock", ok: "Normal", sin_control: "Sin control" };
const KIND: Record<string, string> = { inicial: "Inicial", entrada: "Entrada", salida: "Salida", merma: "Merma", ajuste: "Conteo/ajuste", pedido: "Pedido", devolucion: "Devolución", edicion: "Edición" };

/** Descarga CSV: ?que=stock (existencias actuales) o ?que=movimientos (últimos 1000). */
export const GET = route(async (req) => {
  const auth = await requireTenant(req, "catalog:manage");
  if (!auth.ok) return auth.response;
  const { tenantId } = auth.ctx;
  const que = new URL(req.url).searchParams.get("que") ?? "stock";
  if (que !== "stock" && que !== "movimientos") return errorResponse(400, "datos_invalidos", "Parámetro inválido.");
  const lines: string[] = [];
  if (que === "stock") {
    const inv = await withTenant(tenantId, (db) => listInventory(db, tenantId));
    lines.push(csvLine(["Producto", "Presentación", "Stock", "Avisar cuando queden", "Estado"]));
    for (const p of inv.rows) lines.push(csvLine([p.name, p.unit, p.stock, p.minStock, STATUS[p.status]]));
  } else {
    const mv = await withTenant(tenantId, (db) => listMovements(db, tenantId, { limit: 1000, viewerId: auth.session.userId }));
    lines.push(csvLine(["Fecha (UTC)", "Producto", "Tipo", "Cambio", "Stock resultante", "Pedido", "Nota"]));
    for (const m of mv) lines.push(csvLine([m.at, m.productName, KIND[m.kind], m.delta, m.stockAfter, m.orderNumber, m.note]));
  }
  return new Response("﻿" + lines.join("\r\n") + "\r\n", {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="inventario-${que}.csv"`,
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
  });
});
