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
