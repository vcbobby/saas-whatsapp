import { z } from "zod";
import { requireTenant } from "@/lib/auth/guard";
import { checkOrigin, errorResponse, jsonResponse, readJson, route } from "@/lib/auth/http";
import { withTenant } from "@/lib/db";
import { sendHumanReply } from "@/lib/conversations/reply";
import { cleanParam, renderBody, variablesOf } from "@/lib/whatsapp/templates";

const schema = z.object({ id: z.uuid(), clientKey: z.uuid(), templateId: z.uuid(), params: z.array(z.string().max(600)).max(10).default([]) });

/** Una persona escribe al cliente con una plantilla aprobada (sirve aunque pasaran más de 24 horas). */
export const POST = route(async (req) => {
  const blocked = checkOrigin(req);
  if (blocked) return blocked;
  const auth = await requireTenant(req, "conversations:reply");
  if (!auth.ok) return auth.response;
  const body = await readJson(req, schema);
  if (!body.ok) return body.response;
  const tenantId = auth.ctx.tenantId;
  const tpl = await withTenant(tenantId, async (db) => (await db.query<{ name: string; language: string; body: string; status: string; sendable: boolean }>("SELECT name, language, body, status, sendable FROM whatsapp_templates WHERE id = $1", [body.data.templateId])).rows[0]);
  if (!tpl) return errorResponse(404, "no_encontrado", "Esa plantilla ya no existe. Actualiza la lista.");
  if (tpl.status !== "APPROVED") return errorResponse(409, "plantilla_no_aprobada", "Esa plantilla todavía no está aprobada por Meta.");
  if (!tpl.sendable) return errorResponse(409, "plantilla_no_soportada", "Esa plantilla tiene encabezado, imágenes o botones con variables; por ahora solo se envían plantillas de texto.");
  const params = body.data.params.map(cleanParam);
  const n = variablesOf(tpl.body).length;
  if (params.length !== n || params.some((p) => p.length === 0)) return errorResponse(400, "datos_invalidos", n === 1 ? "Llena el dato de la plantilla." : `Llena los ${n} datos de la plantilla.`);

  const r = await sendHumanReply({
    tenantId, userId: auth.session.userId, conversationId: body.data.id, clientKey: body.data.clientKey,
    text: renderBody(tpl.body, params), template: { name: tpl.name, language: tpl.language, params },
  });
  switch (r.kind) {
    case "sent": return jsonResponse({ ok: true, messageId: r.messageId, duplicate: r.duplicate });
    case "not_found": return errorResponse(404, "no_encontrado", "No encontrado.");
    case "closed": return errorResponse(409, "conversacion_cerrada", "La conversación está cerrada.");
    case "not_mine": return errorResponse(409, "no_tomada", "Toma la conversación para poder escribir.");
    case "window_closed": return errorResponse(409, "ventana_cerrada", "No se pudo enviar.");
    case "inactive_tenant": return errorResponse(403, "negocio_inactivo", "Tu cuenta no está activa. Renueva tu plan para escribir.");
    case "no_whatsapp": return errorResponse(409, "sin_whatsapp", "Aún no has conectado tu número de WhatsApp.");
    case "key_conflict": return errorResponse(409, "clave_en_uso", "Esa clave de envío ya se usó en otra conversación.");
    case "in_progress": return errorResponse(409, "envio_en_curso", "Este mensaje todavía se está enviando. Espera unos segundos.");
    case "failed": return errorResponse(502, "envio_fallido", r.message);
    case "unknown": return errorResponse(502, "envio_incierto", "No sabemos si WhatsApp recibió el mensaje. Revisa la conversación antes de reenviarlo.");
  }
});
