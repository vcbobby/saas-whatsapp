import type { PoolClient } from "pg";
import { loadSettings } from "@/lib/agenda/load";
import { addDays, localDate, localToUtc } from "@/lib/agenda/tz";
import { loadPlan } from "@/lib/plans/usage";
import { isCurrency, type Currency } from "@/lib/catalog/money";

type Db = Pick<PoolClient, "query">;

/** Debajo de este stock un producto cuenta como «poco stock» (igual que en el menú del asistente). */
export const LOW_STOCK_LIMIT = 10;
const MAX_LIST = 20;

export interface MoneyByCurrency { currency: Currency; count: number; totalMinor: number }

/** Foto del negocio en este momento. Solo datos del propio negocio, calculados por el servidor: ninguna IA toca estas cifras. */
export interface Snapshot {
  generatedAt: string;
  timezone: string;
  today: string; // fecha local (AAAA-MM-DD)
  messages: { inToday: number; outToday: number; inYesterday: number; outYesterday: number; peopleToday: number };
  attention: { humanConversations: number; openTasks: number; urgentTasks: number; overdueTasks: number; byType: Record<string, number> };
  /** null = el negocio no usa agenda (no hay servicios activos). */
  agenda: null | {
    todayList: { startsAt: string; time: string; service: string; customer: string; status: "pendiente" | "confirmada" }[];
    todayCount: number;
    tomorrowCount: number;
    pendingConfirm: number;
  };
  /** null = el negocio no usa catálogo (no hay productos activos). */
  orders: null | {
    pending: number;
    pendingOlderThan24h: number;
    pendingTotals: MoneyByCurrency[];
    todayTotals: MoneyByCurrency[]; // pedidos creados hoy, sin cancelados
    lowStock: { name: string; stock: number }[];
    soldOutCount: number;
  };
}

const clean = (s: unknown, max: number) => String(s ?? "").replace(/[\u0000-\u001f\u007f<>]|\[\[|\]\]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);

export function dayRange(ymd: string, tz: string): [Date, Date] {
  const a = localToUtc(ymd, 0, tz);
  const b = localToUtc(addDays(ymd, 1), 0, tz);
  // Si el salto de horario hiciera inexistente la medianoche, se usa la hora de ese día más cercana.
  const start = a ?? localToUtc(ymd, 60, tz) ?? Date.parse(`${ymd}T00:00:00Z`);
  const end = b ?? localToUtc(addDays(ymd, 1), 60, tz) ?? start + 86_400_000;
  return [new Date(start), new Date(end)];
}

