import type { Subscription } from "@/lib/billing/data";

/** Cuántos días antes del vencimiento empieza el aviso. */
export const WARN_DAYS = 5;

export interface SubscriptionNotice { level: "warn" | "error"; text: string }

/**
 * Aviso que ve el equipo según el estado de la suscripción. null = no hay nada que avisar.
 * `canPay`: solo el dueño puede pagar; los demás reciben la indicación de avisarle.
 */
export function subscriptionNotice(sub: Subscription | null, canPay: boolean): SubscriptionNotice | null {
  if (!sub) return null;
  const who = canPay ? "Paga desde «Plan y pagos» para reactivarlo." : "Avísale al dueño del negocio para que lo renueve.";
  if (sub.status === "past_due") {
    return { level: "error", text: `El período de tu plan terminó: el asistente no responde a tus clientes hasta que se renueve. ${who}` };
  }
  if (sub.status === "active" && sub.expiresAt !== null && sub.daysLeft !== null && sub.daysLeft <= WARN_DAYS) {
    if (sub.daysLeft <= 0) return { level: "warn", text: `Tu plan vence hoy. ${canPay ? "Renueva desde «Plan y pagos» para no interrumpir al asistente." : "Avísale al dueño para que lo renueve."}` };
    return { level: "warn", text: `Tu plan vence en ${sub.daysLeft} ${sub.daysLeft === 1 ? "día" : "días"}. ${canPay ? "Renueva desde «Plan y pagos» para no interrumpir al asistente." : "Avísale al dueño para que lo renueve."}` };
  }
  return null;
}
