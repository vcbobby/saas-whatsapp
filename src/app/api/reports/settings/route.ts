import { z } from "zod";
import { requireTenant } from "@/lib/auth/guard";
import { checkOrigin, jsonResponse, readJson, route } from "@/lib/auth/http";
import { withTenant } from "@/lib/db";

const schema = z.object({ weekly: z.boolean() });

/** Enciende o apaga el correo semanal del negocio. */
export const POST = route(async (req) => {
  const blocked = checkOrigin(req);
  if (blocked) return blocked;
  const auth = await requireTenant(req, "reports:read");
  if (!auth.ok) return auth.response;
  const body = await readJson(req, schema);
  if (!body.ok) return body.response;
  const { tenantId } = auth.ctx;
  await withTenant(tenantId, async (db) => {
    await db.query(
      `INSERT INTO team_settings (tenant_id, weekly_report) VALUES ($1, $2)
       ON CONFLICT (tenant_id) DO UPDATE SET weekly_report = EXCLUDED.weekly_report, updated_at = now()`, [tenantId, body.data.weekly]);
    await db.query("INSERT INTO audit_log (tenant_id, actor_id, action, target_type, metadata) VALUES ($1, $2, 'reports.weekly', 'tenant', $3::jsonb)", [tenantId, auth.session.userId, JSON.stringify(body.data)]);
  });
  return jsonResponse({ ok: true });
});
