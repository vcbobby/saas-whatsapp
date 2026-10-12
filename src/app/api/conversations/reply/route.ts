import { z } from "zod";
import { requireTenant } from "@/lib/auth/guard";
import { checkOrigin, errorResponse, jsonResponse, readJson, route } from "@/lib/auth/http";
import { MAX_REPLY_CHARS, sendHumanReply } from "@/lib/conversations/reply";

const schema = z.object({
  id: z.uuid(),
  clientKey: z.uuid(),
  text: z.string().max(MAX_REPLY_CHARS * 2),
});

/** Una persona responde al cliente por WhatsApp desde la bandeja. */
export const POST = route(async (req) => {
  const blocked = checkOrigin(req);
  if (blocked) return blocked;
  const auth = await requireTenant(req, "conversations:reply");
  if (!auth.ok) return auth.response;
  const body = await readJson(req, schema, { maxChars: MAX_REPLY_CHARS * 2 + 500 });
  if (!body.ok) return body.response;

  const text = body.data.text.replace(/\r\n/g, "\n").trim();
  if (text.length === 0) return errorResponse(400, "datos_invalidos", "Escribe un mensaje.");
  if (text.length > MAX_REPLY_CHARS) return errorResponse(400, "datos_invalidos", `El mensaje es demasiado largo (máximo ${MAX_REPLY_CHARS} caracteres).`);

  const r = await sendHumanReply({ tenantId: auth.ctx.tenantId, userId: auth.session.userId, conversationId: body.data.id, clientKey: body.data.clientKey, text });
  switch (r.kind) {
    case "sent":
      return jsonResponse({ ok: true, messageId: r.messageId, duplicate: r.duplicate });
    case "not_found":
      return errorResponse(404, "no_encontrado", "No encontrado.");
    case "closed":
      return errorResponse(409, "conversacion_cerrada", "La conversación está cerrada.");
    case "not_mine":
      return errorResponse(409, "no_tomada", "Toma la conversación para poder responder. Si la tiene otra persona, tómala desde aquí.");
    case "window_closed":
      return errorResponse(409, "ventana_cerrada", "Pasaron más de 24 horas desde el último mensaje del cliente. WhatsApp solo permite responder con texto libre dentro de ese plazo.");
    case "inactive_tenant":
      return errorResponse(403, "negocio_inactivo", "Tu cuenta no está activa. Renueva tu plan para responder.");
    case "no_whatsapp":
      return errorResponse(409, "sin_whatsapp", "Aún no has conectado tu número de WhatsApp.");
    case "key_conflict":
      return errorResponse(409, "clave_en_uso", "Esa clave de envío ya se usó en otra conversación.");
    case "in_progress":
      return errorResponse(409, "envio_en_curso", "Este mensaje todavía se está enviando. Espera unos segundos.");
    case "failed":
      return errorResponse(502, "envio_fallido", r.message);
    case "unknown":
      return errorResponse(502, "envio_incierto", "No sabemos si WhatsApp recibió el mensaje. Revisa la conversación antes de reenviarlo.");
  }
});
