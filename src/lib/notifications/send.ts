import { decryptSecret } from "@/lib/crypto";
import { getPool, withTenant } from "@/lib/db";
import { STALE_SENDING_MS, windowEnd } from "@/lib/conversations/reply";
import { sendText, type SendResult } from "@/lib/whatsapp/graph";

/** Espera (segundos) tras un fallo de conexión antes de reintentar. Máximo 3 intentos en total. */
export const RETRY_SECONDS = [60, 300] as const;
export const MAX_ATTEMPTS = RETRY_SECONDS.length + 1;
const LOCK_SECONDS = 60;

export interface NotifyDeps { send?: typeof sendText }
export type NotifyOutcome = "sent" | "retry" | "omitted" | "failed" | "skipped";

/** Palabras con las que un cliente pide dejar de recibir avisos automáticos (y volver a recibirlos). Pura. */
export function optOutIntent(text: string | null | undefined): "off" | "on" | null {
  if (!text) return null;
  const t = text.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
  if (["baja", "stop", "no mas avisos", "no mas mensajes", "no quiero mas avisos", "no quiero mas mensajes", "cancelar avisos"].includes(t)) return "off";
  if (["alta", "start", "activar avisos", "quiero avisos"].includes(t)) return "on";
  return null;
}

interface Loaded {
  id: string; rule_id: string; event_id: string; contact_id: string | null; conversation_id: string | null; customer_name: string | null; body: string; fallback_title: string;
  status: string; attempts: number;
}

/** Tarea en «Hoy» para avisar a mano cuando el aviso automático no pudo salir. Misma clave que la de la base: nunca se duplica. */
async function fallbackTask(db: { query: (q: string, p: unknown[]) => Promise<unknown> }, tenantId: string, n: Loaded, why: string) {
  await db.query(
    `INSERT INTO work_items (tenant_id, type, priority, title, detail, source, dedupe_key, conversation_id, contact_id)
     SELECT $1, 'tarea', COALESCE((SELECT task_priority FROM automation_rules WHERE tenant_id = $1 AND id = $2), 2), $3, $4, 'sistema', $5, $6, $7
     ON CONFLICT DO NOTHING`,
    [tenantId, n.rule_id, n.fallback_title.slice(0, 200), `${why} Mensaje sugerido: ${n.body}`.slice(0, 2000), `auto:${n.rule_id}:${n.event_id}`, n.conversation_id, n.contact_id],
  );
}

