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
  const { enabled, assistantName, instructions, businessType, country, tone, emojiLevel, replyLength } = body.data;
  const tenantId = auth.ctx.tenantId;

  // Sin caracteres de control (salvo salto de línea y tabulación): el texto acaba dentro de un prompt.
  const clean = instructions.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "");

  await withTenant(tenantId, async (db) => {
    // Los campos de estilo que no vienen se conservan (o usan el valor por defecto en un negocio nuevo).
    await db.query(
      `INSERT INTO tenant_agents (tenant_id, enabled, assistant_name, instructions, business_type, country, tone, emoji_level, reply_length, updated_at, updated_by)
       VALUES ($1, $2, $3, $4, COALESCE($6, 'atencion'), COALESCE($7, 'VE'), COALESCE($8, 'cercano'), COALESCE($9, 'pocos'), COALESCE($10, 'corta'), now(), $5)
       ON CONFLICT (tenant_id) DO UPDATE
         SET enabled = EXCLUDED.enabled, assistant_name = EXCLUDED.assistant_name,
             instructions = EXCLUDED.instructions,
             business_type = COALESCE($6, tenant_agents.business_type),
             country = COALESCE($7, tenant_agents.country),
             tone = COALESCE($8, tenant_agents.tone),
             emoji_level = COALESCE($9, tenant_agents.emoji_level),
             reply_length = COALESCE($10, tenant_agents.reply_length),
             updated_at = now(), updated_by = EXCLUDED.updated_by`,
      [tenantId, enabled, assistantName, clean, auth.session.userId, businessType ?? null, country ?? null, tone ?? null, emojiLevel ?? null, replyLength ?? null],
    );
    // En la auditoría va solo el tamaño, no el contenido de las instrucciones.
    await db.query(
      `INSERT INTO audit_log (tenant_id, actor_id, action, target_type, metadata)
       VALUES ($1, $2, 'agent.updated', 'agent', $3)`,
      [tenantId, auth.session.userId, JSON.stringify({ enabled, instructionsLength: clean.length, businessType, country, tone, emojiLevel, replyLength })],
    );
  });
  return jsonResponse({ ok: true });
});
