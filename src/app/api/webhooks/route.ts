import { randomUUID } from "node:crypto";
import { z } from "zod";
import { requireTenant } from "@/lib/auth/guard";
import { checkOrigin, errorResponse, jsonResponse, readJson, route } from "@/lib/auth/http";
import { withTenant } from "@/lib/db";
import { APPS, APP_KINDS, TELEGRAM_CHAT_RE, TELEGRAM_TOKEN_RE, checkAppUrl, isSealed } from "@/lib/connections/apps";
import { sealConfig } from "@/lib/connections/request";
import { TEST_EVENT, WEBHOOK_EVENTS, MAX_ENDPOINTS } from "@/lib/webhooks/events";
import { resolveTarget } from "@/lib/webhooks/guard";
import { displayUrl, newSecret, sealSecret } from "@/lib/webhooks/service";

export const createSchema = z.object({
  kind: z.enum(APP_KINDS).default("webhook"),
  url: z.string().trim().max(2000, "La dirección es demasiado larga").optional(),
  token: z.string().trim().max(200).optional(),
  chatId: z.string().trim().max(30).optional(),
  description: z.string().trim().max(120, "Máximo 120 caracteres").optional(),
  events: z.array(z.enum(WEBHOOK_EVENTS)).min(1, "Elige al menos un aviso").max(WEBHOOK_EVENTS.length).transform((a) => [...new Set(a)]),
});

/** Lo que se muestra en pantalla como «dirección» de las conexiones cuyo enlace es secreto. */
const SEALED_SHOW: Record<string, string> = { telegram: "Telegram (chat conectado)", discord: "Canal de Discord (enlace guardado de forma segura)", slack: "Canal de Slack (enlace guardado de forma segura)" };
const SEALED_URL: Record<string, string> = { telegram: "https://api.telegram.org/", discord: "https://discord.com/api/webhooks", slack: "https://hooks.slack.com/services" };

/** Conexiones del negocio y su registro de envíos recientes. Nunca devuelve secretos. */
export const GET = route(async (req) => {
  const auth = await requireTenant(req, "integrations:manage", "automatizaciones");
  if (!auth.ok) return auth.response;
  const { tenantId } = auth.ctx;
  const data = await withTenant(tenantId, async (db) => {
    const eps = await db.query(
      `SELECT e.id, e.kind, e.url, e.description, e.events, e.active, e.consecutive_failures, e.disabled_reason, e.created_at,
              (SELECT count(*)::int FROM webhook_deliveries d WHERE d.tenant_id = e.tenant_id AND d.endpoint_id = e.id AND d.status = 'pendiente') AS pending
         FROM webhook_endpoints e WHERE e.tenant_id = $1 ORDER BY e.created_at`,
      [tenantId],
    );
    const dels = await db.query(
      `SELECT id, endpoint_id, event_type, status, attempts, last_status, last_error, created_at, finished_at
         FROM webhook_deliveries WHERE tenant_id = $1 ORDER BY created_at DESC, id LIMIT 50`,
      [tenantId],
    );
    return { eps: eps.rows, dels: dels.rows };
  });
  return jsonResponse({
    max: MAX_ENDPOINTS,
    endpoints: data.eps.map((e) => ({ id: e.id, kind: e.kind, url: isSealed(e.kind) ? SEALED_SHOW[e.kind] : displayUrl(e.url), description: e.description, events: e.events, active: e.active, consecutiveFailures: e.consecutive_failures, disabledReason: e.disabled_reason, createdAt: e.created_at, pending: e.pending })),
    deliveries: data.dels.map((d) => ({ id: d.id, endpointId: d.endpoint_id, eventType: d.event_type, status: d.status, attempts: d.attempts, lastStatus: d.last_status, lastError: d.last_error, createdAt: d.created_at, finishedAt: d.finished_at })),
  });
});

