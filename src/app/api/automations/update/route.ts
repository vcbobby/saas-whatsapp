import { z } from "zod";
import { requireTenant } from "@/lib/auth/guard";
import { checkOrigin, errorResponse, jsonResponse, readJson, route } from "@/lib/auth/http";
import { withTenant } from "@/lib/db";
import { actionError, offsetFor, ruleFields, statusOk } from "@/lib/automations/rules";

const schema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("toggle"), id: z.uuid(), active: z.boolean() }),
  z.object({ action: z.literal("edit"), id: z.uuid(), ...ruleFields }),
  z.object({ action: z.literal("delete"), id: z.uuid() }),
]);

/** Activar/desactivar, editar o borrar una regla. */
export const POST = route(async (req) => {
  const blocked = checkOrigin(req);
  if (blocked) return blocked;
  const auth = await requireTenant(req, "integrations:manage");
  if (!auth.ok) return auth.response;
  const body = await readJson(req, schema);
  if (!body.ok) return body.response;
  const { tenantId } = auth.ctx;
  const actor = auth.session.userId;
  const d = body.data;
  if (d.action === "edit" && !statusOk(d.triggerEvent, d.onlyStatus || null)) return errorResponse(422, "estado_no_valido", "Ese estado no corresponde al aviso elegido.", { fields: ["onlyStatus"] });
  if (d.action === "edit") {
    const aerr = actionError(d);
    if (aerr) return errorResponse(422, "accion_no_valida", aerr, { fields: ["messageTemplate"] });
  }
  const found = await withTenant(tenantId, async (db) => {
    let n = 0;
    if (d.action === "toggle") n = (await db.query("UPDATE automation_rules SET active = $3, updated_at = now() WHERE tenant_id = $1 AND id = $2", [tenantId, d.id, d.active])).rowCount ?? 0;
    else if (d.action === "edit") n = (await db.query(
      "UPDATE automation_rules SET name = $3, trigger_event = $4, only_status = $5, task_title = $6, task_priority = $7, task_due_minutes = $8, action_type = $9, message_template = $10, offset_minutes = $11, updated_at = now() WHERE tenant_id = $1 AND id = $2",
      [tenantId, d.id, d.name, d.triggerEvent, d.onlyStatus || null, d.taskTitle, d.taskPriority, d.taskDueMinutes ?? null, d.actionType, d.actionType === "mensaje" ? d.messageTemplate!.trim() : null, offsetFor(d)])).rowCount ?? 0;
    else n = (await db.query("DELETE FROM automation_rules WHERE tenant_id = $1 AND id = $2", [tenantId, d.id])).rowCount ?? 0;
    if (n === 1) await db.query("INSERT INTO audit_log (tenant_id, actor_id, action, target_type, metadata) VALUES ($1,$2,$3,'automation',$4)", [tenantId, actor, `automation.${d.action === "toggle" ? "toggled" : d.action === "edit" ? "updated" : "deleted"}`, JSON.stringify({ ruleId: d.id })]);
    return n === 1;
  });
  return found ? jsonResponse({ ok: true }) : errorResponse(404, "no_existe", "Esa regla ya no existe.");
});
