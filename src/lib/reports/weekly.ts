import { getPool, withTenant } from "@/lib/db";
import { appLink, enqueueEmail } from "@/lib/email/outbox";
import { emailTemplates } from "@/lib/email/templates";
import { buildReport } from "./build";
import { hasActivity, periodText, reportLines } from "./pure";

/**
 * Manda el reporte de la semana a quienes les toca (lunes por la mañana): dueño y administradores de cada negocio.
 * No manda nada si el negocio apagó el reporte o si no hubo actividad. Nunca lanza.
 */
export async function sendWeeklyReports(max = 20, now: Date = new Date()): Promise<number> {
  let sent = 0;
  try {
    const claimed = await getPool().query<{ out_tenant_id: string; out_week_start: string | Date }>("SELECT * FROM report_claim($1)", [max]);
    for (const c of claimed.rows) {
      try {
        const week = new Date(c.out_week_start).toISOString().slice(0, 10);
        const data = await withTenant(c.out_tenant_id, async (db) => {
          const s = await db.query<{ weekly_report: boolean }>("SELECT weekly_report FROM team_settings WHERE tenant_id = $1", [c.out_tenant_id]);
          if (s.rows[0]?.weekly_report === false) return null;
          const name = (await db.query<{ name: string }>("SELECT name FROM tenants WHERE id = $1", [c.out_tenant_id])).rows[0]?.name ?? "tu negocio";
          return { name, report: await buildReport(db, c.out_tenant_id, 7, now) };
        });
        if (!data || !hasActivity(data.report)) continue;
        const to = await getPool().query<{ out_email: string }>("SELECT out_email FROM handoff_recipients($1, NULL)", [c.out_tenant_id]);
        const msg = emailTemplates.weeklyReport({ business: data.name, period: periodText(data.report), lines: reportLines(data.report), url: appLink("/reportes") });
        for (const r of to.rows) {
          if (await enqueueEmail(r.out_email, msg, { tenantId: c.out_tenant_id, dedupeKey: `reporte:${week}:${c.out_tenant_id}:${r.out_email}` })) sent++;
        }
      } catch (err) {
        console.error("[reportes] semanal falló:", err instanceof Error ? err.message : err);
      }
    }
  } catch (err) {
    console.error("[reportes] no se pudo revisar:", err instanceof Error ? err.message : err);
  }
  return sent;
}
