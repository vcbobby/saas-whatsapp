import type { PoolClient } from "pg";
import { loadSettings } from "@/lib/agenda/load";
import { addDays, localDate } from "@/lib/agenda/tz";
import { dayRange } from "@/lib/summary/snapshot";
import { normalizeSales, type Report } from "./pure";

type Db = Pick<PoolClient, "query">;

export const REPORT_DAYS = [7, 30] as const;
export type ReportDays = (typeof REPORT_DAYS)[number];

/** Reporte de los últimos `days` días completos (hasta ayer, hora local del negocio) frente a los `days` anteriores. */
export async function buildReport(db: Db, tenantId: string, days: ReportDays = 7, now: Date = new Date()): Promise<Report> {
  const { timezone: tz } = await loadSettings(db, tenantId);
  const today = localDate(now.getTime(), tz);
  const to = addDays(today, -1);
  const from = addDays(today, -days);
  const prevFrom = addDays(today, -2 * days);
  const [start] = dayRange(from, tz);
  const [, end] = dayRange(to, tz);
  const [pStart] = dayRange(prevFrom, tz);
  const q = <R extends Record<string, unknown>>(sql: string, p: unknown[]) => db.query<R>(sql, p).then((r) => r.rows);
  const T = tenantId;

  const msgs = (await q<{ inbound: number; cur_conv: number; ai: number; person: number; prev_inbound: number }>(
    `SELECT count(*) FILTER (WHERE direction = 'in' AND created_at >= $2 AND created_at < $3 AND msg_type <> 'reaction')::int AS inbound,
            count(DISTINCT conversation_id) FILTER (WHERE direction = 'in' AND created_at >= $2 AND created_at < $3)::int AS cur_conv,
            count(*) FILTER (WHERE direction = 'out' AND sent_by IS NULL AND reply_to IS NOT NULL AND created_at >= $2 AND created_at < $3)::int AS ai,
            count(*) FILTER (WHERE direction = 'out' AND sent_by IS NOT NULL AND created_at >= $2 AND created_at < $3)::int AS person,
            count(*) FILTER (WHERE direction = 'in' AND created_at >= $4 AND created_at < $2 AND msg_type <> 'reaction')::int AS prev_inbound
       FROM messages WHERE tenant_id = $1 AND created_at >= $4 AND created_at < $3`, [T, start, end, pStart]))[0]!;

  const cust = (await q<{ cur: number; prev: number }>(
    `SELECT count(*) FILTER (WHERE created_at >= $2 AND created_at < $3)::int AS cur, count(*) FILTER (WHERE created_at >= $4 AND created_at < $2)::int AS prev
       FROM contacts WHERE tenant_id = $1 AND created_at >= $4 AND created_at < $3`, [T, start, end, pStart]))[0]!;

  const hand = (await q<{ n: number }>("SELECT count(*)::int AS n FROM work_items WHERE tenant_id = $1 AND type = 'atencion_humana' AND created_at >= $2 AND created_at < $3", [T, start, end]))[0]!.n;

  const resolved = (await q<{ n: number }>(
    `SELECT count(*)::int AS n FROM (
       SELECT conversation_id FROM messages WHERE tenant_id = $1 AND created_at >= $2 AND created_at < $3 GROUP BY conversation_id
        HAVING bool_or(direction = 'in') AND bool_or(direction = 'out' AND sent_by IS NULL AND reply_to IS NOT NULL) AND NOT bool_or(direction = 'out' AND sent_by IS NOT NULL)
     ) c WHERE NOT EXISTS (SELECT 1 FROM work_items w WHERE w.tenant_id = $1 AND w.conversation_id = c.conversation_id AND w.type = 'atencion_humana' AND w.created_at >= $2 AND w.created_at < $3)`,
    [T, start, end]))[0]!.n;

  // Primera respuesta a cada tanda de mensajes del cliente (los que siguen a un mensaje nuestro o abren la conversación).
  const reply = (await q<{ ai: number | null; person: number | null }>(
    `WITH inb AS (
       SELECT id, conversation_id, created_at FROM (
         SELECT m.id, m.conversation_id, m.created_at, m.direction, m.msg_type, lag(m.direction) OVER (PARTITION BY m.conversation_id ORDER BY m.created_at, m.id) AS prev
           FROM messages m WHERE m.tenant_id = $1 AND m.created_at >= $2::timestamptz - interval '1 day' AND m.created_at < $3) x
        WHERE direction = 'in' AND msg_type <> 'reaction' AND (prev IS NULL OR prev = 'out') AND created_at >= $2),
     rep AS (
       SELECT o.sent_by IS NULL AS by_ai, extract(epoch FROM o.created_at - i.created_at) AS secs
         FROM inb i JOIN LATERAL (
           SELECT x.created_at, x.sent_by FROM messages x
            WHERE x.tenant_id = $1 AND x.conversation_id = i.conversation_id AND x.direction = 'out' AND x.created_at > i.created_at
              AND (x.reply_to IS NOT NULL OR x.sent_by IS NOT NULL) ORDER BY x.created_at LIMIT 1) o ON true)
     SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY secs) FILTER (WHERE by_ai AND secs <= 86400) AS ai,
            percentile_cont(0.5) WITHIN GROUP (ORDER BY secs) FILTER (WHERE NOT by_ai AND secs <= 86400) AS person FROM rep`, [T, start, end]))[0]!;

  const hours = Array<number>(24).fill(0);
  for (const r of await q<{ h: number; n: number }>(
    "SELECT extract(hour FROM created_at AT TIME ZONE $4)::int AS h, count(*)::int AS n FROM messages WHERE tenant_id = $1 AND direction = 'in' AND msg_type <> 'reaction' AND created_at >= $2 AND created_at < $3 GROUP BY 1", [T, start, end, tz])) hours[r.h] = r.n;

  const ord = (await q<{ cur: number; prev: number }>(
    `SELECT count(*) FILTER (WHERE created_at >= $2 AND created_at < $3)::int AS cur, count(*) FILTER (WHERE created_at >= $4 AND created_at < $2)::int AS prev
       FROM orders WHERE tenant_id = $1 AND status <> 'cancelado' AND created_at >= $4 AND created_at < $3`, [T, start, end, pStart]))[0]!;
  const sales = await q<{ currency: string; total: string }>(
    "SELECT currency, sum(total_minor)::bigint AS total FROM orders WHERE tenant_id = $1 AND status IN ('confirmado', 'entregado') AND created_at >= $2 AND created_at < $3 GROUP BY currency ORDER BY currency", [T, start, end]);
  const top = await q<{ name: string; qty: number }>(
    `SELECT i.name, sum(i.quantity)::int AS qty FROM order_items i JOIN orders o ON o.tenant_id = i.tenant_id AND o.id = i.order_id
      WHERE i.tenant_id = $1 AND o.status <> 'cancelado' AND o.created_at >= $2 AND o.created_at < $3 GROUP BY i.name ORDER BY qty DESC, i.name LIMIT 3`, [T, start, end]);

  const ap = (await q<{ cur: number; prev: number; done: number; noshow: number; cancelled: number }>(
    `SELECT count(*) FILTER (WHERE starts_at >= $2 AND starts_at < $3 AND status <> 'cancelada')::int AS cur,
            count(*) FILTER (WHERE starts_at >= $4 AND starts_at < $2 AND status <> 'cancelada')::int AS prev,
            count(*) FILTER (WHERE starts_at >= $2 AND starts_at < $3 AND status = 'completada')::int AS done,
            count(*) FILTER (WHERE starts_at >= $2 AND starts_at < $3 AND status = 'no_asistio')::int AS noshow,
            count(*) FILTER (WHERE starts_at >= $2 AND starts_at < $3 AND status = 'cancelada')::int AS cancelled
       FROM appointments WHERE tenant_id = $1 AND starts_at >= $4 AND starts_at < $3`, [T, start, end, pStart]))[0]!;

  return {
    timezone: tz, from, to, days,
    conversations: msgs.cur_conv,
    newCustomers: { current: cust.cur, previous: cust.prev },
    inbound: { current: msgs.inbound, previous: msgs.prev_inbound },
    byAssistant: msgs.ai, byPerson: msgs.person,
    handoffs: hand, resolvedByAssistant: resolved,
    replyAssistantSecs: reply.ai === null ? null : Number(reply.ai),
    replyPersonSecs: reply.person === null ? null : Number(reply.person),
    hours,
    orders: { current: ord.cur, previous: ord.prev },
    sales: normalizeSales(sales),
    topProducts: top.map((t) => ({ name: t.name, quantity: t.qty })),
    appointments: { current: ap.cur, previous: ap.prev, completed: ap.done, noShow: ap.noshow, cancelled: ap.cancelled },
  };
}
