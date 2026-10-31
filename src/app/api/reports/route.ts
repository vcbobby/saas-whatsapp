import { z } from "zod";
import { requireTenant } from "@/lib/auth/guard";
import { jsonResponse, route } from "@/lib/auth/http";
import { withTenant } from "@/lib/db";
import { buildReport } from "@/lib/reports/build";

const days = z.enum(["7", "30"]);

/** Reporte de los últimos 7 o 30 días completos frente al período anterior. */
export const GET = route(async (req) => {
  const auth = await requireTenant(req, "reports:read");
  if (!auth.ok) return auth.response;
  const { tenantId } = auth.ctx;
  const parsed = days.safeParse(new URL(req.url).searchParams.get("dias") ?? "7");
  if (!parsed.success) return jsonResponse({ error: "dias_invalido" }, 400);
  return withTenant(tenantId, async (db) => {
    const report = await buildReport(db, tenantId, Number(parsed.data) as 7 | 30);
    const s = await db.query<{ weekly_report: boolean }>("SELECT weekly_report FROM team_settings WHERE tenant_id = $1", [tenantId]);
    return jsonResponse({ report, weekly: s.rows[0]?.weekly_report ?? true });
  });
}, { limit: "api" });
