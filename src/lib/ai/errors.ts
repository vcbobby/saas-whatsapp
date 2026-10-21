import { withTenant } from "@/lib/db";

/**
 * Anota que una llamada a la IA falló (para el panel de salud del súper admin).
 * Nunca lanza: si esto falla, no debe tapar el error original ni cambiar lo que le pasa al cliente.
 */
export async function recordAiError(tenantId: string, source: "agent" | "copilot"): Promise<void> {
  try {
    const table = source === "agent" ? "agent_usage_daily" : "copilot_usage_daily";
    await withTenant(tenantId, (db) =>
      db.query(
        `INSERT INTO ${table} (tenant_id, day, ai_errors) VALUES ($1, (now() AT TIME ZONE 'utc')::date, 1)
         ON CONFLICT (tenant_id, day) DO UPDATE SET ai_errors = ${table}.ai_errors + 1`,
        [tenantId],
      ),
    );
  } catch (e) {
    console.error("[ia] no se pudo anotar el error:", e instanceof Error ? e.message : e);
  }
}
