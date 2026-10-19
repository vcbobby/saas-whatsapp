import type { PoolClient } from "pg";
import { loadSettings } from "@/lib/agenda/load";
import { addDays, localDate } from "@/lib/agenda/tz";
import { buildChecklist, DASH_DAYS, fillDays, sumDays, type DashboardData, type DayPoint, type Delta, type MoneyTotal } from "./pure";
import { isCurrency, type Currency } from "@/lib/catalog/money";
import { loadPlan } from "@/lib/plans/usage";
import { dayRange } from "@/lib/summary/snapshot";

type Db = Pick<PoolClient, "query">;

export * from "./pure";

export async function buildDashboard(db: Db, tenantId: string, now: Date = new Date()): Promise<DashboardData> {
  const { timezone: tz } = await loadSettings(db, tenantId);
  const today = localDate(now.getTime(), tz);
  const first = addDays(today, -(DASH_DAYS - 1));
  const [start] = dayRange(first, tz);
  const [, end] = dayRange(today, tz);
  const mods = (await loadPlan(db, tenantId))?.modules ?? [];
  const ob = String((await db.query("SELECT onboarding_state FROM tenants WHERE id = $1", [tenantId])).rows[0]?.onboarding_state ?? "done");

  const rows = new Map<string, Partial<Omit<DayPoint, "day">>>();
  const put = (day: string, patch: Partial<Omit<DayPoint, "day">>) => rows.set(day, { ...(rows.get(day) ?? {}), ...patch });

  const msg = await db.query(
    `SELECT to_char((created_at AT TIME ZONE $4)::date, 'YYYY-MM-DD') AS d,
            count(*) FILTER (WHERE direction = 'in')::int AS i, count(*) FILTER (WHERE direction = 'out')::int AS o
       FROM messages WHERE tenant_id = $1 AND created_at >= $2 AND created_at < $3 GROUP BY 1`,
    [tenantId, start, end, tz],
  );
  for (const r of msg.rows) put(r.d as string, { inbound: r.i, outbound: r.o });

  // Personas distintas (conversaciones) que escribieron: últimos 7 días contra los 7 anteriores.
  const [wStart] = dayRange(addDays(today, -6), tz);
  const [pStart] = dayRange(addDays(today, -13), tz);
  const ppl = await db.query(
    `SELECT count(DISTINCT conversation_id) FILTER (WHERE created_at >= $3)::int AS cur,
            count(DISTINCT conversation_id) FILTER (WHERE created_at >= $2 AND created_at < $3)::int AS prev
       FROM messages WHERE tenant_id = $1 AND direction = 'in' AND created_at >= $2 AND created_at < $4`,
    [tenantId, pStart, wStart, end],
  );

  if (mods.includes("agenda")) {
    const a = await db.query(
      `SELECT to_char((starts_at AT TIME ZONE $4)::date, 'YYYY-MM-DD') AS d, count(*)::int AS n
         FROM appointments WHERE tenant_id = $1 AND status <> 'cancelada' AND starts_at >= $2 AND starts_at < $3 GROUP BY 1`,
      [tenantId, start, end, tz],
    );
    for (const r of a.rows) put(r.d as string, { appointments: r.n });
  }
  let sales: MoneyTotal[] = [];
  if (mods.includes("catalogo")) {
    const o = await db.query(
      `SELECT to_char((created_at AT TIME ZONE $4)::date, 'YYYY-MM-DD') AS d, count(*)::int AS n
         FROM orders WHERE tenant_id = $1 AND status <> 'cancelado' AND created_at >= $2 AND created_at < $3 GROUP BY 1`,
      [tenantId, start, end, tz],
    );
    for (const r of o.rows) put(r.d as string, { orders: r.n });
    const s = await db.query(
      `SELECT currency, COALESCE(sum(total_minor), 0)::text AS total FROM orders
        WHERE tenant_id = $1 AND status <> 'cancelado' AND created_at >= $2 AND created_at < $3 GROUP BY currency ORDER BY currency`,
      [tenantId, wStart, end],
    );
    sales = s.rows.filter((r) => isCurrency(r.currency)).map((r) => ({ currency: r.currency as Currency, totalMinor: Number(r.total) }));
  }

  const days = fillDays(today, rows);
  const delta = (key: Exclude<keyof DayPoint, "day">): Delta => ({ current: sumDays(days, key, DASH_DAYS - 7, DASH_DAYS), previous: sumDays(days, key, DASH_DAYS - 14, DASH_DAYS - 7) });

  // Lista «Primeros pasos»: se calcula con lo que el negocio ya tiene.
  const q = async (sql: string) => Boolean((await db.query(sql, [tenantId])).rowCount);
  const agent = await db.query("SELECT enabled FROM tenant_agents WHERE tenant_id = $1", [tenantId]);
  const members = await db.query("SELECT count(*)::int AS n FROM memberships WHERE tenant_id = $1", [tenantId]);
  const pending = await db.query("SELECT tenant_pending_invitations() AS n");
  const checklist = buildChecklist({
    whatsapp: await q("SELECT 1 FROM tenant_integrations WHERE tenant_id = $1 LIMIT 1"),
    agent: agent.rows[0]?.enabled === true,
    kb: await q("SELECT 1 FROM kb_documents WHERE tenant_id = $1 AND status = 'ready' LIMIT 1"),
    catalog: (await q("SELECT 1 FROM agenda_services WHERE tenant_id = $1 AND active LIMIT 1")) || (await q("SELECT 1 FROM catalog_products WHERE tenant_id = $1 AND active LIMIT 1")),
    team: Number(members.rows[0].n) + Number(pending.rows[0].n) > 1,
    message: await q("SELECT 1 FROM messages WHERE tenant_id = $1 AND direction = 'in' LIMIT 1"),
  });

  return {
    timezone: tz,
    today,
    modules: mods,
    days,
    week: { inbound: delta("inbound"), outbound: delta("outbound"), people: { current: ppl.rows[0].cur, previous: ppl.rows[0].prev }, appointments: delta("appointments"), orders: delta("orders"), sales },
    checklist,
    onboarding: ob === "pending" || ob === "skipped" ? ob : "done",
  };
}
