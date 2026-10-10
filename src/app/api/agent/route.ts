import { withTenant } from "@/lib/db";
import { requireTenant } from "@/lib/auth/guard";
import { checkOrigin, jsonResponse, readJson, route } from "@/lib/auth/http";
import { agentSettingsSchema } from "@/lib/auth/validation";

/** Guarda la configuración del asistente del negocio (encender/apagar, nombre e instrucciones). */
export const PUT = route(async (req) => {
  const blocked = checkOrigin(req);
  if (blocked) return blocked;
  const auth = await requireTenant(req, "agent:manage");
  if (!auth.ok) return auth.response;
  const body = await readJson(req, agentSettingsSchema);
  if (!body.ok) return body.response;
  const { enabled, assistantName, instructions } = body.data;
  const tenantId = auth.ctx.tenantId;

  // Sin caracteres de control (salvo salto de línea y tabulación): el texto acaba dentro de un prompt.
  const clean = instructions.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "");

  await withTenant(tenantId, async (db) => {
    await db.query(
      `INSERT INTO tenant_agents (tenant_id, enabled, assistant_name, instructions, updated_at, updated_by)
       VALUES ($1, $2, $3, $4, now(), $5)
       ON CONFLICT (tenant_id) DO UPDATE
         SET enabled = EXCLUDED.enabled, assistant_name = EXCLUDED.assistant_name,
             instructions = EXCLUDED.instructions, updated_at = now(), updated_by = EXCLUDED.updated_by`,
      [tenantId, enabled, assistantName, clean, auth.session.userId],
    );
    // En la auditoría va solo el tamaño, no el contenido de las instrucciones.
    await db.query(
      `INSERT INTO audit_log (tenant_id, actor_id, action, target_type, metadata)
       VALUES ($1, $2, 'agent.updated', 'agent', $3)`,
      [tenantId, auth.session.userId, JSON.stringify({ enabled, instructionsLength: clean.length })],
    );
  });
  return jsonResponse({ ok: true });
});
