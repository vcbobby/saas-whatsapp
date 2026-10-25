import { withTenant } from "@/lib/db";
import { getLlmEnv } from "@/lib/env";

/**
 * ¿Por qué el asistente NO está respondiendo ahora mismo? Junta en un solo lugar todas las causas que el agente
 * (src/lib/agent/run.ts) usa para descartar un mensaje en silencio, para poder explicárselas a la persona.
 */
export type BlockerCode = "suspended" | "past_due" | "trial_ended" | "disabled" | "no_whatsapp" | "no_llm" | "daily_limit";

export interface Blocker {
  code: BlockerCode;
  level: "error" | "warn";
  /** Frase lista para mostrar (sin secretos ni detalles técnicos). */
  text: string;
  /** Dónde se arregla. */
  href?: string;
  hrefLabel?: string;
}

export interface StatusInput {
  tenantStatus: string;
  trialEndsAt: Date | null;
  agentEnabled: boolean;
  whatsappConnected: boolean;
  /** null = la configuración de IA del servidor no es válida. */
  llmConfigured: boolean;
  repliesToday: number;
  dailyLimit: number;
  now?: Date;
}

export function computeBlockers(i: StatusInput): Blocker[] {
  const out: Blocker[] = [];
  const now = (i.now ?? new Date()).getTime();
  if (i.tenantStatus === "suspended") {
    out.push({ code: "suspended", level: "error", text: "La cuenta está suspendida: el asistente no responde. Escríbenos para reactivarla." });
  } else if (i.tenantStatus === "past_due") {
    out.push({ code: "past_due", level: "error", text: "El período de tu plan terminó: el asistente no responde a tus clientes hasta que se renueve.", href: "/plan", hrefLabel: "Ir a Plan y pagos" });
  } else if (i.tenantStatus === "trial" && i.trialEndsAt !== null && i.trialEndsAt.getTime() <= now) {
    out.push({ code: "trial_ended", level: "error", text: "Tu prueba gratis terminó: el asistente está en pausa y no responde a tus clientes. Elige un plan para reactivarlo.", href: "/plan", hrefLabel: "Ir a Plan y pagos" });
  }
  if (!i.agentEnabled) {
    out.push({ code: "disabled", level: "warn", text: "El asistente está apagado: nadie responde a tus clientes.", href: "/agente", hrefLabel: "Activarlo en Asistente" });
  }
  if (!i.whatsappConnected) {
    out.push({ code: "no_whatsapp", level: "warn", text: "No hay un número de WhatsApp conectado.", href: "/whatsapp", hrefLabel: "Conectar WhatsApp" });
  }
  if (!i.llmConfigured) {
    out.push({ code: "no_llm", level: "error", text: "La IA no está configurada en el servidor (LLM_PROVIDER, LLM_MODEL y LLM_API_KEY): el asistente no puede responder." });
  }
  if (i.repliesToday >= i.dailyLimit) {
    out.push({ code: "daily_limit", level: "warn", text: `Se alcanzó el tope diario de respuestas (${i.dailyLimit}). Mañana vuelve a responder solo.` });
  }
  return out;
}

/** Lee el estado real del negocio y devuelve lo que lo frena (lista vacía = todo en orden). */
export async function loadAssistantBlockers(tenantId: string): Promise<Blocker[]> {
  let llmConfigured = true;
  let dailyLimit = 300;
  try {
    const env = getLlmEnv();
    dailyLimit = env.AGENT_DAILY_REPLY_LIMIT;
    llmConfigured = true;
  } catch {
    llmConfigured = false;
  }
  const row = await withTenant(tenantId, async (db) => {
    const r = await db.query<{ status: string; trial_ends_at: Date | null; enabled: boolean | null; wa: boolean; replies: number }>(
      `SELECT t.status, t.trial_ends_at, a.enabled,
              EXISTS (SELECT 1 FROM tenant_integrations i WHERE i.tenant_id = t.id AND i.provider = 'whatsapp') AS wa,
              (SELECT count(*)::int FROM messages m
                WHERE m.tenant_id = t.id AND m.direction = 'out' AND m.reply_to IS NOT NULL AND m.send_state <> 'failed'
                  AND m.created_at >= (date_trunc('day', now() AT TIME ZONE 'utc') AT TIME ZONE 'utc')) AS replies
         FROM tenants t LEFT JOIN tenant_agents a ON a.tenant_id = t.id
        WHERE t.id = $1`,
      [tenantId],
    );
    return r.rows[0];
  });
  if (!row) return [];
  return computeBlockers({
    tenantStatus: row.status,
    trialEndsAt: row.trial_ends_at,
    agentEnabled: row.enabled ?? false,
    whatsappConnected: row.wa,
    llmConfigured,
    repliesToday: row.replies,
    dailyLimit,
  });
}
