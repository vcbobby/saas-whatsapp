import { decryptSecret } from "@/lib/crypto";
import { withTenant } from "@/lib/db";
import { sendText, type SendResult } from "@/lib/whatsapp/graph";
import { sendTemplate } from "@/lib/whatsapp/templates";

/** WhatsApp solo permite texto libre dentro de las 24 horas siguientes al último mensaje del cliente. */
export const WINDOW_MS = 24 * 60 * 60 * 1000;
/** Margen de seguridad: cerramos la ventana unos minutos antes para no chocar con diferencias de reloj. */
export const WINDOW_MARGIN_MS = 2 * 60 * 1000;
/** Una fila "sending" más vieja que esto se considera interrumpida (el envío pudo o no haber salido). */
export const STALE_SENDING_MS = 2 * 60 * 1000;
export const MAX_REPLY_CHARS = 4000;

export type ReplyOutcome =
  | { kind: "sent"; messageId: string; duplicate: boolean }
  | { kind: "not_found" }
  | { kind: "closed" }
  | { kind: "not_mine" }
  | { kind: "window_closed" }
  | { kind: "inactive_tenant" }
  | { kind: "no_whatsapp" }
  | { kind: "key_conflict" }
  | { kind: "in_progress"; messageId: string }
  | { kind: "failed"; messageId: string; message: string; duplicate: boolean }
  | { kind: "unknown"; messageId: string; duplicate: boolean };

export interface ReplyInput {
  tenantId: string;
  userId: string;
  conversationId: string;
  clientKey: string;
  text: string;
  /** Si viene, se envía como plantilla aprobada (vale fuera de las 24 h). `text` es el texto ya armado, que se guarda en la conversación. */
  template?: { name: string; language: string; params: string[] };
}

/** Fin de la ventana de respuesta libre (o null si el cliente nunca escribió / ya pasó). Pura: se prueba sin base de datos. */
export function windowEnd(lastInbound: Date | null, nowMs: number = Date.now()): Date | null {
  if (!lastInbound) return null;
  const end = lastInbound.getTime() + WINDOW_MS - WINDOW_MARGIN_MS;
  return end > nowMs ? new Date(end) : null;
}

type Prepared =
  | ReplyOutcome
  | { kind: "go"; messageId: string; phoneId: string; waId: string; secretEnc: string; keyVersion: number };

interface ExistingRow { id: string; conversation_id: string; send_state: string; send_error: string | null; stale: boolean }

function fromExisting(m: ExistingRow, conversationId: string): ReplyOutcome {
  if (m.conversation_id !== conversationId) return { kind: "key_conflict" };
  if (m.send_state === "sent") return { kind: "sent", messageId: m.id, duplicate: true };
  if (m.send_state === "failed") return { kind: "failed", messageId: m.id, message: m.send_error ?? "No se pudo enviar.", duplicate: true };
  if (m.send_state === "unknown" || m.stale) return { kind: "unknown", messageId: m.id, duplicate: true };
  return { kind: "in_progress", messageId: m.id };
}

/**
 * Envía el mensaje escrito por una persona.
 * Reglas (todas se comprueban dentro de una transacción que bloquea la conversación):
 *  1. La conversación existe, no está cerrada y la tiene ESTA persona (evita que dos personas respondan a la vez
 *     o que el asistente y una persona hablen al mismo tiempo).
 *  2. El mismo intento (clientKey) nunca envía dos veces.
 *  3. Solo dentro de las 24 horas del último mensaje del cliente.
 *  4. Se anota "sending" ANTES de llamar a Meta; si no sabemos si salió, queda "unknown" y NO se reintenta solo.
 */
