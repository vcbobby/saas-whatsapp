import { z } from "zod";
import { requireTenant } from "@/lib/auth/guard";
import { checkOrigin, errorResponse, jsonResponse, readJson, route } from "@/lib/auth/http";
import { withTenant } from "@/lib/db";
import { MANUAL_WORK_TYPES } from "@/lib/work/labels";

const MAX_OPEN_MANUAL = 500;

const createSchema = z.object({
  type: z.enum(MANUAL_WORK_TYPES),
  title: z.string().trim().min(1, "Escribe un título").max(200, "Máximo 200 caracteres"),
  detail: z.string().trim().max(2000, "Máximo 2000 caracteres").optional(),
  priority: z.number().int().min(1).max(3).default(2),
  dueAt: z.iso.datetime({ offset: true }).optional(),
  conversationId: z.uuid().optional(),
});

/** Lista de tareas: lo pendiente (ordenado por urgencia) o lo ya resuelto. */
export const GET = route(async (req) => {
  const auth = await requireTenant(req, "conversations:read");
  if (!auth.ok) return auth.response;
  const { tenantId } = auth.ctx;
  const done = new URL(req.url).searchParams.get("scope") === "done";

  const data = await withTenant(tenantId, async (db) => {
    const items = await db.query(
      `SELECT w.id, w.type, w.status, w.priority, w.title, w.detail, w.due_at, w.conversation_id, w.source,
              w.assigned_to, w.created_at, w.updated_at, w.resolved_at,
              COALESCE(NULLIF(c.display_name, ''), '+' || c.wa_id) AS contact_name
         FROM work_items w
         LEFT JOIN contacts c ON c.tenant_id = w.tenant_id AND c.id = w.contact_id
        WHERE w.tenant_id = $1 AND ${done ? "w.status IN ('resuelto', 'descartado')" : "w.status IN ('abierto', 'en_proceso')"}
        ORDER BY ${done ? "w.resolved_at DESC" : "w.priority, w.due_at NULLS LAST, w.created_at"}
        LIMIT ${done ? 50 : 200}`,
      [tenantId],
    );
    const counts = await db.query(
      "SELECT type, count(*)::int AS n FROM work_items WHERE tenant_id = $1 AND status IN ('abierto', 'en_proceso') GROUP BY type",
      [tenantId],
    );
    return { items: items.rows, counts: Object.fromEntries(counts.rows.map((r) => [r.type, r.n])) };
  });

  return jsonResponse({
    me: auth.session.userId,
    counts: data.counts,
    items: data.items.map((w) => ({
      id: w.id,
      type: w.type,
      status: w.status,
      priority: w.priority,
      title: w.title,
      detail: w.detail,
      dueAt: w.due_at,
      conversationId: w.conversation_id,
      source: w.source,
      assignedToMe: w.assigned_to === auth.session.userId,
      assigned: !!w.assigned_to,
      contactName: w.contact_name,
      createdAt: w.created_at,
      resolvedAt: w.resolved_at,
    })),
  });
});

/** Crear una tarea a mano. */
export const POST = route(async (req) => {
  const blocked = checkOrigin(req);
  if (blocked) return blocked;
  const auth = await requireTenant(req, "conversations:reply");
  if (!auth.ok) return auth.response;
  const body = await readJson(req, createSchema);
  if (!body.ok) return body.response;
  const { tenantId } = auth.ctx;
  const d = body.data;

  const result = await withTenant(tenantId, async (db) => {
    await db.query("SELECT set_config('app.actor', $1, true)", [auth.session.userId]);
    const open = await db.query(
      "SELECT count(*)::int AS n FROM work_items WHERE tenant_id = $1 AND source = 'manual' AND status IN ('abierto', 'en_proceso')",
      [tenantId],
    );
    if (open.rows[0].n >= MAX_OPEN_MANUAL) return "limite" as const;

    let contactId: string | null = null;
    if (d.conversationId) {
      const c = await db.query("SELECT contact_id FROM conversations WHERE tenant_id = $1 AND id = $2", [tenantId, d.conversationId]);
      if (c.rowCount !== 1) return "sin_conversacion" as const;
      contactId = c.rows[0].contact_id;
    }
    const r = await db.query(
      `INSERT INTO work_items (tenant_id, type, priority, title, detail, due_at, conversation_id, contact_id, source, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'manual', $9) RETURNING id`,
      [tenantId, d.type, d.priority, d.title, d.detail || null, d.dueAt ?? null, d.conversationId ?? null, contactId, auth.session.userId],
    );
    return r.rows[0].id as string;
  });

  if (result === "limite") return errorResponse(409, "limite_tareas", `Tienes ${MAX_OPEN_MANUAL} tareas manuales pendientes. Resuelve algunas antes de crear más.`);
  if (result === "sin_conversacion") return errorResponse(404, "no_encontrado", "No encontrado.");
  return jsonResponse({ ok: true, id: result }, 201);
});
