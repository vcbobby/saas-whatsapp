import { z } from "zod";
import { requireTenant } from "@/lib/auth/guard";
import { errorResponse, jsonResponse, route } from "@/lib/auth/http";
import { withTenant } from "@/lib/db";
import { CONTACT_LABELS, MEDIA_LABEL } from "@/lib/work/labels";

const PAGE = 40;

const querySchema = z.object({
  filter: z.enum(["activas", "persona", "asistente", "cerradas"]).default("activas"),
  label: z.enum(CONTACT_LABELS).optional(),
  before: z.iso.datetime({ offset: true }).optional(),
});

const FILTER_SQL = {
  activas: "c.status <> 'closed'",
  persona: "c.status = 'human'",
  asistente: "c.status = 'bot'",
  cerradas: "c.status = 'closed'",
} as const;

/** Bandeja: conversaciones del negocio, la más reciente primero. */
export const GET = route(async (req) => {
  const auth = await requireTenant(req, "conversations:read");
  if (!auth.ok) return auth.response;
  const sp = new URL(req.url).searchParams;
  const q = querySchema.safeParse({
    filter: sp.get("filter") ?? undefined,
    label: sp.get("label") ?? undefined,
    before: sp.get("before") ?? undefined,
  });
  if (!q.success) return errorResponse(400, "datos_invalidos", "Filtro inválido.");
  const { tenantId } = auth.ctx;
  const { filter, label, before } = q.data;

  const rows = await withTenant(tenantId, async (db) => {
    const params: unknown[] = [tenantId];
    let extra = "";
    if (label) {
      params.push(label);
      extra += ` AND ct.label = $${params.length}`;
    }
    if (before) {
      params.push(before);
      extra += ` AND c.last_message_at < $${params.length}`;
    }
    const r = await db.query(
      `SELECT c.id, c.status, c.handoff_reason, c.last_message_at, c.created_at,
              ct.id AS contact_id, ct.wa_id, ct.label,
              COALESCE(NULLIF(ct.display_name, ''), '+' || ct.wa_id) AS contact_name,
              lm.body AS last_body, lm.msg_type AS last_type, lm.direction AS last_direction, (lm.sent_by IS NOT NULL) AS last_by_person,
              EXISTS (SELECT 1 FROM work_items w WHERE w.tenant_id = c.tenant_id AND w.conversation_id = c.id
                         AND w.type = 'atencion_humana' AND w.status IN ('abierto', 'en_proceso')) AS needs_attention
         FROM conversations c
         JOIN contacts ct ON ct.tenant_id = c.tenant_id AND ct.id = c.contact_id
         LEFT JOIN LATERAL (
           SELECT m.body, m.msg_type, m.direction, m.sent_by FROM messages m
            WHERE m.tenant_id = c.tenant_id AND m.conversation_id = c.id
            ORDER BY m.received_at DESC, m.id DESC LIMIT 1
         ) lm ON true
        WHERE c.tenant_id = $1 AND ${FILTER_SQL[filter]}${extra}
        ORDER BY c.last_message_at DESC NULLS LAST, c.id
        LIMIT ${PAGE + 1}`,
      params,
    );
    return r.rows;
  });

  const page = rows.slice(0, PAGE);
  return jsonResponse({
    conversations: page.map((c) => ({
      id: c.id,
      status: c.status,
      handoffReason: c.handoff_reason,
      lastMessageAt: c.last_message_at,
      contact: { id: c.contact_id, name: c.contact_name, waId: c.wa_id, label: c.label },
      lastPreview: c.last_body ? String(c.last_body).slice(0, 140) : c.last_type && c.last_type !== "text" ? `[${MEDIA_LABEL[c.last_type as string] ?? c.last_type}]` : "",
      lastDirection: c.last_direction,
      lastByPerson: c.last_by_person === true,
      needsAttention: c.needs_attention,
    })),
    nextBefore: rows.length > PAGE ? (page[page.length - 1]!.last_message_at as Date | null)?.toISOString() ?? null : null,
  });
});
