import { getPool, withTenant } from "@/lib/db";
import { getLlmEnv } from "@/lib/env";

/** Estado del presupuesto global de IA (todos los negocios juntos). */
export interface AiGuardState {
  blocked: boolean;
  reason: "presupuesto" | "tokens_dia" | null;
  spendUsd: number;
  budgetUsd: number | null;
  budgetPct: number;
  budgetSet: boolean;
  dayTokens: number;
  dayLimit: number;
  dayPct: number;
  monthIn: number;
  monthOut: number;
}

const num = (v: unknown) => Number(v ?? 0);
export function parseGuardState(j: Record<string, unknown>): AiGuardState {
  return {
    blocked: j.blocked === true,
    reason: j.reason === "presupuesto" || j.reason === "tokens_dia" ? j.reason : null,
    spendUsd: num(j.spendUsd),
    budgetUsd: j.budgetUsd === null || j.budgetUsd === undefined ? null : num(j.budgetUsd),
    budgetPct: num(j.budgetPct),
    budgetSet: j.budgetSet === true,
    dayTokens: num(j.dayTokens),
    dayLimit: num(j.dayLimit),
    dayPct: num(j.dayPct),
    monthIn: num(j.monthIn),
    monthOut: num(j.monthOut),
  };
}

const CACHE_MS = 15_000;
let cache: { at: number; state: AiGuardState } | null = null;
export function resetAiGuardCache() {
  cache = null;
}

/**
 * ¿Se puede gastar IA ahora mismo? Se consulta antes de cada llamada. Si la base de datos no responde, el error sube
 * (el trabajo se reintenta): ante la duda NO se gasta. El resultado se guarda 15 s para no consultar en cada mensaje;
 * un estado «bloqueado» no se guarda en caché, así el corte se levanta en cuanto el súper admin sube el tope.
 */
export async function getAiGuard(): Promise<AiGuardState> {
  const now = Date.now();
  if (cache && now - cache.at < CACHE_MS) return cache.state;
  const env = getLlmEnv();
  const r = await getPool().query("SELECT ai_guard_state($1) AS s", [env.AI_GLOBAL_DAILY_TOKEN_LIMIT]);
  const state = parseGuardState(r.rows[0].s as Record<string, unknown>);
  cache = state.blocked ? null : { at: now, state };
  return state;
}

export type AiSource = "agent" | "copilot";
const TABLE: Record<AiSource, string> = { agent: "agent_usage_daily", copilot: "copilot_usage_daily" };

/**
 * Suma los tokens de una llamada a la IA EN EL MOMENTO en que ocurre (no cuando se envía la respuesta): así cuenta
 * aunque después la respuesta se bloquee, falle el envío o el trabajo se reintente.
 */
export async function recordAiUsage(tenantId: string, source: AiSource, input: number, output: number): Promise<void> {
  const table = TABLE[source];
  const i = Math.max(0, Math.trunc(Number.isFinite(input) ? input : 0));
  const o = Math.max(0, Math.trunc(Number.isFinite(output) ? output : 0));
  await withTenant(tenantId, (db) =>
    db.query(
      `INSERT INTO ${table} (tenant_id, day, input_tokens, output_tokens, ai_calls) VALUES ($1, (now() AT TIME ZONE 'utc')::date, $2, $3, 1)
       ON CONFLICT (tenant_id, day) DO UPDATE SET input_tokens = ${table}.input_tokens + EXCLUDED.input_tokens,
         output_tokens = ${table}.output_tokens + EXCLUDED.output_tokens, ai_calls = ${table}.ai_calls + 1`,
      [tenantId, i, o],
    ),
  );
}

/** Tokens gastados por un negocio hoy y en el mes (UTC) en una función. */
export async function tenantTokens(tenantId: string, source: AiSource): Promise<{ day: number; month: number }> {
  const table = TABLE[source];
  return withTenant(tenantId, async (db) => {
    const r = await db.query(
      `SELECT COALESCE(sum(input_tokens + output_tokens) FILTER (WHERE day = (now() AT TIME ZONE 'utc')::date), 0)::float8 AS day,
              COALESCE(sum(input_tokens + output_tokens), 0)::float8 AS month
         FROM ${table} WHERE tenant_id = $1 AND day >= date_trunc('month', now() AT TIME ZONE 'utc')::date`,
      [tenantId],
    );
    return { day: Number(r.rows[0].day), month: Number(r.rows[0].month) };
  });
}

/**
 * Reserva una de las llamadas permitidas para este mensaje (atómico). false = ya se usaron todas:
 * los reintentos de la cola no pueden seguir gastando IA con el mismo mensaje.
 */
export async function reserveMessageCall(tenantId: string, messageId: string, max: number): Promise<boolean> {
  return withTenant(tenantId, async (db) => {
    const r = await db.query("UPDATE messages SET ai_calls = ai_calls + 1 WHERE tenant_id = $1 AND id = $2 AND ai_calls < $3 RETURNING id", [tenantId, messageId, max]);
    return r.rowCount === 1;
  });
}
