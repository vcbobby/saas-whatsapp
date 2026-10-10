import { getLlmProvider } from "@/lib/ai";
import type { LlmProvider } from "@/lib/ai/provider";
import { decryptSecret } from "@/lib/crypto";
import { withTenant } from "@/lib/db";
import { getLlmEnv } from "@/lib/env";
import { withLock } from "@/lib/queue/lock";
import type { InboundJob } from "@/lib/queue/producer";
import { sendText } from "@/lib/whatsapp/graph";
import { FIXED, RULES_LINES, buildSystemPrompt, buildTurns, customerWantsHuman, parseReply, type HistoryRow } from "./prompt";
import { allowedContacts, checkOutput, looksLikeInjection, newCanary } from "./safety";

export type AgentOutcome =
  | "replied"
  | "handoff"
  | "already_replied"
  | "limit_reached"
  | "contact_limited"
  | "send_failed"
  | "send_unknown"
  | "skipped_not_found"
  | "skipped_ignored_type"
  | "skipped_disabled"
  | "skipped_inactive_tenant"
  | "skipped_human"
  | "skipped_superseded"
  | "skipped_no_whatsapp";

export interface AgentDeps {
  llm: LlmProvider;
  send: typeof sendText;
}

const LOCK_TTL_MS = 90_000; // mayor que IA (30 s) + envío (10 s) + base de datos
const LLM_MAX_TOKENS = 400;
const TEXT_TYPES = new Set(["text", "button", "interactive"]);
const IGNORED_TYPES = new Set(["reaction"]);

interface Ctx {
  messageId: string;
  conversationId: string;
  contactId: string;
  msgType: string;
  body: string | null;
  convStatus: string;
  waId: string;
  tenantName: string;
  tenantStatus: string;
  trialEndsAt: Date | null;
  enabled: boolean;
  assistantName: string;
  instructions: string;
  phoneId: string | null;
  secretEnc: string | null;
  keyVersion: number | null;
}

async function loadContext(job: InboundJob): Promise<Ctx | null> {
  return withTenant(job.tenantId, async (db) => {
    const r = await db.query(
      `SELECT m.id AS message_id, m.conversation_id, c.contact_id, m.msg_type, m.body,
              c.status AS conv_status, ct.wa_id,
              t.name AS tenant_name, t.status AS tenant_status, t.trial_ends_at,
              COALESCE(a.enabled, false) AS enabled,
              COALESCE(a.assistant_name, 'Asistente') AS assistant_name,
              COALESCE(a.instructions, '') AS instructions,
              i.external_id AS phone_id, i.secret_enc, i.key_version
         FROM messages m
         JOIN conversations c ON c.tenant_id = m.tenant_id AND c.id = m.conversation_id
         JOIN contacts ct ON ct.tenant_id = c.tenant_id AND ct.id = c.contact_id
         JOIN tenants t ON t.id = m.tenant_id
         LEFT JOIN tenant_agents a ON a.tenant_id = m.tenant_id
         LEFT JOIN tenant_integrations i ON i.tenant_id = m.tenant_id AND i.provider = 'whatsapp'
        WHERE m.tenant_id = $1 AND m.id = $2 AND m.direction = 'in'`,
      [job.tenantId, job.messageId],
    );
    const x = r.rows[0];
    if (!x) return null;
    return {
      messageId: x.message_id, conversationId: x.conversation_id, contactId: x.contact_id, msgType: x.msg_type, body: x.body,
       convStatus: x.conv_status, waId: x.wa_id,
      tenantName: x.tenant_name, tenantStatus: x.tenant_status, trialEndsAt: x.trial_ends_at,
      enabled: x.enabled, assistantName: x.assistant_name, instructions: x.instructions,
      phoneId: x.phone_id, secretEnc: x.secret_enc, keyVersion: x.key_version,
    } satisfies Ctx;
  });
}

function tenantActive(c: Ctx): boolean {
  if (c.tenantStatus === "active") return true;
  if (c.tenantStatus === "trial") return !c.trialEndsAt || c.trialEndsAt.getTime() > Date.now();
  return false;
}

type EventKind = "inyeccion" | "fuga_prompt" | "salida_bloqueada" | "limite_contacto";

