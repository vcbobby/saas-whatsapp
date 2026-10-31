import { z } from "zod";
import { requireTenant } from "@/lib/auth/guard";
import { checkOrigin, jsonResponse, readJson, route } from "@/lib/auth/http";
import { withTenant } from "@/lib/db";

const MODES = ["manual", "turnos", "menos_carga"] as const;

/** Cómo se reparten las conversaciones que pasan a una persona, y si se avisa por correo. */
export const GET = route(async (req) => {
  const auth = await requireTenant(req, "team:manage");
  if (!auth.ok) return auth.response;
  const { tenantId } = auth.ctx;
  const row = await withTenant(tenantId, async (db) => {
    const s = await db.query<{ assign_mode: string; notify_email: boolean }>("SELECT assign_mode, notify_email FROM team_settings WHERE tenant_id = $1", [tenantId]);
    const m = await db.query<{ agents: number; people: number }>("SELECT count(*) FILTER (WHERE role = 'agent')::int AS agents, count(*)::int AS people FROM memberships WHERE tenant_id = $1", [tenantId]);
    return { s: s.rows[0], m: m.rows[0]! };
  });
  return jsonResponse({ mode: row.s?.assign_mode ?? "manual", notifyEmail: row.s?.notify_email ?? true, agents: row.m.agents, people: row.m.people });
});

const schema = z.object({ mode: z.enum(MODES), notifyEmail: z.boolean() });

export const POST = route(async (req) => {
  const blocked = checkOrigin(req);
  if (blocked) return blocked;
  const auth = await requireTenant(req, "team:manage");
  if (!auth.ok) return auth.response;
  const body = await readJson(req, schema);
  if (!body.ok) return body.response;
  const { tenantId } = auth.ctx;
  await withTenant(tenantId, async (db) => {
    await db.query(
      `INSERT INTO team_settings (tenant_id, assign_mode, notify_email) VALUES ($1, $2, $3)
       ON CONFLICT (tenant_id) DO UPDATE SET assign_mode = EXCLUDED.assign_mode, notify_email = EXCLUDED.notify_email, updated_at = now()`,
      [tenantId, body.data.mode, body.data.notifyEmail],
    );
    await db.query(
      "INSERT INTO audit_log (tenant_id, actor_id, action, target_type, metadata) VALUES ($1, $2, 'team.assignment', 'tenant', $3::jsonb)",
      [tenantId, auth.session.userId, JSON.stringify(body.data)],
    );
  });
  return jsonResponse({ ok: true });
});
