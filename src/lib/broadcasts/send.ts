import { decryptSecret } from "@/lib/crypto";
import { getPool, withTenant } from "@/lib/db";
import { STALE_SENDING_MS } from "@/lib/conversations/reply";
import type { SendResult } from "@/lib/whatsapp/graph";
import { cleanParam, renderBody, sendTemplate } from "@/lib/whatsapp/templates";

/** Máximo de mensajes de difusión por negocio en 24 horas (Meta limita a los números nuevos; sube el tope cuando tu número crezca). */
export const DAILY_CAP = 250;
/** Mensajes que se envían por negocio en cada vuelta del worker (≈ uno por segundo). */
export const BATCH = 12;
const RETRY_SECONDS = [60, 300] as const;
const MAX_ATTEMPTS = RETRY_SECONDS.length + 1;
/** Si fallan tantos de los últimos envíos, la difusión se pausa sola para proteger el número. */
export const QUALITY_WINDOW = 20;
export const QUALITY_MIN = 10;
export const QUALITY_FAIL_RATE = 0.5;

export interface BroadcastDeps { sendTemplate?: typeof sendTemplate }
export type RecipientOutcome = "sent" | "retry" | "omitted" | "failed" | "skipped";

interface Row {
  id: string; contact_id: string; attempts: number;
  broadcast_status: string; template_name: string; template_language: string; template_text: string; params: unknown;
  wa_id: string; display_name: string | null; off: boolean; consent: boolean; label: string;
}

