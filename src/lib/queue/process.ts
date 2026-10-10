import { z } from "zod";
import { withTenant } from "@/lib/db";
import type { InboundJob } from "./producer";

const jobSchema = z.object({ tenantId: z.uuid(), messageId: z.uuid() });

export type InboundHandler = (job: InboundJob) => Promise<void>;
export type ProcessResult = "done" | "skipped";

/**
 * Procesa un mensaje entrante. Reglas:
 *  - Todo pasa por withTenant: un trabajo falso con un negocio y un mensaje de otro no encuentra nada (RLS).
 *  - Si el mensaje ya no está "pending" (otro worker lo terminó), no se repite.
 *  - El handler puede ejecutarse más de una vez para el mismo mensaje (reintentos): debe ser idempotente.
 *  - Si el handler falla, el mensaje sigue "pending" y BullMQ reintenta.
 */
export async function processInbound(data: unknown, handler: InboundHandler): Promise<ProcessResult> {
  const job = jobSchema.parse(data);

  const pending = await withTenant(job.tenantId, async (db) => {
    const r = await db.query(
      "SELECT 1 FROM messages WHERE tenant_id = $1 AND id = $2 AND direction = 'in' AND process_state = 'pending'",
      [job.tenantId, job.messageId],
    );
    return r.rowCount === 1;
  });
  if (!pending) return "skipped";

  await handler(job);

  await withTenant(job.tenantId, (db) =>
    db.query(
      "UPDATE messages SET process_state = 'done', process_state_at = now() WHERE tenant_id = $1 AND id = $2 AND process_state = 'pending'",
      [job.tenantId, job.messageId],
    ),
  );
  return "done";
}

/** Se llama cuando BullMQ agotó los reintentos: se deja de insistir y queda registrado. */
export async function markInboundFailed(data: unknown): Promise<void> {
  const parsed = jobSchema.safeParse(data);
  if (!parsed.success) return;
  const job = parsed.data;
  await withTenant(job.tenantId, async (db) => {
    await db.query(
      "UPDATE messages SET process_state = 'failed', process_state_at = now() WHERE tenant_id = $1 AND id = $2 AND process_state = 'pending'",
      [job.tenantId, job.messageId],
    );
    // Que una persona lo vea: el asistente no pudo con este mensaje.
    await db.query(
      `UPDATE conversations SET status = 'human', handoff_reason = 'agente_fallo'
        WHERE tenant_id = $1 AND status = 'bot'
          AND id = (SELECT conversation_id FROM messages WHERE tenant_id = $1 AND id = $2 AND process_state = 'failed')`,
      [job.tenantId, job.messageId],
    );
  });
}
