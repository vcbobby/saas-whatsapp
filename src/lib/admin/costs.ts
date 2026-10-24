import { z } from "zod";
import { getPool } from "@/lib/db";
import { DEFAULT_AI_GLOBAL_DAILY_TOKEN_LIMIT, getLlmEnv } from "@/lib/env";

const n = z.coerce.number();
const nn = z.coerce.number().nullable();

const guardSchema = z.object({
  blocked: z.boolean(),
  reason: z.enum(["presupuesto", "tokens_dia"]).nullable(),
  spendUsd: n, budgetUsd: nn, budgetPct: n, budgetSet: z.boolean(),
  dayTokens: n, dayLimit: n, dayPct: n, monthIn: n, monthOut: n,
});

const budgetSchema = z.object({
  state: guardSchema,
  alerts: z.array(z.object({ kind: z.enum(["presupuesto_mes", "tokens_dia"]), period: z.string(), level: n, value: n, at: z.string() })),
  top: z.array(z.object({ name: z.string(), tokens: n, spendUsd: n })),
  settings: z.object({ monthlyBudgetUsd: nn, priceInUsdPerMtok: n, priceOutUsdPerMtok: n, dailyTokenLimit: nn }),
  defaultDayLimit: n,
});
export type AdminBudget = z.infer<typeof budgetSchema>;

/** Lo que se puede cambiar desde Administración → Costos. */
export const budgetInputSchema = z.object({
  monthlyBudgetUsd: z.number().positive().max(10_000_000).nullable(),
  priceInUsdPerMtok: z.number().min(0).max(10_000),
  priceOutUsdPerMtok: z.number().min(0).max(10_000),
  dailyTokenLimit: z.number().int().min(1_000).max(1_000_000_000_000).nullable(),
});
export type BudgetInput = z.infer<typeof budgetInputSchema>;

export async function getAdminBudget(tokenHash: Buffer): Promise<AdminBudget> {
  // Si la IA todavía no está configurada en este servidor, la pantalla igual se abre (con el tope por defecto).
  let envLimit = DEFAULT_AI_GLOBAL_DAILY_TOKEN_LIMIT;
  try { envLimit = getLlmEnv().AI_GLOBAL_DAILY_TOKEN_LIMIT; } catch { /* IA sin configurar */ }
  const r = await getPool().query("SELECT admin_ai_budget_get($1, $2) AS b", [tokenHash, envLimit]);
  return budgetSchema.parse(r.rows[0].b);
}

export async function setAdminBudget(tokenHash: Buffer, v: BudgetInput): Promise<void> {
  await getPool().query("SELECT admin_ai_budget_set($1, $2, $3, $4, $5)", [tokenHash, v.monthlyBudgetUsd, v.priceInUsdPerMtok, v.priceOutUsdPerMtok, v.dailyTokenLimit]);
}

export { formatUsd } from "./format";

/** Aviso para el Resumen: solo si algo llegó a la mitad o más. */
export function budgetAttention(s: AdminBudget["state"]): { n: number; text: string; href: string } | null {
  if (s.blocked) return { n: 100, text: s.reason === "presupuesto" ? "% del presupuesto de IA: la IA está en pausa" : "% del tope diario de IA: la IA está en pausa", href: "/admin/costos" };
  const budgetPct = s.budgetSet ? s.budgetPct : 0;
  const worst = Math.max(budgetPct, s.dayPct);
  if (worst < 50) return null;
  return { n: Math.floor(worst), text: budgetPct >= s.dayPct ? "% del presupuesto de IA del mes" : "% del tope diario de IA", href: "/admin/costos" };
}