/** Primer nombre para saludar; si no hay, «cliente». */
export function firstName(display: string | null | undefined): string {
  const w = (display ?? "").replace(/[^\p{L}\p{N}' -]/gu, " ").trim().split(/\s+/)[0] ?? "";
  return w ? w.slice(0, 40) : "cliente";
}

/** Valores de las variables de la plantilla para esta persona. */
export function paramValues(params: unknown, display: string | null | undefined): string[] {
  if (!Array.isArray(params)) return [];
  return params.map((p: { kind?: string; value?: string }) => cleanParam(p?.kind === "nombre" ? firstName(display) : String(p?.value ?? "")) || "-");
}

/** Envía a UNA persona de una difusión. Seguro si se repite: nunca manda dos veces lo mismo. */
export async function sendRecipient(tenantId: string, recipientId: string, deps: BroadcastDeps = {}): Promise<RecipientOutcome> {
  type Go = { kind: "go"; r: Row; attempts: number; messageId: string; phoneId: string; waId: string; secretEnc: string; keyVersion: number; params: string[] };
  type Done = { kind: "done"; outcome: RecipientOutcome };
  // La clave de idempotencia del mensaje es el id del destinatario (uuid único en toda la base).
  const key = recipientId;

  const prepared: Go | Done = await withTenant(tenantId, async (db): Promise<Go | Done> => {
    const q = await db.query<Row & { status: string }>(
      `SELECT r.id, r.contact_id, r.attempts, r.status, b.status AS broadcast_status, b.template_name, b.template_language, b.template_text, b.params,
              c.wa_id, c.display_name, c.notifications_off AS off, (c.promo_consent_at IS NOT NULL) AS consent, c.label
         FROM broadcast_recipients r
         JOIN broadcasts b ON b.tenant_id = r.tenant_id AND b.id = r.broadcast_id
         JOIN contacts c ON c.tenant_id = r.tenant_id AND c.id = r.contact_id
        WHERE r.tenant_id = $1 AND r.id = $2 FOR UPDATE OF r`, [tenantId, recipientId]);
    const r = q.rows[0];
    if (!r || r.status !== "pendiente" || r.broadcast_status !== "enviando") return { kind: "done", outcome: "skipped" };

    const finish = async (status: "omitido" | "fallido", reason: string): Promise<Done> => {
      await db.query("UPDATE broadcast_recipients SET status = $3, reason = $4 WHERE tenant_id = $1 AND id = $2", [tenantId, recipientId, status, reason.slice(0, 300)]);
      return { kind: "done", outcome: status === "omitido" ? "omitted" : "failed" };
    };

    // ¿Ya se intentó este mismo envío? Si el proceso murió a mitad, no se sabe si salió: NO se repite.
    const prev = await db.query<{ id: string; send_state: string; stale: boolean }>(
      "SELECT id, send_state, (send_state = 'sending' AND received_at < now() - ($3 || ' milliseconds')::interval) AS stale FROM messages WHERE tenant_id = $1 AND client_key = $2",
      [tenantId, key, String(STALE_SENDING_MS)]);
    if (prev.rowCount) {
      const m = prev.rows[0]!;
      if (m.send_state === "sending" && !m.stale) return { kind: "done", outcome: "skipped" };
      if (m.send_state === "sent") {
        await db.query("UPDATE broadcast_recipients SET status = 'enviado', message_id = $3, sent_at = now() WHERE tenant_id = $1 AND id = $2", [tenantId, recipientId, m.id]);
        return { kind: "done", outcome: "sent" };
      }
      return finish("fallido", "incierto: el envío se interrumpió y no se sabe si salió");
    }

    // Se vuelve a comprobar todo en el momento de enviar: el permiso, la baja y la atención personal pueden haber cambiado.
    if (!r.consent) return finish("omitido", "sin_permiso");
    if (r.off) return finish("omitido", "baja");
    if (r.label === "personal") return finish("omitido", "personal");
    const t = await db.query<{ status: string; trial_ends_at: Date | null }>("SELECT status, trial_ends_at FROM tenants WHERE id = $1", [tenantId]);
    const tn = t.rows[0];
    if (!(tn?.status === "active" || (tn?.status === "trial" && (!tn.trial_ends_at || tn.trial_ends_at.getTime() > Date.now())))) return finish("omitido", "negocio_inactivo");
    const tpl = await db.query<{ status: string; sendable: boolean }>("SELECT status, sendable FROM whatsapp_templates WHERE tenant_id = $1 AND name = $2 AND language = $3", [tenantId, r.template_name, r.template_language]);
    if (tpl.rowCount !== 1 || tpl.rows[0]!.status !== "APPROVED" || !tpl.rows[0]!.sendable) return finish("fallido", "plantilla_no_disponible: la plantilla ya no está aprobada");
    const i = await db.query<{ external_id: string; secret_enc: string; key_version: number }>("SELECT external_id, secret_enc, key_version FROM tenant_integrations WHERE tenant_id = $1 AND provider = 'whatsapp'", [tenantId]);
    if (i.rowCount !== 1) return finish("fallido", "sin_whatsapp");

    // Conversación: la abierta de esa persona, o una nueva si nunca nos escribió.
    let conv = (await db.query<{ id: string; status: string }>("SELECT id, status FROM conversations WHERE tenant_id = $1 AND contact_id = $2 AND status <> 'closed'", [tenantId, r.contact_id])).rows[0];
    if (conv?.status === "human") return finish("omitido", "con_persona");
    if (!conv) {
      await db.query("INSERT INTO conversations (tenant_id, contact_id) VALUES ($1, $2) ON CONFLICT (tenant_id, contact_id) WHERE status <> 'closed' DO NOTHING", [tenantId, r.contact_id]);
      conv = (await db.query<{ id: string; status: string }>("SELECT id, status FROM conversations WHERE tenant_id = $1 AND contact_id = $2 AND status <> 'closed'", [tenantId, r.contact_id])).rows[0]!;
    }
    const params = paramValues(r.params, r.display_name);
    await db.query("UPDATE broadcast_recipients SET attempts = attempts + 1 WHERE tenant_id = $1 AND id = $2", [tenantId, recipientId]);
    const ins = await db.query<{ id: string }>(
      `INSERT INTO messages (tenant_id, conversation_id, direction, msg_type, body, send_state, client_key)
       VALUES ($1, $2, 'out', 'template', $3, 'sending', $4) ON CONFLICT (tenant_id, client_key) WHERE client_key IS NOT NULL DO NOTHING RETURNING id`,
      [tenantId, conv.id, renderBody(r.template_text, params), key]);
    if (!ins.rowCount) return { kind: "done", outcome: "skipped" };
    const integ = i.rows[0]!;
    return { kind: "go", r, attempts: r.attempts + 1, messageId: ins.rows[0]!.id, phoneId: integ.external_id, waId: r.wa_id, secretEnc: integ.secret_enc, keyVersion: integ.key_version, params };
  });
  if (prepared.kind === "done") return prepared.outcome;

  let result: SendResult;
  try {
    const token = decryptSecret(prepared.secretEnc, `wa:${tenantId}:${prepared.phoneId}`, prepared.keyVersion);
    result = await (deps.sendTemplate ?? sendTemplate)(prepared.phoneId, token, prepared.waId, { name: prepared.r.template_name, language: prepared.r.template_language, params: prepared.params });
  } catch {
    result = { kind: "retry", reason: "error interno antes de enviar" };
  }

  return withTenant(tenantId, async (db): Promise<RecipientOutcome> => {
    const failMsg = (state: "failed" | "unknown", err: string) => db.query("UPDATE messages SET send_state = $3, send_error = $4 WHERE tenant_id = $1 AND id = $2", [tenantId, prepared.messageId, state, err.slice(0, 300)]);
    switch (result.kind) {
      case "sent":
        await db.query("UPDATE messages SET wa_message_id = $3, send_state = 'sent' WHERE tenant_id = $1 AND id = $2", [tenantId, prepared.messageId, result.waMessageId]);
        await db.query("UPDATE conversations SET last_message_at = now() WHERE tenant_id = $1 AND id = (SELECT conversation_id FROM messages WHERE tenant_id = $1 AND id = $2)", [tenantId, prepared.messageId]);
        await db.query("UPDATE broadcast_recipients SET status = 'enviado', message_id = $3, sent_at = now(), reason = NULL WHERE tenant_id = $1 AND id = $2", [tenantId, recipientId, prepared.messageId]);
        return "sent";
      case "retry":
        if (prepared.attempts < MAX_ATTEMPTS) {
          await db.query("DELETE FROM messages WHERE tenant_id = $1 AND id = $2", [tenantId, prepared.messageId]);
          await db.query("UPDATE broadcast_recipients SET next_at = now() + make_interval(secs => $3) WHERE tenant_id = $1 AND id = $2", [tenantId, recipientId, RETRY_SECONDS[prepared.attempts - 1]]);
          return "retry";
        }
        await failMsg("failed", "No se pudo conectar con WhatsApp");
        await db.query("UPDATE broadcast_recipients SET status = 'fallido', reason = 'sin_conexion: no se pudo conectar con WhatsApp tras varios intentos', sent_at = now() WHERE tenant_id = $1 AND id = $2", [tenantId, recipientId]);
        return "failed";
      case "rejected": {
        const why = `rechazado (${result.code ?? result.status}): ${result.message}`;
        await failMsg("failed", why);
        await db.query("UPDATE broadcast_recipients SET status = 'fallido', reason = $3, sent_at = now() WHERE tenant_id = $1 AND id = $2", [tenantId, recipientId, why.slice(0, 300)]);
        return "failed";
      }
      case "unknown":
        await failMsg("unknown", result.reason);
        await db.query("UPDATE broadcast_recipients SET status = 'fallido', reason = $3, sent_at = now() WHERE tenant_id = $1 AND id = $2", [tenantId, recipientId, `incierto: ${result.reason}`.slice(0, 300)]);
        return "failed";
    }
  });
}

/** Una vuelta de una difusión: respeta el tope diario, envía un lote, la pausa si va mal y la cierra al terminar. */
export async function processBroadcast(tenantId: string, broadcastId: string, deps: BroadcastDeps = {}): Promise<{ sent: number; failed: number; state: string }> {
  const plan = await withTenant(tenantId, async (db) => {
    const b = await db.query<{ status: string }>("SELECT status FROM broadcasts WHERE tenant_id = $1 AND id = $2", [tenantId, broadcastId]);
    if (b.rows[0]?.status !== "enviando") return { ids: [] as string[], state: b.rows[0]?.status ?? "no_existe" };
    const used = await db.query<{ n: number }>("SELECT count(*)::int AS n FROM broadcast_recipients WHERE tenant_id = $1 AND status = 'enviado' AND sent_at > now() - interval '24 hours'", [tenantId]);
    const room = Math.max(0, DAILY_CAP - used.rows[0]!.n);
    const ids = room === 0 ? [] : (await db.query<{ id: string }>(
      "SELECT id FROM broadcast_recipients WHERE tenant_id = $1 AND broadcast_id = $2 AND status = 'pendiente' AND next_at <= now() ORDER BY next_at, id LIMIT $3",
      [tenantId, broadcastId, Math.min(BATCH, room)])).rows.map((x) => x.id);
    return { ids, state: "enviando" };
  });
  let sent = 0; let failed = 0;
  for (const id of plan.ids) {
    try {
      const o = await sendRecipient(tenantId, id, deps);
      if (o === "sent") sent++;
      if (o === "failed") failed++;
    } catch (err) {
      console.error("[difusiones] envío falló:", err instanceof Error ? err.message : err);
    }
  }
  const state = await withTenant(tenantId, async (db) => {
    const left = await db.query<{ n: number }>("SELECT count(*)::int AS n FROM broadcast_recipients WHERE tenant_id = $1 AND broadcast_id = $2 AND status = 'pendiente'", [tenantId, broadcastId]);
    if (left.rows[0]!.n === 0) {
      await db.query("UPDATE broadcasts SET status = 'terminada', finished_at = now() WHERE tenant_id = $1 AND id = $2 AND status = 'enviando'", [tenantId, broadcastId]);
      return "terminada";
    }
    // Calidad: de los últimos envíos, ¿fallaron demasiados (por nuestro lado o porque WhatsApp no los entregó)?
    const q = await db.query<{ total: number; bad: number }>(
      `SELECT count(*)::int AS total, count(*) FILTER (WHERE x.status = 'fallido' OR x.dstatus = 'failed')::int AS bad
         FROM (SELECT r.status, m.delivery_status AS dstatus FROM broadcast_recipients r LEFT JOIN messages m ON m.tenant_id = r.tenant_id AND m.id = r.message_id
                WHERE r.tenant_id = $1 AND r.broadcast_id = $2 AND r.status IN ('enviado', 'fallido') ORDER BY r.sent_at DESC NULLS LAST LIMIT $3) x`,
      [tenantId, broadcastId, QUALITY_WINDOW]);
    const { total, bad } = q.rows[0]!;
    if (total >= QUALITY_MIN && bad / total >= QUALITY_FAIL_RATE) {
      await db.query("UPDATE broadcasts SET status = 'pausada', pause_reason = $3 WHERE tenant_id = $1 AND id = $2 AND status = 'enviando'", [tenantId, broadcastId, "Se pausó sola: muchos mensajes no llegaron. Revisa tu número de WhatsApp y la plantilla antes de seguir."]);
      return "pausada";
    }
    return "enviando";
  });
  return { sent, failed, state };
}

let running = false;
/** Lo llama el worker: visita las difusiones que están enviando (una vuelta cada ~10 s por difusión). */
export async function tickBroadcasts(max = 5, everySeconds = 10, deps: BroadcastDeps = {}): Promise<number> {
  if (running) return 0;
  running = true;
  let n = 0;
  try {
    const claimed = await getPool().query<{ out_tenant_id: string; out_broadcast_id: string }>("SELECT * FROM broadcast_claim($1, $2)", [max, everySeconds]);
    for (const c of claimed.rows) {
      try { n += (await processBroadcast(c.out_tenant_id, c.out_broadcast_id, deps)).sent; }
      catch (err) { console.error("[difusiones] vuelta falló:", err instanceof Error ? err.message : err); }
    }
  } catch (err) {
    console.error("[difusiones] no se pudo revisar:", err instanceof Error ? err.message : err);
  } finally { running = false; }
  return n;
}
