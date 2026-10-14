import { formatMoney } from "@/lib/catalog/money";
import { WORK_TYPE_LABEL, type WorkType } from "@/lib/work/labels";
import type { MoneyByCurrency, Snapshot } from "./snapshot";

export const moneyText = (m: MoneyByCurrency[]): string => (m.length === 0 ? "ninguno" : m.map((x) => `${formatMoney(x.totalMinor, x.currency)} (${x.count})`).join(" + "));

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** El resumen como líneas de texto (lo usa el copiloto como única fuente de datos). Todo viene del servidor. */
export function snapshotLines(s: Snapshot): string[] {
  const L: string[] = [];
  L.push(`Fecha y zona del negocio: ${s.today} (${s.timezone}).`);
  L.push(`Mensajes hoy: ${s.messages.inToday} recibidos de ${plural(s.messages.peopleToday, "persona", "personas")} y ${s.messages.outToday} enviados. Ayer: ${s.messages.inYesterday} recibidos y ${s.messages.outYesterday} enviados.`);
  const types = Object.entries(s.attention.byType).map(([t, n]) => `${WORK_TYPE_LABEL[t as WorkType] ?? t}: ${n}`);
  L.push(`Conversaciones esperando a una persona: ${s.attention.humanConversations}.`);
  L.push(`Tareas abiertas: ${s.attention.openTasks}${types.length ? ` (${types.join("; ")})` : ""}; urgentes: ${s.attention.urgentTasks}; vencidas: ${s.attention.overdueTasks}.`);
  if (s.agenda) {
    L.push(`Citas hoy: ${s.agenda.todayCount}. Mañana: ${s.agenda.tomorrowCount}. Citas por confirmar (desde ahora): ${s.agenda.pendingConfirm}.`);
    if (s.agenda.todayList.length) L.push("Citas de hoy: " + s.agenda.todayList.map((a) => `${a.time} ${a.service} con ${a.customer}${a.status === "pendiente" ? " (por confirmar)" : ""}`).join("; ") + (s.agenda.todayCount > s.agenda.todayList.length ? "; (hay más)" : "") + ".");
  } else L.push("El negocio no usa agenda de citas.");
  if (s.orders) {
    L.push(`Pedidos por confirmar: ${s.orders.pending} (valor ${moneyText(s.orders.pendingTotals)}); de más de 24 horas: ${s.orders.pendingOlderThan24h}.`);
    L.push(`Pedidos creados hoy (sin cancelados): ${moneyText(s.orders.todayTotals)}.`);
    L.push(s.orders.lowStock.length ? "Poco stock: " + s.orders.lowStock.map((p) => `${p.name} (quedan ${p.stock})`).join("; ") + "." : "Poco stock: ningún producto.");
    L.push(`Productos agotados: ${s.orders.soldOutCount}.`);
  } else L.push("El negocio no usa catálogo ni pedidos.");
  return L;
}
