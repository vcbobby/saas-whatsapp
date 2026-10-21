import { z } from "zod";
import { getPool } from "@/lib/db";

const n = z.coerce.number();
const usageSchema = z.object({
  tz: z.string(),
  today: z.string(),
  totals30: z.object({
    messagesIn: n, messagesOut: n, agentReplies: n, agentTokens: n, agentErrors: n,
    copilotQuestions: n, copilotTokens: n, copilotErrors: n, activeTenants: n, liveTenants: n,
  }),
  daily: z.array(z.object({ day: z.string(), messagesIn: n, replies: n, tokens: n, errors: n })),
  modules: z.array(z.object({ key: z.string(), label: z.string(), tenants: n })),
  health7: z.object({
    sendFailed: n, deliveryFailed: n, processFailed: n, aiErrors: n, kbFailed: n, webhooksFailed: n, notificationsFailed: n,
    injection: n, promptLeak: n, blockedOutput: n, contactLimited: n,
  }),
  top: z.array(z.object({ name: z.string(), status: z.string(), replies: n, tokens: n, questions: n, errors: n })),
});
export type AdminUsage = z.infer<typeof usageSchema>;

/** Uso y salud de la plataforma. La función de la base de datos exige súper admin con 2FA y devuelve solo cifras. */
export async function getAdminUsage(tokenHash: Buffer): Promise<AdminUsage> {
  const r = await getPool().query("SELECT admin_usage($1) AS u", [tokenHash]);
  return usageSchema.parse(r.rows[0].u);
}

/** «1.234» / «12,3 mil» / «1,2 M» (millones) / «3 mil M» (miles de millones): tokens legibles. */
export function formatTokens(v: number): string {
  if (v < 10_000) return Math.round(v).toLocaleString("es");
  if (v < 1_000_000) return `${(v / 1000).toLocaleString("es", { maximumFractionDigits: 1 })} mil`;
  if (v < 1_000_000_000) return `${(v / 1_000_000).toLocaleString("es", { maximumFractionDigits: 2 })} M`;
  return `${(v / 1_000_000_000).toLocaleString("es", { maximumFractionDigits: 2 })} mil M`; // mil millones
}

export interface HealthItem { key: string; label: string; n: number; level: "ok" | "warn"; hint: string }

/** Semáforo de salud (últimos 7 días): en verde si es 0, en aviso si hay algo. Cada línea dice qué significa. */
export function healthItems(h: AdminUsage["health7"]): HealthItem[] {
  const row = (key: string, label: string, v: number, hint: string): HealthItem => ({ key, label, n: v, level: v > 0 ? "warn" : "ok", hint });
  return [
    row("aiErrors", "fallos de la IA", h.aiErrors, "El proveedor de IA no respondió o dio error. Si crecen, revisa la clave, el saldo y el estado del proveedor."),
    row("sendFailed", "respuestas que no se pudieron enviar", h.sendFailed, "WhatsApp rechazó el envío (token vencido, número desconectado o fuera de la ventana de 24 h)."),
    row("deliveryFailed", "mensajes no entregados al cliente", h.deliveryFailed, "WhatsApp aceptó el mensaje pero no llegó al cliente."),
    row("processFailed", "mensajes recibidos sin procesar", h.processFailed, "Llegó un mensaje y el asistente no pudo atenderlo. Puede quedar sin respuesta."),
    row("kbFailed", "documentos de Conocimiento fallidos", h.kbFailed, "No se pudieron indexar; el asistente no los usa. Se cuenta el total actual, no solo la última semana."),
    row("webhooksFailed", "avisos a otras aplicaciones fallidos", h.webhooksFailed, "Una conexión de un negocio no recibió su aviso."),
    row("notificationsFailed", "avisos a clientes fallidos", h.notificationsFailed, "Una automatización no pudo escribirle a un cliente."),
  ];
}

/** Señales de abuso o de comportamiento raro del asistente (no son errores: son cosas que se frenaron). */
export function safetyItems(h: AdminUsage["health7"]): { key: string; label: string; n: number }[] {
  return [
    { key: "injection", label: "Intentos de manipular al asistente", n: h.injection },
    { key: "promptLeak", label: "Respuestas bloqueadas por filtrar instrucciones", n: h.promptLeak },
    { key: "blockedOutput", label: "Respuestas bloqueadas por enlaces o correos inventados", n: h.blockedOutput },
    { key: "contactLimited", label: "Contactos frenados por escribir demasiado", n: h.contactLimited },
  ];
}

/** Porcentaje (0–100) de negocios vivos que usan un módulo; 0 si no hay negocios. */
export function adoptionPct(tenants: number, live: number): number {
  if (live <= 0) return 0;
  return Math.min(100, Math.round((tenants / live) * 100));
}