function hm(utcMs: number, tz: string): string {
  return new Intl.DateTimeFormat("es", { timeZone: tz, hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(utcMs));
}

function money(rows: { currency: unknown; n: unknown; total: unknown }[]): MoneyByCurrency[] {
  return rows.filter((r) => isCurrency(r.currency)).map((r) => ({ currency: r.currency as Currency, count: Number(r.n), totalMinor: Number(r.total) }));
}

export async function buildSnapshot(db: Db, tenantId: string, now: Date = new Date()): Promise<Snapshot> {
  const { timezone: tz } = await loadSettings(db, tenantId);
  const today = localDate(now.getTime(), tz);
  const [todayStart, todayEnd] = dayRange(today, tz);
  const [yStart] = dayRange(addDays(today, -1), tz);
  const [, tomorrowEnd] = dayRange(addDays(today, 1), tz);

  // Mensajes de ayer y de hoy (hora del negocio).
  const msg = await db.query(
    `SELECT direction,
            count(*) FILTER (WHERE created_at >= $3 AND created_at < $4)::int AS today,
            count(*) FILTER (WHERE created_at >= $2 AND created_at < $3)::int AS yday,
            count(DISTINCT conversation_id) FILTER (WHERE created_at >= $3 AND created_at < $4)::int AS people
       FROM messages WHERE tenant_id = $1 AND created_at >= $2 AND created_at < $4 GROUP BY direction`,
    [tenantId, yStart, todayStart, todayEnd],
  );
  const mIn = msg.rows.find((r) => r.direction === "in");
  const mOut = msg.rows.find((r) => r.direction === "out");

  const conv = await db.query("SELECT count(*)::int AS n FROM conversations WHERE tenant_id = $1 AND status = 'human'", [tenantId]);
  const tasks = await db.query(
    `SELECT type, count(*)::int AS n, count(*) FILTER (WHERE priority = 1)::int AS urgent, count(*) FILTER (WHERE due_at IS NOT NULL AND due_at < $2)::int AS overdue
       FROM work_items WHERE tenant_id = $1 AND status IN ('abierto', 'en_proceso') GROUP BY type`,
    [tenantId, now],
  );
  const byType: Record<string, number> = {};
  let openTasks = 0, urgentTasks = 0, overdueTasks = 0;
  for (const r of tasks.rows) { byType[r.type as string] = r.n; openTasks += r.n; urgentTasks += r.urgent; overdueTasks += r.overdue; }

  // Solo se resume lo que el plan incluye.
  const mods = (await loadPlan(db, tenantId))?.modules ?? [];

  // Agenda: solo si el negocio tiene algún servicio activo.
  let agenda: Snapshot["agenda"] = null;
  const svc = await db.query("SELECT 1 FROM agenda_services WHERE tenant_id = $1 AND active LIMIT 1", [tenantId]);
  if (svc.rowCount && mods.includes("agenda")) {
    const list = await db.query(
      `SELECT a.starts_at, a.customer_name, a.status, s.name AS service
         FROM appointments a JOIN agenda_services s ON s.tenant_id = a.tenant_id AND s.id = a.service_id
        WHERE a.tenant_id = $1 AND a.status IN ('pendiente', 'confirmada') AND a.starts_at >= $2 AND a.starts_at < $3
        ORDER BY a.starts_at, a.id LIMIT ${MAX_LIST}`,
      [tenantId, todayStart, todayEnd],
    );
    const counts = await db.query(
      `SELECT count(*) FILTER (WHERE starts_at >= $2 AND starts_at < $3)::int AS today,
              count(*) FILTER (WHERE starts_at >= $3 AND starts_at < $4)::int AS tomorrow,
              count(*) FILTER (WHERE status = 'pendiente' AND starts_at >= $5)::int AS pending
         FROM appointments WHERE tenant_id = $1 AND status IN ('pendiente', 'confirmada') AND starts_at >= $2`,
      [tenantId, todayStart, todayEnd, tomorrowEnd, now],
    );
    agenda = {
      todayList: list.rows.map((a) => ({ startsAt: new Date(a.starts_at).toISOString(), time: hm(new Date(a.starts_at).getTime(), tz), service: clean(a.service, 120), customer: clean(a.customer_name, 120), status: a.status })),
      todayCount: counts.rows[0].today,
      tomorrowCount: counts.rows[0].tomorrow,
      pendingConfirm: counts.rows[0].pending,
    };
  }

  // Pedidos y stock: solo si el negocio tiene algún producto activo.
  let orders: Snapshot["orders"] = null;
  const prod = await db.query("SELECT 1 FROM catalog_products WHERE tenant_id = $1 AND active LIMIT 1", [tenantId]);
  if (prod.rowCount && mods.includes("catalogo")) {
    const pend = await db.query(
      "SELECT currency, count(*)::int AS n, COALESCE(sum(total_minor), 0)::text AS total, count(*) FILTER (WHERE created_at < $2)::int AS old FROM orders WHERE tenant_id = $1 AND status = 'pendiente' GROUP BY currency ORDER BY currency",
      [tenantId, new Date(now.getTime() - 86_400_000)],
    );
    const tod = await db.query(
      "SELECT currency, count(*)::int AS n, COALESCE(sum(total_minor), 0)::text AS total FROM orders WHERE tenant_id = $1 AND status <> 'cancelado' AND created_at >= $2 AND created_at < $3 GROUP BY currency ORDER BY currency",
      [tenantId, todayStart, todayEnd],
    );
    const low = await db.query(
      `SELECT name, stock FROM catalog_products WHERE tenant_id = $1 AND active AND stock IS NOT NULL AND stock > 0 AND stock <= $2 ORDER BY stock, lower(name) LIMIT 10`,
      [tenantId, LOW_STOCK_LIMIT],
    );
    const out = await db.query("SELECT count(*)::int AS n FROM catalog_products WHERE tenant_id = $1 AND active AND stock = 0", [tenantId]);
    orders = {
      pending: pend.rows.reduce((s, r) => s + r.n, 0),
      pendingOlderThan24h: pend.rows.reduce((s, r) => s + r.old, 0),
      pendingTotals: money(pend.rows),
      todayTotals: money(tod.rows),
      lowStock: low.rows.map((p) => ({ name: clean(p.name, 120), stock: p.stock })),
      soldOutCount: out.rows[0].n,
    };
  }

  return {
    generatedAt: now.toISOString(),
    timezone: tz,
    today,
    messages: { inToday: mIn?.today ?? 0, outToday: mOut?.today ?? 0, inYesterday: mIn?.yday ?? 0, outYesterday: mOut?.yday ?? 0, peopleToday: mIn?.people ?? 0 },
    attention: { humanConversations: conv.rows[0].n, openTasks, urgentTasks, overdueTasks, byType },
    agenda,
    orders,
  };
}
