import { z } from "zod";
import { requireTenant } from "@/lib/auth/guard";
import { checkOrigin, errorResponse, jsonResponse, readJson, route } from "@/lib/auth/http";
import { withTenant } from "@/lib/db";
import { audienceSchema } from "@/lib/broadcasts/audience";
import { paramSchema, templateProblem } from "@/lib/broadcasts/template";

/** Lista de difusiones con sus cifras básicas. */
export const GET = route(async (req) => {
  const auth = await requireTenant(req, "broadcasts:manage");
  if (!auth.ok) return auth.response;
  const { tenantId } = auth.ctx;
  const rows = await withTenant(tenantId, async (db) => (await db.query(
    `SELECT b.id, b.name, b.status, b.pause_reason, b.total, b.created_at, b.started_at, b.finished_at,
            count(r.*) FILTER (WHERE r.status = 'enviado')::int AS sent,
            count(r.*) FILTER (WHERE r.status = 'fallido')::int AS failed,
            count(r.*) FILTER (WHERE r.status = 'pendiente')::int AS pending
       FROM broadcasts b LEFT JOIN broadcast_recipients r ON r.tenant_id = b.tenant_id AND r.broadcast_id = b.id
      WHERE b.tenant_id = $1 GROUP BY b.id ORDER BY b.created_at DESC LIMIT 100`, [tenantId])).rows);
  return jsonResponse({
    broadcasts: rows.map((b) => ({ id: b.id, name: b.name, status: b.status, pauseReason: b.pause_reason, total: b.total, sent: b.sent, failed: b.failed, pending: b.pending, createdAt: b.created_at, startedAt: b.started_at, finishedAt: b.finished_at })),
  });
});

const createSchema = z.object({
  name: z.string().trim().min(1, "Ponle un nombre").max(80, "Máximo 80 caracteres"),
  templateId: z.uuid(),
  params: z.array(paramSchema).max(10),
  audience: audienceSchema,
});

/** Crea una difusión en borrador (todavía no se envía nada). */
export const POST = route(async (req) => {
  const blocked = checkOrigin(req);
  if (blocked) return blocked;
  const auth = await requireTenant(req, "broadcasts:manage");
  if (!auth.ok) return auth.response;
  const body = await readJson(req, createSchema);
  if (!body.ok) return body.response;
  const { tenantId } = auth.ctx;
  const d = body.data;
  const out = await withTenant(tenantId, async (db) => {
    const t = (await db.query<{ name: string; language: string; body: string; status: string; sendable: boolean }>("SELECT name, language, body, status, sendable FROM whatsapp_templates WHERE tenant_id = $1 AND id = $2", [tenantId, d.templateId])).rows[0];
    const problem = templateProblem(t, d.params);
    if (problem || !t) return { problem: problem ?? "Elige una plantilla." };
    if (d.audience.from) {
      const ok = await db.query("SELECT 1 FROM broadcasts WHERE tenant_id = $1 AND id = $2", [tenantId, d.audience.from.broadcastId]);
      if (ok.rowCount !== 1) return { problem: "La difusión de origen no existe." };
    }
    const r = await db.query<{ id: string }>(
      `INSERT INTO broadcasts (tenant_id, name, template_name, template_language, template_text, params, audience, created_by)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8) RETURNING id`,
      [tenantId, d.name, t.name, t.language, t.body, JSON.stringify(d.params), JSON.stringify(d.audience), auth.session.userId]);
    await db.query("INSERT INTO audit_log (tenant_id, actor_id, action, target_type, target_id) VALUES ($1, $2, 'broadcast.created', 'broadcast', $3)", [tenantId, auth.session.userId, r.rows[0]!.id]);
    return { id: r.rows[0]!.id };
  });
  if ("problem" in out) return errorResponse(400, "datos_invalidos", out.problem!);
  return jsonResponse({ ok: true, id: out.id }, 201);
});