export async function sendHumanReply(input: ReplyInput, deps: { send?: typeof sendText; sendTemplate?: typeof sendTemplate } = {}): Promise<ReplyOutcome> {
  const { tenantId, userId, conversationId, clientKey } = input;
  const text = input.text;

  const prepared: Prepared = await withTenant(tenantId, async (db) => {
    const c = await db.query<{ status: string; assigned_to: string | null; wa_id: string }>(
      `SELECT c.status, c.assigned_to, ct.wa_id
         FROM conversations c JOIN contacts ct ON ct.tenant_id = c.tenant_id AND ct.id = c.contact_id
        WHERE c.tenant_id = $1 AND c.id = $2 FOR UPDATE OF c`,
      [tenantId, conversationId],
    );
    if (c.rowCount !== 1) return { kind: "not_found" } as const;
    const conv = c.rows[0]!;

    // ¿Este mismo intento ya existe? (doble clic o reintento) → se devuelve lo que pasó, sin enviar nada.
    const findExisting = async () => {
      const e = await db.query<ExistingRow>(
        `SELECT id, conversation_id, send_state, send_error,
                (send_state = 'sending' AND received_at < now() - ($3 || ' milliseconds')::interval) AS stale
           FROM messages WHERE tenant_id = $1 AND client_key = $2`,
        [tenantId, clientKey, String(STALE_SENDING_MS)],
      );
      return e.rows[0];
    };
    const prev = await findExisting();
    if (prev) {
      if (prev.stale) {
        await db.query("UPDATE messages SET send_state = 'unknown', send_error = 'el proceso se interrumpió durante el envío' WHERE tenant_id = $1 AND id = $2 AND send_state = 'sending'", [tenantId, prev.id]);
      }
      return fromExisting(prev, conversationId);
    }

    if (conv.status === "closed") return { kind: "closed" } as const;
    if (conv.status !== "human" || conv.assigned_to !== userId) return { kind: "not_mine" } as const;

    const t = await db.query<{ status: string; trial_ends_at: Date | null }>("SELECT status, trial_ends_at FROM tenants WHERE id = $1", [tenantId]);
    const tn = t.rows[0];
    const active = tn?.status === "active" || (tn?.status === "trial" && (!tn.trial_ends_at || tn.trial_ends_at.getTime() > Date.now()));
    if (!active) return { kind: "inactive_tenant" } as const;

    const last = await db.query<{ at: Date | null }>(
      "SELECT max(created_at) AS at FROM messages WHERE tenant_id = $1 AND conversation_id = $2 AND direction = 'in'",
      [tenantId, conversationId],
    );
    // Las plantillas aprobadas sí se pueden enviar fuera de las 24 h; el texto libre no.
    if (!input.template && !windowEnd(last.rows[0]?.at ?? null)) return { kind: "window_closed" } as const;

    const i = await db.query<{ external_id: string; secret_enc: string; key_version: number }>(
      "SELECT external_id, secret_enc, key_version FROM tenant_integrations WHERE tenant_id = $1 AND provider = 'whatsapp'",
      [tenantId],
    );
    if (i.rowCount !== 1) return { kind: "no_whatsapp" } as const;
    const integ = i.rows[0]!;

    const ins = await db.query<{ id: string }>(
      `INSERT INTO messages (tenant_id, conversation_id, direction, msg_type, body, send_state, sent_by, client_key)
       VALUES ($1, $2, 'out', $6, $3, 'sending', $4, $5)
       ON CONFLICT (tenant_id, client_key) WHERE client_key IS NOT NULL DO NOTHING
       RETURNING id`,
      [tenantId, conversationId, text, userId, clientKey, input.template ? "template" : "text"],
    );
    if (!ins.rowCount) {
      const again = await findExisting();
      return again ? fromExisting(again, conversationId) : ({ kind: "in_progress", messageId: "" } as const);
    }
    return { kind: "go", messageId: ins.rows[0]!.id, phoneId: integ.external_id, waId: conv.wa_id, secretEnc: integ.secret_enc, keyVersion: integ.key_version } as const;
  });

  if (prepared.kind !== "go") return prepared;

  const finish = (sql: string, params: unknown[]) => withTenant(tenantId, (db) => db.query(sql, [tenantId, prepared.messageId, ...params]));

  let result: SendResult;
  try {
    const token = decryptSecret(prepared.secretEnc, `wa:${tenantId}:${prepared.phoneId}`, prepared.keyVersion);
    result = input.template
      ? await (deps.sendTemplate ?? sendTemplate)(prepared.phoneId, token, prepared.waId, input.template)
      : await (deps.send ?? sendText)(prepared.phoneId, token, prepared.waId, text);
  } catch {
    // Falló antes de hablar con Meta (p. ej. no se pudo descifrar la llave): no se envió nada.
    result = { kind: "retry", reason: "error interno antes de enviar" };
  }

  switch (result.kind) {
    case "sent":
      await withTenant(tenantId, async (db) => {
        await db.query("UPDATE messages SET wa_message_id = $3, send_state = 'sent' WHERE tenant_id = $1 AND id = $2", [tenantId, prepared.messageId, result.waMessageId]);
        await db.query("UPDATE conversations SET last_message_at = now() WHERE tenant_id = $1 AND id = $2", [tenantId, conversationId]);
      });
      return { kind: "sent", messageId: prepared.messageId, duplicate: false };
    case "retry": {
      const message = "No se pudo conectar con WhatsApp. El mensaje no se envió; intenta de nuevo en un momento.";
      await finish("UPDATE messages SET send_state = 'failed', send_error = $3 WHERE tenant_id = $1 AND id = $2", [message]);
      return { kind: "failed", messageId: prepared.messageId, message, duplicate: false };
    }
    case "rejected": {
      // 131047 = pasaron más de 24 horas desde el último mensaje del cliente.
      const tplMsg: Record<number, string> = {
        132001: "Meta no encuentra esa plantilla en tu cuenta (o el idioma no coincide). Actualiza la lista de plantillas.",
        132000: "Faltan o sobran datos para llenar la plantilla.",
        132005: "El texto de la plantilla quedó demasiado largo al llenarla.",
        132007: "La plantilla no cumple las políticas de WhatsApp.",
        132012: "Uno de los datos tiene un formato que Meta no acepta (sin saltos de línea ni muchos espacios).",
        132015: "Meta pausó esa plantilla por baja calidad. Usa otra o edítala en Meta.",
        132016: "Meta deshabilitó esa plantilla. Usa otra.",
        131049: "Meta no entregó este mensaje de marketing para proteger la experiencia del cliente. Inténtalo más tarde o usa una plantilla de utilidad.",
        131042: "Meta pide un método de pago en tu cuenta de WhatsApp Business para enviar plantillas. Agrégalo en Meta → Facturación.",
      };
      const message = input.template && result.code !== null && tplMsg[result.code]
        ? `${tplMsg[result.code]} No se envió.`
        : result.code === 131047
        ? "WhatsApp indica que ya pasaron más de 24 horas desde el último mensaje del cliente. El mensaje no se envió."
        : `WhatsApp rechazó el mensaje (${result.code ?? result.status}). No se envió.`;
      await finish("UPDATE messages SET send_state = 'failed', send_error = $3 WHERE tenant_id = $1 AND id = $2", [`${result.code ?? result.status}: ${result.message}`.slice(0, 300)]);
      return { kind: "failed", messageId: prepared.messageId, message, duplicate: false };
    }
    case "unknown":
      await finish("UPDATE messages SET send_state = 'unknown', send_error = $3 WHERE tenant_id = $1 AND id = $2", [result.reason.slice(0, 300)]);
      return { kind: "unknown", messageId: prepared.messageId, duplicate: false };
  }
}
