import { z } from "zod";
import { requireTenant } from "@/lib/auth/guard";
import { checkOrigin, errorResponse, jsonResponse, readJson, route } from "@/lib/auth/http";
import { withTenant } from "@/lib/db";
import { isStartFree } from "@/lib/agenda/load";

const schema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("confirm"), id: z.uuid() }),
  z.object({ action: z.literal("cancel"), id: z.uuid() }),
  z.object({ action: z.literal("complete"), id: z.uuid() }),
  z.object({ action: z.literal("no_show"), id: z.uuid() }),
  z.object({ action: z.literal("reschedule"), id: z.uuid(), startsAt: z.iso.datetime({ offset: true }) }),
]);

type Out = "ok" | "no_existe" | "estado" | "futura" | "ocupado";

/** Cambios de estado y reprogramación. Cancelar libera el horario. */
export const POST = route(async (req) => {
  const blocked = checkOrigin(req);
  if (blocked) return blocked;
  const auth = await requireTenant(req, "agenda:book");
  if (!auth.ok) return auth.response;
  const body = await readJson(req, schema);
  if (!body.ok) return body.response;
  const { tenantId } = auth.ctx;
  const d = body.data;

  const out: Out = await withTenant(tenantId, async (db) => {
    const cur = await db.query<{ status: string; starts_at: Date; ends_at: Date }>("SELECT status, starts_at, ends_at FROM appointments WHERE tenant_id = $1 AND id = $2 FOR UPDATE", [tenantId, d.id]);
    if (cur.rowCount !== 1) return "no_existe";
    const a = cur.rows[0]!;
    const active = a.status === "pendiente" || a.status === "confirmada";
    await db.query("SELECT set_config('app.actor', $1, true)", [auth.session.userId]);
    const set = (status: string) => db.query("UPDATE appointments SET status = $3, updated_at = now() WHERE tenant_id = $1 AND id = $2", [tenantId, d.id, status]);
    // La tarea «Confirmar cita» que creó el asistente se cierra sola cuando la persona decide.
    const closeTask = (status: "resuelto" | "descartado") =>
      db.query("UPDATE work_items SET status = $3, resolved_at = now(), resolved_by = $4 WHERE tenant_id = $1 AND dedupe_key = $2 AND status IN ('abierto', 'en_proceso')", [tenantId, `cita:${d.id}`, status, auth.session.userId]);
    try {
      switch (d.action) {
        case "confirm":
          if (a.status !== "pendiente") return "estado";
          await set("confirmada");
          await closeTask("resuelto");
          return "ok";
        case "cancel":
          if (!active) return "estado";
          await set("cancelada");
          await closeTask("descartado");
          return "ok";
        case "complete":
        case "no_show":
          if (a.status !== "confirmada") return "estado";
          if (a.starts_at.getTime() > Date.now()) return "futura";
          await set(d.action === "complete" ? "completada" : "no_asistio");
          return "ok";
        case "reschedule": {
          if (!active) return "estado";
          const minutes = Math.round((a.ends_at.getTime() - a.starts_at.getTime()) / 60_000);
          if (!(await isStartFree(db, tenantId, minutes, d.startsAt, d.id))) return "ocupado";
          const start = new Date(d.startsAt);
          await db.query("UPDATE appointments SET starts_at = $3, ends_at = $4, updated_at = now() WHERE tenant_id = $1 AND id = $2", [tenantId, d.id, start.toISOString(), new Date(start.getTime() + minutes * 60_000).toISOString()]);
          return "ok";
        }
      }
    } catch (e) {
      if ((e as { code?: string }).code === "23P01") return "ocupado";
      throw e;
    }
  });
  if (out === "no_existe") return errorResponse(404, "no_encontrado", "No encontrado.");
  if (out === "estado") return errorResponse(409, "estado_invalido", "La cita ya cambió. Actualiza la pantalla.");
  if (out === "futura") return errorResponse(409, "aun_no_ocurre", "Esa cita todavía no ha pasado.");
  if (out === "ocupado") return errorResponse(409, "horario_no_disponible", "Ese horario ya no está disponible. Elige otro.");
  return jsonResponse({ ok: true });
});
