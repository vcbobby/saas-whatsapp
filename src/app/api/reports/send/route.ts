import { requireTenant } from "@/lib/auth/guard";
import { checkOrigin, jsonResponse, route } from "@/lib/auth/http";
import { withTenant } from "@/lib/db";
import { appLink, enqueueEmail } from "@/lib/email/outbox";
import { emailTemplates } from "@/lib/email/templates";
import { buildReport } from "@/lib/reports/build";
import { periodText, reportLines } from "@/lib/reports/pure";

/** Manda el reporte de la última semana al correo de quien lo pide (máx. una vez por hora). */
export const POST = route(async (req) => {
  const blocked = checkOrigin(req);
  if (blocked) return blocked;
  const auth = await requireTenant(req, "reports:read");
  if (!auth.ok) return auth.response;
  const { tenantId } = auth.ctx;
  const data = await withTenant(tenantId, async (db) => {
    const name = (await db.query<{ name: string }>("SELECT name FROM tenants WHERE id = $1", [tenantId])).rows[0]?.name ?? "tu negocio";
    return { name, report: await buildReport(db, tenantId, 7) };
  });
  const msg = emailTemplates.weeklyReport({ business: data.name, period: periodText(data.report), lines: reportLines(data.report), url: appLink("/reportes") });
  const hour = new Date().toISOString().slice(0, 13);
  const queued = await enqueueEmail(auth.session.email, msg, { tenantId, dedupeKey: `reporte-ahora:${hour}:${tenantId}:${auth.session.userId}` });
  if (!queued) return jsonResponse({ error: "ya_enviado", message: "Ya te lo enviamos hace poco. Revisa tu correo." }, 429);
  return jsonResponse({ ok: true });
}, { limit: "dataTransfer" });
