import { z } from "zod";
import { requireTenant } from "@/lib/auth/guard";
import { checkOrigin, errorResponse, jsonResponse, readJson, route } from "@/lib/auth/http";
import { withTenant } from "@/lib/db";
import { CONTACT_LABELS } from "@/lib/work/labels";

const schema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("take"), id: z.uuid() }),
  z.object({ action: z.literal("release"), id: z.uuid() }),
  z.object({ action: z.literal("close"), id: z.uuid() }),
  z.object({ action: z.literal("label"), id: z.uuid(), label: z.enum(CONTACT_LABELS) }),
]);

/**
 * Tomar la conversación (el asistente deja de responder), devolverla al asistente, cerrarla,
 * o clasificar al contacto. La tarea de "atención personal" se crea y se cierra sola (trigger de la base).
 */
export const POST = route(async (req) => {
  const blocked = checkOrigin(req);
  if (blocked) return blocked;
  const auth = await requireTenant(req, "conversations:reply");
  if (!auth.ok) return auth.response;
  const body = await readJson(req, schema);
  if (!body.ok) return body.response;
  const { tenantId } = auth.ctx;
  const d = body.data;
  const me = auth.session.userId;

  const outcome = await withTenant(tenantId, async (db) => {
    await db.query("SELECT set_config('app.actor', $1, true)", [me]);
    const cur = await db.query<{ status: string; contact_id: string }>(
      "SELECT status, contact_id FROM conversations WHERE tenant_id = $1 AND id = $2 FOR UPDATE",
      [tenantId, d.id],
    );
    if (cur.rowCount !== 1) return "no_existe" as const;
    const { status, contact_id: contactId } = cur.rows[0]!;

    switch (d.action) {
      case "label":
        await db.query("UPDATE contacts SET label = $3 WHERE tenant_id = $1 AND id = $2", [tenantId, contactId, d.label]);
        return "ok" as const;
      case "take":
        if (status === "closed") return "cerrada" as const;
        // Desde "bot": pasa a una persona. Desde "human": solo queda asignada a quien la toma.
        await db.query(
          `UPDATE conversations SET status = 'human', assigned_to = $3,
                  handoff_reason = CASE WHEN status = 'bot' THEN 'tomada_por_persona' ELSE handoff_reason END
            WHERE tenant_id = $1 AND id = $2`,
          [tenantId, d.id, me],
        );
        return "ok" as const;
      case "release":
        if (status !== "human") return "estado" as const;
        await db.query("UPDATE conversations SET status = 'bot', assigned_to = NULL, handoff_reason = NULL WHERE tenant_id = $1 AND id = $2", [tenantId, d.id]);
        return "ok" as const;
      case "close":
        if (status === "closed") return "ok" as const;
        await db.query("UPDATE conversations SET status = 'closed' WHERE tenant_id = $1 AND id = $2", [tenantId, d.id]);
        return "ok" as const;
    }
  });

  if (outcome === "no_existe") return errorResponse(404, "no_encontrado", "No encontrado.");
  if (outcome === "cerrada") return errorResponse(409, "conversacion_cerrada", "La conversación está cerrada.");
  if (outcome === "estado") return errorResponse(409, "estado_invalido", "La conversación ya cambió. Actualiza la lista.");
  return jsonResponse({ ok: true });
});
