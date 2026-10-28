import { z } from "zod";
import { requireTenant } from "@/lib/auth/guard";
import { checkOrigin, errorResponse, jsonResponse, readJson, route } from "@/lib/auth/http";
import { withTenant } from "@/lib/db";
import { MAX_RULES, actionError, offsetFor, ruleFields, statusOk, templateRuleError } from "@/lib/automations/rules";

export const createSchema = z.object(ruleFields);

export const ruleRow = (r: Record<string, unknown>) => ({
  id: r.id, name: r.name, triggerEvent: r.trigger_event, onlyStatus: r.only_status, taskTitle: r.task_title,
  offsetMinutes: r.offset_minutes, targetEndpointId: r.target_endpoint_id, actionType: r.action_type, messageTemplate: r.message_template, templateId: r.template_id, templateParams: r.template_params, taskPriority: r.task_priority, taskDueMinutes: r.task_due_minutes, active: r.active, runCount: r.run_count, lastRunAt: r.last_run_at,
});

/** Reglas del negocio. */
export const GET = route(async (req) => {
  const auth = await requireTenant(req, "integrations:manage", "automatizaciones");
  if (!auth.ok) return auth.response;
  const rows = await withTenant(auth.ctx.tenantId, async (db) =>
    (await db.query("SELECT * FROM automation_rules WHERE tenant_id = $1 ORDER BY created_at, id", [auth.ctx.tenantId])).rows);
  const notes = await withTenant(auth.ctx.tenantId, async (db) =>
    (await db.query(
      `SELECT n.id, n.rule_id, n.customer_name, n.body, n.status, n.reason, n.attempts, n.created_at, r.name AS rule_name
         FROM customer_notifications n LEFT JOIN automation_rules r ON r.tenant_id = n.tenant_id AND r.id = n.rule_id
        WHERE n.tenant_id = $1 ORDER BY n.created_at DESC, n.id LIMIT 30`, [auth.ctx.tenantId])).rows);
  return jsonResponse({
    max: MAX_RULES,
    rules: rows.map(ruleRow),
    notifications: notes.map((n) => ({ id: n.id, ruleName: n.rule_name, customerName: n.customer_name, body: n.body, status: n.status, reason: n.reason, attempts: n.attempts, createdAt: n.created_at })),
  });
});

export const POST = route(async (req) => {
  const blocked = checkOrigin(req);
  if (blocked) return blocked;
  const auth = await requireTenant(req, "integrations:manage", "automatizaciones");
  if (!auth.ok) return auth.response;
  const body = await readJson(req, createSchema);
  if (!body.ok) return body.response;
  const d = body.data;
  const status = d.onlyStatus || null;
  if (!statusOk(d.triggerEvent, status)) return errorResponse(422, "estado_no_valido", "Ese estado no corresponde al aviso elegido.", { fields: ["onlyStatus"] });
  const aerr = actionError(d);
  if (aerr) return errorResponse(422, "accion_no_valida", aerr, { fields: ["messageTemplate"] });
  const { tenantId } = auth.ctx;
  const useTpl = d.actionType === "mensaje" && !!d.templateId;
  if (useTpl) {
    const tpl = await withTenant(tenantId, async (db) => (await db.query<{ status: string; sendable: boolean; body: string }>("SELECT status, sendable, body FROM whatsapp_templates WHERE id = $1", [d.templateId])).rows[0]);
    const terr = templateRuleError(tpl, d.templateParams);
    if (terr) return errorResponse(422, "plantilla_no_valida", terr, { fields: ["templateId"] });
  }
  try {
    const id = await withTenant(tenantId, async (db) => {
      const r = await db.query(
        "INSERT INTO automation_rules (tenant_id, name, trigger_event, only_status, task_title, task_priority, task_due_minutes, created_by, action_type, message_template, offset_minutes, target_endpoint_id, template_id, template_params) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::jsonb) RETURNING id",
        [tenantId, d.name, d.triggerEvent, status, d.actionType === "app" ? d.name : d.taskTitle, d.taskPriority, d.taskDueMinutes ?? null, auth.session.userId, d.actionType, d.actionType === "tarea" ? null : d.messageTemplate!.trim(), offsetFor(d), d.actionType === "app" ? d.targetEndpointId : null, useTpl ? d.templateId : null, JSON.stringify(useTpl ? d.templateParams : [])],
      );
      await db.query("INSERT INTO audit_log (tenant_id, actor_id, action, target_type, metadata) VALUES ($1,$2,'automation.created','automation',$3)", [tenantId, auth.session.userId, JSON.stringify({ ruleId: r.rows[0].id, trigger: d.triggerEvent })]);
      return r.rows[0].id as string;
    });
    return jsonResponse({ id }, 201);
  } catch (e) {
    if ((e as { code?: string }).code === "23503") return errorResponse(422, "app_no_existe", "Esa app conectada ya no existe. Elige otra.", { fields: ["targetEndpointId"] });
    if ((e as { code?: string }).code === "23514") return errorResponse(409, "limite_reglas", `Llegaste al máximo de ${MAX_RULES} reglas. Borra una para crear otra.`);
    throw e;
  }
});
