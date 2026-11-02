import { z } from "zod";
import { requireTenant } from "@/lib/auth/guard";
import { errorResponse, jsonResponse, route } from "@/lib/auth/http";
import { windowEnd } from "@/lib/conversations/reply";
import { getPool, withTenant } from "@/lib/db";

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
              ct.id AS contact_id, ct.wa_id, ct.label, ct.origin_type, ct.origin_headline, COALESCE(NULLIF(ct.display_name, ''), '+' || ct.wa_id) AS contact_name
         FROM conversations c JOIN contacts ct ON ct.tenant_id = c.tenant_id AND ct.id = c.contact_id
        WHERE c.tenant_id = $1 AND c.id = $2`,
      [tenantId, id.data],
    );
    if (c.rowCount !== 1) return null;
    const msgs = await db.query(
      `SELECT id, direction, msg_type, body, delivery_status, received_at, sent_by, (media_id IS NOT NULL) AS has_media,
              CASE WHEN send_state = 'sending' AND received_at < now() - interval '2 minutes' THEN 'unknown' ELSE send_state END AS send_state
         FROM (
         SELECT * FROM messages WHERE tenant_id = $1 AND conversation_id = $2
          ORDER BY received_at DESC, id DESC LIMIT ${MAX_MESSAGES}
       ) t ORDER BY received_at, id`,
      [tenantId, id.data],
    );
    const inbound = await db.query<{ at: Date | null }>(
      "SELECT max(created_at) AS at FROM messages WHERE tenant_id = $1 AND conversation_id = $2 AND direction = 'in'",
      [tenantId, id.data],
    );
    const work = await db.query(
      `SELECT id, type, status, priority, title, detail FROM work_items
        WHERE tenant_id = $1 AND conversation_id = $2 AND status IN ('abierto', 'en_proceso')
        ORDER BY priority, created_at`,
      [tenantId, id.data],
    );
    const notes = await db.query(
      "SELECT id, author_label, body, created_at FROM (SELECT * FROM conversation_notes WHERE tenant_id = $1 AND conversation_id = $2 ORDER BY created_at DESC, id DESC LIMIT 50) t ORDER BY created_at, id",
      [tenantId, id.data],
    );
    return { c: c.rows[0], msgs: msgs.rows, work: work.rows, notes: notes.rows, lastInbound: inbound.rows[0]?.at ?? null };
  });
  if (!data) return errorResponse(404, "no_encontrado", "No encontrado.");

  const { c } = data;
  // Nombre de quien la atiende (lo que va antes de la @ de su correo), solo si sigue en el equipo.
  const assignedName = c.assigned_to && c.status === "human"
    ? (await getPool().query<{ n: string | null }>("SELECT member_label($1, $2) AS n", [tenantId, c.assigned_to])).rows[0]?.n ?? null
    : null;
  return jsonResponse({
    conversation: {
      id: c.id,
      status: c.status,
      handoffReason: c.handoff_reason,
      assignedToMe: c.assigned_to === auth.session.userId,
      assignedName,
      replyUntil: windowEnd(data.lastInbound)?.toISOString() ?? null,
      contact: { id: c.contact_id, name: c.contact_name, waId: c.wa_id, label: c.label, origin: c.origin_type ? { type: c.origin_type, headline: c.origin_headline ?? null } : null },
    },
    messages: data.msgs.map((m) => ({
      id: m.id,
      direction: m.direction,
      sender: m.direction === "in" ? "customer" : m.sent_by === null ? "assistant" : m.sent_by === auth.session.userId ? "me" : "team",
      type: m.msg_type,
      body: m.body,
      hasMedia: m.has_media === true,
      sendState: m.send_state,
      deliveryStatus: m.delivery_status,
      at: m.received_at,
    })),
    notes: data.notes.map((n) => ({ id: n.id, author: n.author_label, body: n.body, at: n.created_at })),
    work: data.work,
  });
});
