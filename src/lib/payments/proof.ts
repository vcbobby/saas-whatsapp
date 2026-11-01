import type { PoolClient } from "pg";

type Db = Pick<PoolClient, "query">;

export const proofKey = (orderId: string) => `pago:${orderId}`;
export const proofMsgKey = (messageId: string) => `pago-msg:${messageId}`;

export type ProofResult = "vinculado" | "varios_pedidos" | "sin_pedido";

/**
 * Llegó una imagen de un cliente. Si tiene exactamente UN pedido por pagar (pendiente o confirmado), la imagen queda como su
 * comprobante y se abre una tarea «Pago por verificar». Si tiene varios, se abre la tarea sin vincular (una persona decide).
 * Si no tiene ninguno, la imagen es solo un mensaje más. Nunca marca nada como pagado: eso lo hace una persona.
 */
export async function registerProof(db: Db, tenantId: string, i: { contactId: string; conversationId: string; messageId: string; customerName?: string | null }): Promise<ProofResult> {
  const r = await db.query<{ id: string; number: number }>(
    `SELECT id, number FROM orders WHERE tenant_id = $1 AND contact_id = $2 AND status IN ('pendiente', 'confirmado') AND payment_state <> 'pagado'
      ORDER BY created_at DESC LIMIT 3`, [tenantId, i.contactId]);
  if (r.rows.length === 0) return "sin_pedido";
  if (r.rows.length === 1) {
    const o = r.rows[0]!;
    await db.query("UPDATE orders SET payment_state = 'por_verificar', proof_message_id = $3, updated_at = now() WHERE tenant_id = $1 AND id = $2", [tenantId, o.id, i.messageId]);
    // Si ya hubo una tarea para este pedido (por ejemplo, un comprobante rechazado), se vuelve a abrir.
    await db.query(
      `INSERT INTO work_items (tenant_id, type, title, detail, conversation_id, contact_id, source, dedupe_key)
       VALUES ($1, 'pago_por_verificar', $2, 'El cliente envió una imagen que parece su comprobante. Ábrela en el pedido y confirma el pago.', $3, $4, 'sistema', $5)
       ON CONFLICT (tenant_id, dedupe_key) WHERE dedupe_key IS NOT NULL
       DO UPDATE SET status = 'abierto', resolved_at = NULL, resolved_by = NULL, updated_at = now()`,
      [tenantId, `Verificar pago del pedido #${o.number}`, i.conversationId, i.contactId, proofKey(o.id)]);
    return "vinculado";
  }
  await db.query(
    `INSERT INTO work_items (tenant_id, type, title, detail, conversation_id, contact_id, source, dedupe_key)
     VALUES ($1, 'pago_por_verificar', $2, 'El cliente envió una imagen y tiene varios pedidos por pagar. Revisa a cuál corresponde.', $3, $4, 'sistema', $5)
     ON CONFLICT (tenant_id, dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING`,
    [tenantId, `Comprobante de ${(i.customerName ?? "un cliente").slice(0, 60)}: ¿a qué pedido?`, i.conversationId, i.contactId, proofMsgKey(i.messageId)]);
  return "varios_pedidos";
}

/** ¿Esta imagen quedó registrada como posible comprobante? (el asistente lo usa para responder). */
export async function isProofMessage(db: Db, tenantId: string, messageId: string): Promise<boolean> {
  const r = await db.query(
    `SELECT 1 FROM orders WHERE tenant_id = $1 AND proof_message_id = $2
     UNION ALL SELECT 1 FROM work_items WHERE tenant_id = $1 AND dedupe_key = $3 LIMIT 1`, [tenantId, messageId, proofMsgKey(messageId)]);
  return (r.rowCount ?? 0) > 0;
}
