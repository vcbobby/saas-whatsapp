import { z } from "zod";
import { requireTenant } from "@/lib/auth/guard";
import { checkOrigin, errorResponse, jsonResponse, readJson, route } from "@/lib/auth/http";
import { withTenant } from "@/lib/db";
import { loadIntegration } from "@/lib/whatsapp/integration";
import { bodyError, createMetaTemplate, explainTemplateError, validName, variablesOf } from "@/lib/whatsapp/templates";

/** Lista las plantillas del negocio (para elegirlas en la bandeja y administrarlas). */
export const GET = route(async (req) => {
  const auth = await requireTenant(req, "conversations:reply");
  if (!auth.ok) return auth.response;
  const tenantId = auth.ctx.tenantId;
  const [conn, rows] = await Promise.all([
    loadIntegration(tenantId).catch(() => null),
    withTenant(tenantId, async (db) => (await db.query("SELECT id, name, language, category, body, examples, sendable, status, reason, updated_at FROM whatsapp_templates ORDER BY name, language")).rows),
  ]);
  return jsonResponse({
    connected: !!conn,
    wabaSet: !!conn?.wabaId,
    templates: rows.map((t) => ({ id: t.id, name: t.name, language: t.language, category: t.category, body: t.body, examples: t.examples, sendable: t.sendable, status: t.status, reason: t.reason, variables: variablesOf(t.body).length, updatedAt: t.updated_at })),
  });
}, { limit: "api" });

const createSchema = z.object({
  name: z.string().max(100),
  language: z.string().regex(/^[a-z]{2,3}(_[A-Z]{2})?$/),
  category: z.enum(["UTILITY", "MARKETING"]),
  body: z.string().max(3000),
  examples: z.array(z.string().max(300)).max(10).default([]),
});

/** Crea una plantilla y la envía a Meta para su revisión (suele tardar de minutos a unas horas). */
export const POST = route(async (req) => {
  const blocked = checkOrigin(req);
  if (blocked) return blocked;
  const auth = await requireTenant(req, "integrations:manage");
  if (!auth.ok) return auth.response;
  const body = await readJson(req, createSchema);
  if (!body.ok) return body.response;
  const { name, language, category } = body.data;
  const text = body.data.body.replace(/\r\n/g, "\n").trim();
  const examples = body.data.examples.map((e) => e.trim());
  if (!validName(name)) return errorResponse(400, "datos_invalidos", "El nombre solo puede tener letras minúsculas sin tildes, números y guion bajo (por ejemplo recordatorio_cita).", { fields: ["name"] });
  const err = bodyError(text, examples);
  if (err) return errorResponse(400, "datos_invalidos", err, { fields: ["body"] });
  const tenantId = auth.ctx.tenantId;
  const conn = await loadIntegration(tenantId);
  if (!conn) return errorResponse(409, "sin_whatsapp", "Primero conecta tu número de WhatsApp.");
  if (!conn.wabaId) return errorResponse(409, "sin_waba", "Falta el ID de tu cuenta de WhatsApp Business (WABA). Agrégalo arriba en esta pantalla.");

  const dup = await withTenant(tenantId, async (db) => (await db.query("SELECT 1 FROM whatsapp_templates WHERE name = $1 AND language = $2", [name, language])).rowCount);
  if (dup) return errorResponse(409, "ya_existe", "Ya tienes una plantilla con ese nombre e idioma.", { fields: ["name"] });

  const r = await createMetaTemplate(conn.wabaId, conn.accessToken, { name, language, category, body: text, examples });
  if (!r.ok) return errorResponse(r.error && r.error.status >= 400 && r.error.status < 500 ? 400 : 502, "meta_rechazo", explainTemplateError(r.error, "network" in r ? r.network : undefined));
  await withTenant(tenantId, async (db) => {
    await db.query(
      `INSERT INTO whatsapp_templates (tenant_id, name, language, category, body, examples, status, meta_id)
       VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8) ON CONFLICT (tenant_id, name, language) DO NOTHING`,
      [tenantId, name, language, category, text, JSON.stringify(examples), r.data.status === "APPROVED" ? "APPROVED" : "PENDING", r.data.id || null],
    );
    await db.query("INSERT INTO audit_log (tenant_id, actor_id, action, target_type, metadata) VALUES ($1,$2,'whatsapp.template_created','template',$3)", [tenantId, auth.session.userId, JSON.stringify({ name, language, category })]);
  });
  return jsonResponse({ ok: true, status: r.data.status }, 201);
}, { limit: "templates" });
