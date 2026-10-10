import { getPool, withTenant } from "@/lib/db";
import type { TenantBatch } from "./payload";

export interface IngestResult {
  newMessages: number;
  /** Mensajes entrantes NUEVOS que hay que encolar para el agente. */
  inbound: { tenantId: string; messageId: string }[];
  statusUpdates: number;
  unknownNumber: boolean;
}

/**
 * Guarda un lote en el negocio dueño del número. Es idempotente: si Meta
 * reintenta el mismo mensaje, el índice único (tenant_id, wa_message_id) lo descarta.
 */
export async function ingestBatch(batch: TenantBatch): Promise<IngestResult> {
  const r = await getPool().query<{ resolve_tenant_by_phone_number_id: string | null }>(
    "SELECT resolve_tenant_by_phone_number_id($1)",
    [batch.phoneNumberId],
  );
  const tenantId = r.rows[0]?.resolve_tenant_by_phone_number_id;
  // Número que no es de ningún cliente: se ignora (pero se responde 200 para que Meta no reintente).
  if (!tenantId) return { newMessages: 0, inbound: [], statusUpdates: 0, unknownNumber: true };

  return withTenant(tenantId, async (db) => {
    let newMessages = 0;
    let statusUpdates = 0;
    const inbound: { tenantId: string; messageId: string }[] = [];

    for (const m of batch.messages) {
      const contact = await db.query<{ id: string }>(
        `INSERT INTO contacts (tenant_id, wa_id, display_name) VALUES ($1, $2, $3)
         ON CONFLICT (tenant_id, wa_id)
         DO UPDATE SET display_name = COALESCE(EXCLUDED.display_name, contacts.display_name)
         RETURNING id`,
        [tenantId, m.waId, m.name],
      );
      const contactId = contact.rows[0]!.id;

      await db.query(
        `INSERT INTO conversations (tenant_id, contact_id) VALUES ($1, $2)
         ON CONFLICT (tenant_id, contact_id) WHERE status <> 'closed' DO NOTHING`,
        [tenantId, contactId],
      );
      const conv = await db.query<{ id: string }>(
        `SELECT id FROM conversations WHERE tenant_id = $1 AND contact_id = $2 AND status <> 'closed'`,
        [tenantId, contactId],
      );
      const conversationId = conv.rows[0]!.id;

      const ins = await db.query(
        `INSERT INTO messages (tenant_id, conversation_id, direction, wa_message_id, msg_type, body, created_at, process_state)
         VALUES ($1, $2, 'in', $3, $4, $5, $6, 'pending')
         ON CONFLICT (tenant_id, wa_message_id) DO NOTHING
         RETURNING id`,
        [tenantId, conversationId, m.waMessageId, m.type, m.body, m.at],
      );
      if (ins.rowCount) {
        newMessages++;
        inbound.push({ tenantId, messageId: ins.rows[0].id });
        await db.query(
          `UPDATE conversations SET last_message_at = GREATEST(COALESCE(last_message_at, $3), $3)
           WHERE tenant_id = $1 AND id = $2`,
          [tenantId, conversationId, m.at],
        );
      }
    }

    for (const s of batch.statuses) {
      // Solo avanza: sent -> delivered -> read. "failed" es final y "read" también.
      const u = await db.query(
        `UPDATE messages SET delivery_status = $3, status_at = $4
         WHERE tenant_id = $1 AND wa_message_id = $2 AND direction = 'out'
           AND (CASE COALESCE(delivery_status, '') WHEN '' THEN 0 WHEN 'sent' THEN 1 WHEN 'delivered' THEN 2 ELSE 3 END)
             < (CASE $3::text WHEN 'sent' THEN 1 WHEN 'delivered' THEN 2 WHEN 'read' THEN 3 ELSE 2 END)`,
        [tenantId, s.waMessageId, s.status, s.at],
      );
      statusUpdates += u.rowCount ?? 0;
    }
    return { newMessages, inbound, statusUpdates, unknownNumber: false };
  });
}
