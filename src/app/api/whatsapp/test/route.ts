import { z } from "zod";
import { requireTenant } from "@/lib/auth/guard";
import { checkOrigin, errorResponse, jsonResponse, readJson, route } from "@/lib/auth/http";
import { withTenant } from "@/lib/db";
import { explainSendError, sendHelloTemplate, sendText } from "@/lib/whatsapp/graph";
import { loadIntegration } from "@/lib/whatsapp/integration";

const schema = z.object({ to: z.string().trim().max(40) });
const MAX_PER_HOUR = 5;

/** Manda un mensaje de prueba al teléfono de la persona para comprobar que el envío funciona de punta a punta. */
export const POST = route(async (req) => {
  const blocked = checkOrigin(req);
  if (blocked) return blocked;
  const auth = await requireTenant(req, "integrations:manage");
  if (!auth.ok) return auth.response;
  const body = await readJson(req, schema);
  if (!body.ok) return body.response;
  const to = body.data.to.replace(/[\s\-().+]/g, "");
  if (!/^\d{8,15}$/.test(to)) return errorResponse(422, "telefono_no_valido", "Escribe el teléfono con código de país y solo números. Ejemplo: 584141234567.", { fields: ["to"] });
  const { tenantId } = auth.ctx;
  const conn = await loadIntegration(tenantId);
  if (!conn) return errorResponse(409, "sin_numero", "Primero conecta un número de WhatsApp.");

  const used = await withTenant(tenantId, async (db) => (await db.query<{ n: number }>("SELECT count(*)::int AS n FROM audit_log WHERE tenant_id = $1 AND action = 'whatsapp.test_sent' AND created_at > now() - interval '1 hour'", [tenantId])).rows[0]!.n);
  if (used >= MAX_PER_HOUR) return errorResponse(429, "demasiadas_pruebas", `Ya hiciste ${MAX_PER_HOUR} pruebas en la última hora. Espera un poco.`);

  const text = "✅ ¡Prueba exitosa! Tu WhatsApp ya está conectado y puede enviar mensajes.";
  let r = await sendText(conn.phoneNumberId, conn.accessToken, to, text);
  let via: "texto" | "plantilla" = "texto";
  // Sin conversación abierta en las últimas 24 h, WhatsApp solo deja enviar una plantilla: se usa «hello_world».
  if (r.kind === "rejected" && (r.code === 131047 || r.code === 131026)) { r = await sendHelloTemplate(conn.phoneNumberId, conn.accessToken, to); via = "plantilla"; }
  await withTenant(tenantId, (db) => db.query("INSERT INTO audit_log (tenant_id, actor_id, action, target_type, metadata) VALUES ($1,$2,'whatsapp.test_sent','integration',$3)", [tenantId, auth.session.userId, JSON.stringify({ result: r.kind, via })]));
  if (r.kind === "sent") return jsonResponse({ ok: true, via });
  if (r.kind === "rejected") return errorResponse(422, "meta_rechazo", explainSendError(r.status, r.code));
  if (r.kind === "retry") return errorResponse(503, "meta_ocupado", "Meta está ocupado o no hay conexión. Inténtalo de nuevo en un momento.");
  return errorResponse(502, "meta_incierto", "No sabemos si el mensaje salió (Meta tardó en responder). Revisa tu teléfono en un minuto antes de reintentar.");
});