/** Anota un incidente (solo tipo, mensaje y conversación; nunca el texto). Un reintento no lo duplica. */
async function recordEvent(tenantId: string, conversationId: string, messageId: string, kind: EventKind) {
  await withTenant(tenantId, (db) =>
    db.query(
      "INSERT INTO agent_events (tenant_id, conversation_id, message_id, kind) VALUES ($1, $2, $3, $4) ON CONFLICT (tenant_id, message_id, kind) DO NOTHING",
      [tenantId, conversationId, messageId, kind],
    ),
  );
}

/** Tras este número de mensajes de manipulación en una conversación, se deja de gastar IA y pasa a una persona. */
const INJECTION_STRIKES = 3;

async function handoff(tenantId: string, conversationId: string, reason: string) {
  await withTenant(tenantId, (db) =>
    db.query(
      "UPDATE conversations SET status = 'human', handoff_reason = $3 WHERE tenant_id = $1 AND id = $2 AND status = 'bot'",
      [tenantId, conversationId, reason],
    ),
  );
}

/**
 * Atiende un mensaje entrante: decide si responde, genera la respuesta y la envía.
 * Garantías:
 *  - Una conversación a la vez (candado en Redis).
 *  - Si el cliente escribe varios mensajes seguidos, solo el último genera respuesta (con todo el contexto).
 *  - Una respuesta por mensaje (índice único) y nunca se reenvía a ciegas: si no sabemos si Meta lo recibió, pasa a una persona.
 */
export async function runAgent(job: InboundJob, deps: Partial<AgentDeps> = {}): Promise<AgentOutcome> {
  const first = await loadContext(job);
  if (!first) return "skipped_not_found";
  return withLock(`agent-${first.conversationId}`, LOCK_TTL_MS, () => attend(job, deps));
}