/** Envía UN aviso ya tomado de la cola. Seguro si se repite: nunca manda dos veces el mismo. */
export async function sendOne(tenantId: string, id: string, deps: NotifyDeps = {}): Promise<NotifyOutcome> {
  type Go = { kind: "go"; n: Loaded; messageId: string; phoneId: string; waId: string; secretEnc: string; keyVersion: number };
  type Done = { kind: "done"; outcome: NotifyOutcome };
  const prepared: Go | Done = await withTenant(tenantId, async (db): Promise<Go | Done> => {
    const q = await db.query<Loaded>("SELECT id, rule_id, event_id, contact_id, conversation_id, customer_name, body, fallback_title, status, attempts FROM customer_notifications WHERE tenant_id = $1 AND id = $2 FOR UPDATE", [tenantId, id]);
    const n = q.rows[0];
    if (!n || n.status !== "pendiente") { await db.query("SELECT notification_queue_set($1, NULL)", [id]); return { kind: "done", outcome: "skipped" }; }

    const finish = async (status: "omitido" | "fallido", reason: string, task: boolean, why: string): Promise<Done> => {
      await db.query("UPDATE customer_notifications SET status = $3, reason = $4, finished_at = now() WHERE tenant_id = $1 AND id = $2", [tenantId, id, status, reason.slice(0, 300)]);
      await db.query("SELECT notification_queue_set($1, NULL)", [id]);
      if (task) await fallbackTask(db, tenantId, n, why);
      return { kind: "done", outcome: status === "omitido" ? "omitted" : "failed" };
    };

    // ¿Ya se intentó antes este mismo aviso?
    //  - «sending» reciente: otro worker lo está enviando ahora mismo → no se toca (si se cae, se retoma al envejecer).
    //  - «sent»: solo faltaba cerrar el aviso.
    //  - «sending» viejo / fallido / incierto: el worker se cayó a medias; podría haber salido → NO se reenvía.
    const prev = await db.query<{ id: string; send_state: string; stale: boolean }>(
      "SELECT id, send_state, (send_state = 'sending' AND received_at < now() - ($3 || ' milliseconds')::interval) AS stale FROM messages WHERE tenant_id = $1 AND client_key = $2",
      [tenantId, id, String(STALE_SENDING_MS)],
    );
    if (prev.rowCount) {
      const m = prev.rows[0]!;
      if (m.send_state === "sending" && !m.stale) return { kind: "done", outcome: "skipped" };
      if (m.send_state === "sent") {
        await db.query("UPDATE customer_notifications SET status = 'enviado', message_id = $3, finished_at = now() WHERE tenant_id = $1 AND id = $2", [tenantId, id, m.id]);
        await db.query("SELECT notification_queue_set($1, NULL)", [id]);
        return { kind: "done", outcome: "sent" };
      }
      return finish("fallido", "incierto: el envío se interrumpió y no se sabe si salió", true, "No se sabe si el aviso salió (se interrumpió el envío). Revisa la conversación antes de repetirlo.");
    }

    if (!n.conversation_id || !n.contact_id) return finish("omitido", "sin_conversacion", true, "No hay una conversación de WhatsApp con este cliente.");
    const c = await db.query<{ status: string; wa_id: string; off: boolean }>(
      `SELECT c.status, ct.wa_id, ct.notifications_off AS off FROM conversations c JOIN contacts ct ON ct.tenant_id = c.tenant_id AND ct.id = c.contact_id
        WHERE c.tenant_id = $1 AND c.id = $2`, [tenantId, n.conversation_id]);
    if (c.rowCount !== 1) return finish("omitido", "sin_conversacion", true, "La conversación ya no existe.");
    const conv = c.rows[0]!;
    if (conv.off) return finish("omitido", "baja", false, "");
    const t = await db.query<{ status: string; trial_ends_at: Date | null }>("SELECT status, trial_ends_at FROM tenants WHERE id = $1", [tenantId]);
    const tn = t.rows[0];
    const active = tn?.status === "active" || (tn?.status === "trial" && (!tn.trial_ends_at || tn.trial_ends_at.getTime() > Date.now()));
    if (!active) return finish("omitido", "negocio_inactivo", false, "");
    const last = await db.query<{ at: Date | null }>("SELECT max(created_at) AS at FROM messages WHERE tenant_id = $1 AND conversation_id = $2 AND direction = 'in'", [tenantId, n.conversation_id]);
    if (!windowEnd(last.rows[0]?.at ?? null)) return finish("omitido", "ventana_cerrada", true, "Pasaron más de 24 horas desde el último mensaje del cliente: WhatsApp no deja escribirle ahora. Avísale por otro medio.");
    const i = await db.query<{ external_id: string; secret_enc: string; key_version: number }>("SELECT external_id, secret_enc, key_version FROM tenant_integrations WHERE tenant_id = $1 AND provider = 'whatsapp'", [tenantId]);
    if (i.rowCount !== 1) return finish("omitido", "sin_whatsapp", true, "El negocio no tiene WhatsApp conectado.");

    await db.query("UPDATE customer_notifications SET attempts = attempts + 1 WHERE tenant_id = $1 AND id = $2", [tenantId, id]);
    const ins = await db.query<{ id: string }>(
      `INSERT INTO messages (tenant_id, conversation_id, direction, msg_type, body, send_state, client_key)
       VALUES ($1, $2, 'out', 'text', $3, 'sending', $4)
       ON CONFLICT (tenant_id, client_key) WHERE client_key IS NOT NULL DO NOTHING RETURNING id`,
      [tenantId, n.conversation_id, n.body, id],
    );
    if (!ins.rowCount) return { kind: "done", outcome: "skipped" };
    const integ = i.rows[0]!;
    return { kind: "go", n: { ...n, attempts: n.attempts + 1 }, messageId: ins.rows[0]!.id, phoneId: integ.external_id, waId: conv.wa_id, secretEnc: integ.secret_enc, keyVersion: integ.key_version };
  });
  if (prepared.kind === "done") return prepared.outcome;
  const { n } = prepared;

  let result: SendResult;
  try {
    const token = decryptSecret(prepared.secretEnc, `wa:${tenantId}:${prepared.phoneId}`, prepared.keyVersion);
    result = await (deps.send ?? sendText)(prepared.phoneId, token, prepared.waId, n.body);
  } catch {
    result = { kind: "retry", reason: "error interno antes de enviar" };
  }

  return withTenant(tenantId, async (db): Promise<NotifyOutcome> => {
    const failMsg = (state: "failed" | "unknown", err: string) => db.query("UPDATE messages SET send_state = $3, send_error = $4 WHERE tenant_id = $1 AND id = $2", [tenantId, prepared.messageId, state, err.slice(0, 300)]);
    switch (result.kind) {
      case "sent":
        await db.query("UPDATE messages SET wa_message_id = $3, send_state = 'sent' WHERE tenant_id = $1 AND id = $2", [tenantId, prepared.messageId, result.waMessageId]);
        await db.query("UPDATE conversations SET last_message_at = now() WHERE tenant_id = $1 AND id = $2", [tenantId, n.conversation_id]);
        await db.query("UPDATE customer_notifications SET status = 'enviado', message_id = $3, finished_at = now(), reason = NULL WHERE tenant_id = $1 AND id = $2", [tenantId, n.id, prepared.messageId]);
        await db.query("SELECT notification_queue_set($1, NULL)", [n.id]);
        return "sent";
      case "retry": {
        if (n.attempts < MAX_ATTEMPTS) {
          // No salió nada: se borra el intento (no es un mensaje real) y se reprograma.
          await db.query("DELETE FROM messages WHERE tenant_id = $1 AND id = $2", [tenantId, prepared.messageId]);
          await db.query("SELECT notification_queue_set($1, now() + make_interval(secs => $2))", [n.id, RETRY_SECONDS[n.attempts - 1]]);
          return "retry";
        }
        await failMsg("failed", "No se pudo conectar con WhatsApp");
        await db.query("UPDATE customer_notifications SET status = 'fallido', reason = $3, finished_at = now() WHERE tenant_id = $1 AND id = $2", [tenantId, n.id, "sin_conexion: no se pudo conectar con WhatsApp tras varios intentos"]);
        await db.query("SELECT notification_queue_set($1, NULL)", [n.id]);
        await fallbackTask(db, tenantId, n, "No se pudo conectar con WhatsApp para enviar el aviso.");
        return "failed";
      }
      case "rejected": {
        const why = result.code === 131047 ? "ventana_cerrada: pasaron más de 24 horas desde el último mensaje del cliente" : `rechazado (${result.code ?? result.status}): ${result.message}`;
        await failMsg("failed", why);
        await db.query("UPDATE customer_notifications SET status = 'fallido', reason = $3, finished_at = now() WHERE tenant_id = $1 AND id = $2", [tenantId, n.id, why.slice(0, 300)]);
        await db.query("SELECT notification_queue_set($1, NULL)", [n.id]);
        await fallbackTask(db, tenantId, n, "WhatsApp no dejó enviar el aviso. Avísale por otro medio.");
        return "failed";
      }
      case "unknown":
        await failMsg("unknown", result.reason);
        await db.query("UPDATE customer_notifications SET status = 'fallido', reason = $3, finished_at = now() WHERE tenant_id = $1 AND id = $2", [tenantId, n.id, `incierto: ${result.reason}`.slice(0, 300)]);
        await db.query("SELECT notification_queue_set($1, NULL)", [n.id]);
        await fallbackTask(db, tenantId, n, "No se sabe si el aviso salió (WhatsApp no confirmó). Revisa la conversación antes de repetirlo.");
        return "failed";
    }
  });
}

/** Toma de la cola los avisos vencidos y los envía. */
export async function sendDue(max = 5, deps: NotifyDeps = {}): Promise<Record<NotifyOutcome, number>> {
  const claimed = await getPool().query<{ out_tenant_id: string; out_notification_id: string }>("SELECT out_tenant_id, out_notification_id FROM notification_claim($1, $2)", [max, LOCK_SECONDS]);
  const counts: Record<NotifyOutcome, number> = { sent: 0, retry: 0, omitted: 0, failed: 0, skipped: 0 };
  await Promise.all(
    claimed.rows.map(async (c) => {
      try {
        counts[await sendOne(c.out_tenant_id, c.out_notification_id, deps)]++;
      } catch (err) {
        console.error("[avisos] error inesperado:", err instanceof Error ? err.message : err);
      }
    }),
  );
  return counts;
}
