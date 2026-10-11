import { z } from "zod";
import { requireTenant } from "@/lib/auth/guard";
import { errorResponse, jsonResponse, route } from "@/lib/auth/http";
import { withTenant } from "@/lib/db";

const MAX_MESSAGES = 100;

/** Una conversación con sus últimos mensajes y sus tareas abiertas. */
export const GET = route(async (req) => {
  const auth = await requireTenant(req, "conversations:read");
  if (!auth.ok) return auth.response;
  const id = z.uuid().safeParse(new URL(req.url).searchParams.get("id"));
  if (!id.success) return errorResponse(400, "datos_invalidos", "Conversación inválida.");
  const { tenantId } = auth.ctx;

  const data = await withTenant(tenantId, async (db) => {
    const c = await db.query(
      `SELECT c.id, c.status, c.handoff_reason, c.assigned_to, c.last_message_at,
              ct.id AS contact_id, ct.wa_id, ct.label, COALESCE(NULLIF(ct.display_name, ''), '+' || ct.wa_id) AS contact_name
         FROM conversations c JOIN contacts ct ON ct.tenant_id = c.tenant_id AND ct.id = c.contact_id
        WHERE c.tenant_id = $1 AND c.id = $2`,
      [tenantId, id.data],
    );
    if (c.rowCount !== 1) return null;
    const msgs = await db.query(
      `SELECT id, direction, msg_type, body, send_state, delivery_status, received_at FROM (
         SELECT * FROM messages WHERE tenant_id = $1 AND conversation_id = $2
          ORDER BY received_at DESC, id DESC LIMIT ${MAX_MESSAGES}
       ) t ORDER BY received_at, id`,
      [tenantId, id.data],
    );
    const work = await db.query(
      `SELECT id, type, status, priority, title, detail FROM work_items
        WHERE tenant_id = $1 AND conversation_id = $2 AND status IN ('abierto', 'en_proceso')
        ORDER BY priority, created_at`,
      [tenantId, id.data],
    );
    return { c: c.rows[0], msgs: msgs.rows, work: work.rows };
  });
  if (!data) return errorResponse(404, "no_encontrado", "No encontrado.");

  const { c } = data;
  return jsonResponse({
    conversation: {
      id: c.id,
      status: c.status,
      handoffReason: c.handoff_reason,
      assignedToMe: c.assigned_to === auth.session.userId,
      contact: { id: c.contact_id, name: c.contact_name, waId: c.wa_id, label: c.label },
    },
    messages: data.msgs.map((m) => ({
      id: m.id,
      direction: m.direction,
      type: m.msg_type,
      body: m.body,
      sendState: m.send_state,
      deliveryStatus: m.delivery_status,
      at: m.received_at,
    })),
    work: data.work,
  });
});
