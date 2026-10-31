import { z } from "zod";
import { requireTenant } from "@/lib/auth/guard";
import { errorResponse, jsonResponse, route } from "@/lib/auth/http";
import { withTenant } from "@/lib/db";
import { DAILY_CAP } from "@/lib/broadcasts/send";

/** La difusión con sus resultados: enviados, entregados, leídos, respondieron y fallidos. */
export const GET = route(async (req) => {
  const auth = await requireTenant(req, "broadcasts:manage");
  if (!auth.ok) return auth.response;
  const id = z.uuid().safeParse(new URL(req.url).searchParams.get("id"));
  if (!id.success) return errorResponse(400, "datos_invalidos", "Difusión inválida.");
  const { tenantId } = auth.ctx;
  const data = await withTenant(tenantId, async (db) => {
    const b = (await db.query("SELECT id, name, status, pause_reason, total, template_name, template_language, template_text, params, audience, created_at, started_at, finished_at FROM broadcasts WHERE tenant_id = $1 AND id = $2", [tenantId, id.data])).rows[0];
    if (!b) return null;
    const tpl = (await db.query<{ id: string }>("SELECT id FROM whatsapp_templates WHERE tenant_id = $1 AND name = $2 AND language = $3", [tenantId, b.template_name, b.template_language])).rows[0];
    const stats = (await db.query(
      `SELECT count(*)::int AS total,
              count(*) FILTER (WHERE r.status = 'pendiente')::int AS pending,
              count(*) FILTER (WHERE r.status = 'enviado')::int AS sent,
              count(*) FILTER (WHERE r.status = 'fallido')::int AS failed,
              count(*) FILTER (WHERE r.status = 'omitido')::int AS omitted,
              count(*) FILTER (WHERE r.status = 'enviado' AND m.delivery_status IN ('delivered', 'read'))::int AS delivered,
              count(*) FILTER (WHERE r.status = 'enviado' AND m.delivery_status = 'read')::int AS read,
              count(*) FILTER (WHERE r.status = 'enviado' AND m.delivery_status = 'failed')::int AS not_delivered,
              count(*) FILTER (WHERE r.status = 'enviado' AND EXISTS (SELECT 1 FROM messages im WHERE im.tenant_id = r.tenant_id AND im.conversation_id = m.conversation_id AND im.direction = 'in' AND im.created_at > r.sent_at))::int AS replied
         FROM broadcast_recipients r LEFT JOIN messages m ON m.tenant_id = r.tenant_id AND m.id = r.message_id
        WHERE r.tenant_id = $1 AND r.broadcast_id = $2`, [tenantId, id.data])).rows[0]!;
    const people = (await db.query(
      `SELECT r.id, r.status, r.reason, r.sent_at, m.delivery_status, COALESCE(NULLIF(c.display_name, ''), '+' || c.wa_id) AS name, c.id AS contact_id
         FROM broadcast_recipients r JOIN contacts c ON c.tenant_id = r.tenant_id AND c.id = r.contact_id
         LEFT JOIN messages m ON m.tenant_id = r.tenant_id AND m.id = r.message_id
        WHERE r.tenant_id = $1 AND r.broadcast_id = $2 ORDER BY (r.status = 'fallido') DESC, r.sent_at DESC NULLS LAST, r.id LIMIT 100`, [tenantId, id.data])).rows;
    const day = (await db.query<{ n: number }>("SELECT count(*)::int AS n FROM broadcast_recipients WHERE tenant_id = $1 AND status = 'enviado' AND sent_at > now() - interval '24 hours'", [tenantId])).rows[0]!.n;
    return { b, stats, people, day, templateId: tpl?.id ?? null };
  });
  if (!data) return errorResponse(404, "no_encontrado", "No encontrado.");
  const { b } = data;
  return jsonResponse({
    broadcast: { id: b.id, name: b.name, status: b.status, pauseReason: b.pause_reason, total: b.total, templateId: data.templateId, templateName: b.template_name, text: b.template_text, params: b.params, audience: b.audience, createdAt: b.created_at, startedAt: b.started_at, finishedAt: b.finished_at },
    stats: data.stats,
    sentToday: data.day, dailyCap: DAILY_CAP,
    people: data.people.map((p) => ({ id: p.id, contactId: p.contact_id, name: p.name, status: p.status, reason: p.reason, sentAt: p.sent_at, delivery: p.delivery_status })),
  });
});
