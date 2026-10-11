import { z } from "zod";
import { requireTenant } from "@/lib/auth/guard";
import { checkOrigin, errorResponse, jsonResponse, readJson, route } from "@/lib/auth/http";
import { withTenant } from "@/lib/db";

const schema = z.object({
  id: z.uuid(),
  action: z.enum(["start", "resolve", "dismiss", "reopen", "take", "release"]),
});

const OPEN = ["abierto", "en_proceso"];

/** Cambios sobre una tarea: empezar, resolver, descartar, reabrir, tomarla o soltarla. */
export const POST = route(async (req) => {
  const blocked = checkOrigin(req);
  if (blocked) return blocked;
  const auth = await requireTenant(req, "conversations:reply");
  if (!auth.ok) return auth.response;
  const body = await readJson(req, schema);
  if (!body.ok) return body.response;
  const { tenantId } = auth.ctx;
  const { id, action } = body.data;
  const me = auth.session.userId;

  const outcome = await withTenant(tenantId, async (db) => {
    await db.query("SELECT set_config('app.actor', $1, true)", [me]);
    const cur = await db.query<{ status: string }>("SELECT status FROM work_items WHERE tenant_id = $1 AND id = $2 FOR UPDATE", [tenantId, id]);
    if (cur.rowCount !== 1) return "no_existe" as const;
    const status = cur.rows[0]!.status;
    const isOpen = OPEN.includes(status);

    switch (action) {
      case "start":
        if (status !== "abierto") return "transicion" as const;
        await db.query("UPDATE work_items SET status = 'en_proceso', assigned_to = COALESCE(assigned_to, $3) WHERE tenant_id = $1 AND id = $2", [tenantId, id, me]);
        return "ok" as const;
      case "resolve":
      case "dismiss":
        if (!isOpen) return "transicion" as const;
        await db.query(
          "UPDATE work_items SET status = $3, resolved_at = now(), resolved_by = $4 WHERE tenant_id = $1 AND id = $2",
          [tenantId, id, action === "resolve" ? "resuelto" : "descartado", me],
        );
        return "ok" as const;
      case "reopen":
        if (isOpen) return "transicion" as const;
        await db.query("UPDATE work_items SET status = 'abierto', resolved_at = NULL, resolved_by = NULL WHERE tenant_id = $1 AND id = $2", [tenantId, id]);
        return "ok" as const;
      case "take":
        if (!isOpen) return "transicion" as const;
        await db.query("UPDATE work_items SET assigned_to = $3 WHERE tenant_id = $1 AND id = $2", [tenantId, id, me]);
        return "ok" as const;
      case "release":
        if (!isOpen) return "transicion" as const;
        await db.query("UPDATE work_items SET assigned_to = NULL WHERE tenant_id = $1 AND id = $2", [tenantId, id]);
        return "ok" as const;
    }
  }).catch((err: { code?: string }) => {
    // Reabrir una "atención personal" cuando ya hay otra abierta para la misma conversación.
    if (err.code === "23505") return "duplicada" as const;
    throw err;
  });

  if (outcome === "no_existe") return errorResponse(404, "no_encontrado", "No encontrado.");
  if (outcome === "transicion") return errorResponse(409, "transicion_invalida", "Esa tarea ya cambió. Actualiza la lista.");
  if (outcome === "duplicada") return errorResponse(409, "tarea_duplicada", "Ya hay otra tarea abierta para esta conversación.");
  return jsonResponse({ ok: true });
});
