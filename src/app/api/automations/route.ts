import { z } from "zod";
import { requireTenant } from "@/lib/auth/guard";
import { checkOrigin, errorResponse, jsonResponse, readJson, route } from "@/lib/auth/http";
import { withTenant } from "@/lib/db";
import { MAX_RULES, ruleFields, statusOk } from "@/lib/automations/rules";

export const createSchema = z.object(ruleFields);

export const ruleRow = (r: Record<string, unknown>) => ({
  id: r.id, name: r.name, triggerEvent: r.trigger_event, onlyStatus: r.only_status, taskTitle: r.task_title,
  taskPriority: r.task_priority, taskDueMinutes: r.task_due_minutes, active: r.active, runCount: r.run_count, lastRunAt: r.last_run_at,
});

/** Reglas del negocio. */
export const GET = route(async (req) => {
  const auth = await requireTenant(req, "integrations:manage");
  if (!auth.ok) return auth.response;
  const rows = await withTenant(auth.ctx.tenantId, async (db) =>
    (await db.query("SELECT * FROM automation_rules WHERE tenant_id = $1 ORDER BY created_at, id", [auth.ctx.tenantId])).rows);
  return jsonResponse({ max: MAX_RULES, rules: rows.map(ruleRow) });
});

export const POST = route(async (req) => {
  const blocked = checkOrigin(req);
  if (blocked) return blocked;
  const auth = await requireTenant(req, "integrations:manage");
  if (!auth.ok) return auth.response;
  const body = await readJson(req, createSchema);
  if (!body.ok) return body.response;
  const d = body.data;
  const status = d.onlyStatus || null;
  if (!statusOk(d.triggerEvent, status)) return errorResponse(422, "estado_no_valido", "Ese estado no corresponde al aviso elegido.", { fields: ["onlyStatus"] });
  const { tenantId } = auth.ctx;
  try {
    const id = await withTenant(tenantId, async (db) => {
      const r = await db.query(
        "INSERT INTO automation_rules (tenant_id, name, trigger_event, only_status, task_title, task_priority, task_due_minutes, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id",
        [tenantId, d.name, d.triggerEvent, status, d.taskTitle, d.taskPriority, d.taskDueMinutes ?? null, auth.session.userId],
      );
      await db.query("INSERT INTO audit_log (tenant_id, actor_id, action, target_type, metadata) VALUES ($1,$2,'automation.created','automation',$3)", [tenantId, auth.session.userId, JSON.stringify({ ruleId: r.rows[0].id, trigger: d.triggerEvent })]);
      return r.rows[0].id as string;
    });
    return jsonResponse({ id }, 201);
  } catch (e) {
    if ((e as { code?: string }).code === "23514") return errorResponse(409, "limite_reglas", `Llegaste al máximo de ${MAX_RULES} reglas. Borra una para crear otra.`);
    throw e;
  }
});
