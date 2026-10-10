import { getPool } from "@/lib/db";
import { enqueueInbound, type InboundJob } from "./producer";

/**
 * Recupera mensajes que quedaron "pending" (Redis caído al llegar, trabajo perdido).
 * Reencolar es seguro: el id del trabajo es el id del mensaje.
 */
export async function sweepPending(minAgeSeconds = 60, limit = 200): Promise<number> {
  const r = await getPool().query<{ out_tenant_id: string; out_message_id: string }>(
    "SELECT out_tenant_id, out_message_id FROM queue_pending_inbound($1, $2)",
    [minAgeSeconds, limit],
  );
  const items: InboundJob[] = r.rows.map((x) => ({ tenantId: x.out_tenant_id, messageId: x.out_message_id }));
  await enqueueInbound(items);
  return items.length;
}
