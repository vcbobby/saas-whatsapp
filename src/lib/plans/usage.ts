import type { PoolClient } from "pg";

type Db = Pick<PoolClient, "query">;

export const PLAN_MODULES = ["agenda", "catalogo", "copiloto", "automatizaciones"] as const;
export type PlanModule = (typeof PLAN_MODULES)[number];
export const PLAN_MODULE_LABEL: Record<PlanModule, string> = {
  agenda: "Agenda de citas",
  catalogo: "Catálogo y pedidos",
  copiloto: "Copiloto",
  automatizaciones: "Automatizaciones y conexiones",
};

export interface PlanInfo { id: string; slug: string; name: string; maxRepliesMonth: number | null; maxMembers: number; modules: PlanModule[] }
export interface PlanUsage { plan: PlanInfo; repliesThisMonth: number; members: number; pendingInvitations: number }

/** Qué tan cerca está un uso de su tope. «near» = 80 % o más. */
export type QuotaState = "unlimited" | "ok" | "near" | "full";
export function quotaState(used: number, max: number | null): QuotaState {
  if (max === null) return "unlimited";
  if (used >= max) return "full";
  if (max > 0 && used / max >= 0.8) return "near";
  return "ok";
}

export const rowToPlan = (r: Record<string, unknown>): PlanInfo => ({
  id: String(r.id),
  slug: String(r.slug),
  name: String(r.name),
  maxRepliesMonth: r.max_replies_month === null || r.max_replies_month === undefined ? null : Number(r.max_replies_month),
  maxMembers: Number(r.max_members),
  modules: ((r.modules as string[]) ?? []).filter((m): m is PlanModule => (PLAN_MODULES as readonly string[]).includes(m)),
});

/** Respuestas del asistente en el mes calendario actual (UTC). */
export async function repliesThisMonth(db: Db, tenantId: string): Promise<number> {
  const r = await db.query(
    "SELECT COALESCE(sum(replies), 0)::int AS n FROM agent_usage_daily WHERE tenant_id = $1 AND day >= date_trunc('month', now() AT TIME ZONE 'utc')::date",
    [tenantId],
  );
  return Number(r.rows[0].n);
}

export async function loadPlan(db: Db, tenantId: string): Promise<PlanInfo | null> {
  const r = await db.query("SELECT p.* FROM tenants t JOIN plans p ON p.id = t.plan_id WHERE t.id = $1", [tenantId]);
  return r.rows[0] ? rowToPlan(r.rows[0]) : null;
}

export async function loadPlanUsage(db: Db, tenantId: string): Promise<PlanUsage | null> {
  const plan = await loadPlan(db, tenantId);
  if (!plan) return null;
  const used = await repliesThisMonth(db, tenantId);
  const m = await db.query("SELECT count(*)::int AS n FROM memberships WHERE tenant_id = $1", [tenantId]);
  const i = await db.query("SELECT tenant_pending_invitations() AS n"); // la tabla no es legible por la aplicación; la función mira solo el negocio actual
  return { plan, repliesThisMonth: used, members: Number(m.rows[0].n), pendingInvitations: Number(i.rows[0].n) };
}