/** Crea una conexión. El secreto de firma se devuelve SOLO en esta respuesta. */
export const POST = route(async (req) => {
  const blocked = checkOrigin(req);
  if (blocked) return blocked;
  const auth = await requireTenant(req, "integrations:manage", "automatizaciones");
  if (!auth.ok) return auth.response;
  const body = await readJson(req, createSchema);
  if (!body.ok) return body.response;
  const { tenantId } = auth.ctx;
  const d = body.data;

  // Valida lo que escribió la persona según el tipo de conexión y arma lo que se guardará.
  let storedUrl: string;
  let sealed: { enc: string; keyVersion: number } | null = null;
  const id = randomUUID();
  if (d.kind === "telegram") {
    if (!d.token || !TELEGRAM_TOKEN_RE.test(d.token)) return errorResponse(422, "token_no_valido", "Ese token no parece de un bot de Telegram. Cópialo completo desde @BotFather.", { fields: ["token"] });
    if (!d.chatId || !TELEGRAM_CHAT_RE.test(d.chatId)) return errorResponse(422, "chat_no_valido", "Falta elegir el chat. Escríbele «hola» a tu bot y pulsa «Buscar mi chat».", { fields: ["chatId"] });
    storedUrl = SEALED_URL.telegram!;
    sealed = sealConfig({ token: d.token, chatId: d.chatId }, tenantId, id);
  } else {
    if (!d.url || d.url.length < 10) return errorResponse(422, "url_requerida", `Pega aquí ${APPS[d.kind].field.toLowerCase()}.`, { fields: ["url"] });
    const app = checkAppUrl(d.kind, d.url);
    if (!app.ok) return errorResponse(422, "destino_no_permitido", app.reason, { fields: ["url"] });
    const check = await resolveTarget(app.url);
    if (!check.ok) return errorResponse(422, "destino_no_permitido", check.reason, { fields: ["url"] });
    if (isSealed(d.kind)) { storedUrl = SEALED_URL[d.kind]!; sealed = sealConfig({ url: check.target.url.toString() }, tenantId, id); }
    else storedUrl = check.target.url.toString();
  }
  const description = d.description || APPS[d.kind].name;
  const secret = newSecret();
  const sealedSecret = sealSecret(secret, tenantId, id);
  try {
    await withTenant(tenantId, async (db) => {
      await db.query(
        "INSERT INTO webhook_endpoints (id, tenant_id, url, description, events, secret_enc, key_version, created_by, kind, app_config_enc, app_key_version) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)",
        [id, tenantId, storedUrl, description, d.events, sealedSecret.secretEnc, sealedSecret.keyVersion, auth.session.userId, d.kind, sealed?.enc ?? null, sealed?.keyVersion ?? null],
      );
      // Prueba automática: la persona ve de inmediato que la conexión funciona.
      const testId = randomUUID();
      await db.query("INSERT INTO webhook_deliveries (tenant_id, endpoint_id, event_id, event_type, payload) VALUES ($1,$2,$3,$4,$5)", [tenantId, id, testId, TEST_EVENT,
        JSON.stringify({ id: testId, type: TEST_EVENT, api_version: "2026-10-01", created_at: new Date().toISOString().replace(/\.\d+Z$/, "Z"), data: { message: "Prueba de conexión" } })]);
      await db.query("INSERT INTO audit_log (tenant_id, actor_id, action, target_type, metadata) VALUES ($1,$2,'webhook.created','webhook',$3)", [tenantId, auth.session.userId, JSON.stringify({ endpointId: id, kind: d.kind, events: d.events })]);
    });
  } catch (e) {
    if ((e as { code?: string }).code === "23514") return errorResponse(409, "limite_conexiones", `Llegaste al máximo de ${MAX_ENDPOINTS} conexiones. Borra una para crear otra.`);
    throw e;
  }
  return jsonResponse(d.kind === "webhook" ? { id, secret } : { id }, 201);
});
