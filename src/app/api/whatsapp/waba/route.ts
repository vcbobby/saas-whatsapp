import { z } from "zod";
import { requireTenant } from "@/lib/auth/guard";
import { checkOrigin, errorResponse, jsonResponse, readJson, route } from "@/lib/auth/http";
import { withTenant } from "@/lib/db";
import { loadIntegration } from "@/lib/whatsapp/integration";
import { explainTemplateError, wabaOwnsPhone } from "@/lib/whatsapp/templates";

const schema = z.object({ wabaId: z.string().max(60) });

/** Guarda el ID de la cuenta de WhatsApp Business (WABA) después de comprobar con Meta que el número conectado pertenece a esa cuenta. */
export const POST = route(async (req) => {
  const blocked = checkOrigin(req);
  if (blocked) return blocked;
  const auth = await requireTenant(req, "integrations:manage");
  if (!auth.ok) return auth.response;
  const body = await readJson(req, schema);
  if (!body.ok) return body.response;
  const wabaId = body.data.wabaId.trim().replace(/[\s.]/g, "");
  if (!/^\d{5,30}$/.test(wabaId)) return errorResponse(400, "id_no_valido", "El ID de la cuenta son solo dígitos. Está en Meta → WhatsApp → Configuración de la API, junto a «WhatsApp Business Account ID».", { fields: ["wabaId"] });
  const tenantId = auth.ctx.tenantId;
  const conn = await loadIntegration(tenantId);
  if (!conn) return errorResponse(409, "sin_whatsapp", "Primero conecta tu número de WhatsApp.");
  const r = await wabaOwnsPhone(wabaId, conn.phoneNumberId, conn.accessToken);
  if (!r.ok) return errorResponse(400, "meta_rechazo", explainTemplateError(r.error, "network" in r ? r.network : undefined), { fields: ["wabaId"] });
  if (!r.data) return errorResponse(400, "waba_no_coincide", "Ese ID de cuenta no contiene el número que conectaste. Revisa que sea el «WhatsApp Business Account ID» del mismo número.", { fields: ["wabaId"] });
  await withTenant(tenantId, async (db) => {
    await db.query("UPDATE tenant_integrations SET waba_id = $2 WHERE tenant_id = $1 AND provider = 'whatsapp'", [tenantId, wabaId]);
    await db.query("INSERT INTO audit_log (tenant_id, actor_id, action, target_type, metadata) VALUES ($1,$2,'whatsapp.waba_set','integration',$3)", [tenantId, auth.session.userId, JSON.stringify({ wabaId })]);
  });
  return jsonResponse({ ok: true });
}, { limit: "templates" });
