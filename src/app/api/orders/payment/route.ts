import { z } from "zod";
import { requireTenant } from "@/lib/auth/guard";
import { checkOrigin, errorResponse, jsonResponse, readJson, route } from "@/lib/auth/http";
import { withTenant } from "@/lib/db";
import { proofKey } from "@/lib/payments/proof";

const schema = z.object({
  id: z.uuid(),
  action: z.enum(["pagado", "rechazar", "reabrir"]),
  method: z.string().trim().max(40, "Máximo 40 letras").optional(),
});

/**
 * Pago de un pedido: «pagado» (de sin pagar o por verificar), «rechazar» el comprobante (vuelve a sin pagar) o «reabrir» uno marcado pagado por error.
 * Un pedido cancelado no se cobra. La tarea «Pago por verificar» se cierra sola.
 */
export const POST = route(async (req) => {
  const blocked = checkOrigin(req);
  if (blocked) return blocked;
  const auth = await requireTenant(req, "orders:write");
  if (!auth.ok) return auth.response;
  const body = await readJson(req, schema);
  if (!body.ok) return body.response;
  const { tenantId } = auth.ctx;
  const { id, action, method } = body.data;
  const ok = await withTenant(tenantId, async (db) => {
    let r;
    if (action === "pagado") {
      r = await db.query(
        `UPDATE orders SET payment_state = 'pagado', paid_at = now(), paid_by = $3, payment_method = $4, updated_at = now()
          WHERE tenant_id = $1 AND id = $2 AND status <> 'cancelado' AND payment_state IN ('sin_pago', 'por_verificar')`,
        [tenantId, id, auth.session.userId, method || null]);
    } else if (action === "rechazar") {
      r = await db.query(
        "UPDATE orders SET payment_state = 'sin_pago', proof_message_id = NULL, updated_at = now() WHERE tenant_id = $1 AND id = $2 AND payment_state = 'por_verificar'",
        [tenantId, id]);
    } else {
      r = await db.query(
        "UPDATE orders SET payment_state = 'sin_pago', paid_at = NULL, paid_by = NULL, payment_method = NULL, updated_at = now() WHERE tenant_id = $1 AND id = $2 AND payment_state = 'pagado'",
        [tenantId, id]);
    }
    if (r.rowCount !== 1) return false;
    if (action !== "reabrir") {
      await db.query(
        "UPDATE work_items SET status = $3, resolved_at = now(), resolved_by = $4 WHERE tenant_id = $1 AND dedupe_key = $2 AND status IN ('abierto', 'en_proceso')",
        [tenantId, proofKey(id), action === "pagado" ? "resuelto" : "descartado", auth.session.userId]);
    }
    await db.query("INSERT INTO audit_log (tenant_id, actor_id, action, target_type, target_id) VALUES ($1,$2,$3,'order',$4)", [tenantId, auth.session.userId, `order.payment.${action}`, id]);
    return true;
  });
  if (!ok) return errorResponse(409, "estado_invalido", "El pago de este pedido ya cambió o el pedido está cancelado. Actualiza la pantalla.");
  return jsonResponse({ ok: true });
});
