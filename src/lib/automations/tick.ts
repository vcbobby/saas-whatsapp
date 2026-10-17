import { getPool, withTenant } from "@/lib/db";

/** Cada cuántos segundos se revisa un negocio con reglas de tiempo. */
export const TICK_EVERY_SECONDS = 30;

/** Revisa las reglas de tiempo de los negocios que toca. Seguro si se repite: cada evento tiene un id fijo y nunca se procesa dos veces. */
export async function tickAutomations(max = 10, everySeconds = TICK_EVERY_SECONDS): Promise<{ tenants: number; events: number }> {
  const claimed = await getPool().query<{ out_tenant_id: string }>("SELECT out_tenant_id FROM time_tick_claim($1, $2)", [max, everySeconds]);
  let events = 0;
  for (const c of claimed.rows) {
    try {
      const n = await withTenant(c.out_tenant_id, async (db) => Number((await db.query<{ n: number }>("SELECT run_time_automations($1) AS n", [c.out_tenant_id])).rows[0]?.n ?? 0));
      events += n;
    } catch (err) {
      console.error("[automatizaciones] revisión por tiempo falló:", err instanceof Error ? err.message : err);
    }
  }
  return { tenants: claimed.rows.length, events };
}