async function attend(job: InboundJob, deps: Partial<AgentDeps>): Promise<AgentOutcome> {
  const { tenantId } = job;
  const ctx = await loadContext(job);
  if (!ctx) return "skipped_not_found";
  if (IGNORED_TYPES.has(ctx.msgType)) return "skipped_ignored_type";
  if (!ctx.enabled) return "skipped_disabled";
  if (!tenantActive(ctx)) return "skipped_inactive_tenant";
  if (!ctx.phoneId || !ctx.secretEnc || ctx.keyVersion === null) return "skipped_no_whatsapp";

  // ¿Ya hay una respuesta para este mensaje (reintento)?
  const prev = await withTenant(tenantId, async (db) => {
    const r = await db.query("SELECT id, send_state FROM messages WHERE tenant_id = $1 AND reply_to = $2 AND direction = 'out'", [tenantId, ctx.messageId]);
    return r.rows[0] as { id: string; send_state: string } | undefined;
  });
  if (prev) {
    if (prev.send_state === "sending") {
      // Un intento anterior murió a mitad del envío: no sabemos si Meta lo recibió.
      await withTenant(tenantId, (db) =>
        db.query("UPDATE messages SET send_state = 'unknown', send_error = 'el proceso se interrumpió durante el envío' WHERE tenant_id = $1 AND id = $2", [tenantId, prev.id]),
      );
      await handoff(tenantId, ctx.conversationId, "envio_incierto");
      return "send_unknown";
    }
    return prev.send_state === "failed" ? "send_failed" : prev.send_state === "unknown" ? "send_unknown" : "already_replied";
  }

  if (ctx.convStatus !== "bot") return "skipped_human";

  // Intentos de manipulación: se registran y, si la persona insiste, se corta antes de gastar IA.
  if (looksLikeInjection(ctx.body)) {
    await recordEvent(tenantId, ctx.conversationId, ctx.messageId, "inyeccion");
  }
  const strikes = await withTenant(tenantId, async (db) => {
    const r = await db.query("SELECT count(*)::int AS n FROM agent_events WHERE tenant_id = $1 AND conversation_id = $2 AND kind = 'inyeccion'", [tenantId, ctx.conversationId]);
    return r.rows[0].n as number;
  });

  // Si el cliente ya escribió algo más reciente, esa otra tarea responderá con todo el contexto.
  const newer = await withTenant(tenantId, async (db) => {
    const r = await db.query(
      `SELECT 1 FROM messages WHERE tenant_id = $1 AND conversation_id = $2 AND direction = 'in' AND msg_type <> 'reaction'
          AND (received_at, id) > (SELECT received_at, id FROM messages WHERE tenant_id = $1 AND id = $3) LIMIT 1`,
      [tenantId, ctx.conversationId, ctx.messageId],
    );
    return r.rowCount === 1;
  });
  if (newer) return "skipped_superseded";

  // Tope diario de respuestas por negocio.
  const env = getLlmEnv();
  const today = await withTenant(tenantId, async (db) => {
    const r = await db.query(
      `SELECT count(*)::int AS n FROM messages
        WHERE tenant_id = $1 AND direction = 'out' AND reply_to IS NOT NULL AND send_state <> 'failed'
          AND created_at >= (date_trunc('day', now() AT TIME ZONE 'utc') AT TIME ZONE 'utc')`,
      [tenantId],
    );
    return r.rows[0].n as number;
  });
  if (today >= env.AGENT_DAILY_REPLY_LIMIT) {
    await handoff(tenantId, ctx.conversationId, "limite_diario");
    return "limit_reached";
  }

  // Tope por cliente: cuántas respuestas del asistente recibió esta persona en la última hora y en las últimas 24 horas.
  const perContact = await withTenant(tenantId, async (db) => {
    const r = await db.query(
      `SELECT count(*) FILTER (WHERE m.created_at >= now() - interval '1 hour')::int AS hora,
              count(*)::int AS dia
         FROM messages m JOIN conversations c ON c.tenant_id = m.tenant_id AND c.id = m.conversation_id
        WHERE m.tenant_id = $1 AND c.contact_id = $2 AND m.direction = 'out' AND m.reply_to IS NOT NULL
          AND m.send_state <> 'failed' AND m.created_at >= now() - interval '24 hours'`,
      [tenantId, ctx.contactId],
    );
    return r.rows[0] as { hora: number; dia: number };
  });
  const contactLimited = perContact.hora >= env.AGENT_CONTACT_HOURLY_LIMIT || perContact.dia >= env.AGENT_CONTACT_DAILY_LIMIT;

  // Qué responder.
  let text: string;
  let wantsHandoff = false;
  let handoffReason = "pedido_de_persona";
  let usage = { input: 0, output: 0 };
  if (!(TEXT_TYPES.has(ctx.msgType) && ctx.body)) {
    text = FIXED.nonText;
  } else if (contactLimited) {
    await recordEvent(tenantId, ctx.conversationId, ctx.messageId, "limite_contacto");
    text = FIXED.rateLimited;
    wantsHandoff = true;
    handoffReason = "limite_contacto";
  } else if (strikes >= INJECTION_STRIKES) {
    text = FIXED.handoff;
    wantsHandoff = true;
    handoffReason = "intentos_de_manipulacion";
  } else if (customerWantsHuman(ctx.body)) {
    text = FIXED.handoff;
    wantsHandoff = true;
  } else {
    const history = await withTenant(tenantId, async (db) => {
      const r = await db.query(
        `SELECT direction, msg_type, body FROM messages
          WHERE tenant_id = $1 AND conversation_id = $2
            AND (direction = 'in' OR send_state = 'sent' OR send_state IS NULL)
          ORDER BY received_at DESC, id DESC LIMIT $3`,
        [tenantId, ctx.conversationId, env.AGENT_HISTORY_MESSAGES],
      );
      return (r.rows as HistoryRow[]).reverse();
    });
    const llm = deps.llm ?? getLlmProvider();
    const canary = newCanary();
    const out = await llm.generate({
      system: buildSystemPrompt({ assistantName: ctx.assistantName, businessName: ctx.tenantName, instructions: ctx.instructions, canary }),
      messages: buildTurns(history),
      maxTokens: LLM_MAX_TOKENS,
    });
    usage = { input: out.inputTokens, output: out.outputTokens };
    const parsed = parseReply(out.text);
    // Revisión de salida: si el modelo filtró sus reglas o inventó enlaces/correos, NO se envía; pasa a una persona.
    const verdict = checkOutput(parsed.text, { canary, rulesLines: RULES_LINES, allowed: allowedContacts(ctx.instructions) });
    if (!verdict.ok) {
      await recordEvent(tenantId, ctx.conversationId, ctx.messageId, verdict.kind);
      text = FIXED.fallback;
      wantsHandoff = true;
      handoffReason = verdict.kind === "fuga_prompt" ? "fuga_de_instrucciones" : "salida_bloqueada";
    } else if (!parsed.text) {
      text = FIXED.fallback;
      wantsHandoff = true;
      handoffReason = "respuesta_vacia";
    } else {
      text = parsed.text;
      wantsHandoff = parsed.handoff;
    }
  }

  // Descifrar el token ANTES de crear la fila "sending": si falla aquí, no hay nada a medias.
  const token = decryptSecret(ctx.secretEnc, `wa:${tenantId}:${ctx.phoneId}`, ctx.keyVersion);

  // Anotar la respuesta como "sending" ANTES de enviar (bandeja de salida). Si el proceso muere
  // después del envío, el reintento verá esta fila y no volverá a mandar el mensaje.
  const reserved = await withTenant(tenantId, async (db) => {
    const c = await db.query("SELECT status FROM conversations WHERE tenant_id = $1 AND id = $2 FOR SHARE", [tenantId, ctx.conversationId]);
    if (c.rows[0]?.status !== "bot") return "human" as const; // una persona tomó la conversación mientras pensábamos
    const r = await db.query(
      `INSERT INTO messages (tenant_id, conversation_id, direction, msg_type, body, reply_to, send_state)
       VALUES ($1, $2, 'out', 'text', $3, $4, 'sending')
       ON CONFLICT (tenant_id, reply_to) WHERE direction = 'out' AND reply_to IS NOT NULL DO NOTHING
       RETURNING id`,
      [tenantId, ctx.conversationId, text, ctx.messageId],
    );
    return r.rowCount ? (r.rows[0].id as string) : ("dup" as const);
  });
  if (reserved === "human") return "skipped_human";
  if (reserved === "dup") return "already_replied";
  const outId = reserved;

  const result = await (deps.send ?? sendText)(ctx.phoneId, token, ctx.waId, text);

  switch (result.kind) {
    case "sent": {
      await withTenant(tenantId, async (db) => {
        await db.query("UPDATE messages SET wa_message_id = $3, send_state = 'sent' WHERE tenant_id = $1 AND id = $2", [tenantId, outId, result.waMessageId]);
        await db.query("UPDATE conversations SET last_message_at = now() WHERE tenant_id = $1 AND id = $2", [tenantId, ctx.conversationId]);
        await db.query(
          `INSERT INTO agent_usage_daily (tenant_id, day, replies, input_tokens, output_tokens)
           VALUES ($1, (now() AT TIME ZONE 'utc')::date, 1, $2, $3)
           ON CONFLICT (tenant_id, day) DO UPDATE SET replies = agent_usage_daily.replies + 1,
             input_tokens = agent_usage_daily.input_tokens + EXCLUDED.input_tokens,
             output_tokens = agent_usage_daily.output_tokens + EXCLUDED.output_tokens`,
          [tenantId, usage.input, usage.output],
        );
      });
      if (wantsHandoff) {
        await handoff(tenantId, ctx.conversationId, handoffReason);
        return "handoff";
      }
      return "replied";
    }
    case "retry": {
      // No llegó a Meta: se borra la fila y se reintenta todo el trabajo más tarde.
      await withTenant(tenantId, (db) => db.query("DELETE FROM messages WHERE tenant_id = $1 AND id = $2 AND send_state = 'sending'", [tenantId, outId]));
      throw new Error(`No se pudo enviar todavía (${result.reason}); se reintentará`);
    }
    case "rejected": {
      await withTenant(tenantId, (db) =>
        db.query("UPDATE messages SET send_state = 'failed', send_error = $3 WHERE tenant_id = $1 AND id = $2", [tenantId, outId, `${result.code ?? result.status}: ${result.message}`.slice(0, 300)]),
      );
      await handoff(tenantId, ctx.conversationId, "envio_rechazado");
      return "send_failed";
    }
    case "unknown": {
      await withTenant(tenantId, (db) =>
        db.query("UPDATE messages SET send_state = 'unknown', send_error = $3 WHERE tenant_id = $1 AND id = $2", [tenantId, outId, result.reason.slice(0, 300)]),
      );
      await handoff(tenantId, ctx.conversationId, "envio_incierto");
      return "send_unknown";
    }
  }
}
