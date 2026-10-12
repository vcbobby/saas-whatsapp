import { z } from "zod";
import { requireTenant } from "@/lib/auth/guard";
import { checkOrigin, jsonResponse, readJson, route } from "@/lib/auth/http";
import { withTenant } from "@/lib/db";
import { isValidTimeZone } from "@/lib/agenda/tz";

const schema = z.object({
  timezone: z.string().trim().refine(isValidTimeZone, "Zona horaria no válida (ejemplo: America/Caracas)"),
  minNoticeMinutes: z.number().int().min(0).max(10080),
  maxDaysAhead: z.number().int().min(1).max(365),
  slotStepMinutes: z.number().int().refine((n) => [5, 10, 15, 20, 30, 45, 60].includes(n), "Elige 5, 10, 15, 20, 30, 45 o 60 minutos"),
});

export const PUT = route(async (req) => {
  const blocked = checkOrigin(req);
  if (blocked) return blocked;
  const auth = await requireTenant(req, "agenda:manage");
  if (!auth.ok) return auth.response;
  const body = await readJson(req, schema);
  if (!body.ok) return body.response;
  const d = body.data;
  const { tenantId } = auth.ctx;
  await withTenant(tenantId, async (db) => {
    await db.query(
      `INSERT INTO agenda_settings (tenant_id, timezone, min_notice_minutes, max_days_ahead, slot_step_minutes, updated_by)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (tenant_id) DO UPDATE SET timezone = EXCLUDED.timezone, min_notice_minutes = EXCLUDED.min_notice_minutes,
         max_days_ahead = EXCLUDED.max_days_ahead, slot_step_minutes = EXCLUDED.slot_step_minutes, updated_at = now(), updated_by = EXCLUDED.updated_by`,
      [tenantId, d.timezone, d.minNoticeMinutes, d.maxDaysAhead, d.slotStepMinutes, auth.session.userId],
    );
    await db.query("INSERT INTO audit_log (tenant_id, actor_id, action, target_type, metadata) VALUES ($1, $2, 'agenda.settings', 'agenda', $3)", [tenantId, auth.session.userId, JSON.stringify(d)]);
  });
  return jsonResponse({ ok: true });
});
