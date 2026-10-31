import { formatMoney, isCurrency, type Currency } from "@/lib/catalog/money";

export interface Delta { current: number; previous: number }
export interface Report {
  timezone: string;
  /** Primer y último día (locales, AAAA-MM-DD) del período, ambos incluidos. */
  from: string; to: string; days: number;
  conversations: number;
  newCustomers: Delta;
  inbound: Delta;
  byAssistant: number;
  byPerson: number;
  handoffs: number;
  resolvedByAssistant: number;
  /** Mediana de segundos que tardó la primera respuesta; null si no hubo. */
  replyAssistantSecs: number | null;
  replyPersonSecs: number | null;
  /** Mensajes recibidos por hora local (0–23). */
  hours: number[];
  orders: Delta;
  sales: { currency: Currency; totalMinor: number }[];
  topProducts: { name: string; quantity: number }[];
  appointments: Delta & { completed: number; noShow: number; cancelled: number };
}

/** «45 s», «3 min», «2 h 10 min». */
export function fmtDuration(secs: number | null): string {
  if (secs === null || !Number.isFinite(secs)) return "–";
  const s = Math.round(secs);
  if (s < 60) return `${s} s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  const r = m % 60;
  return r ? `${h} h ${r} min` : `${h} h`;
}

/** Variación porcentual redondeada (null si no hay base de comparación). */
export function pct(d: Delta): number | null {
  if (d.previous <= 0) return null;
  return Math.round(((d.current - d.previous) / d.previous) * 100);
}

/** «+12 % que antes», «sin cambios», «antes no había». */
export function vsText(d: Delta): string {
  if (d.current === 0 && d.previous === 0) return "";
  const p = pct(d);
  if (p === null) return " (antes no había)";
  if (p === 0) return " (igual que el período anterior)";
  return ` (${p > 0 ? "+" : ""}${p} % frente al período anterior)`;
}

/** Las horas con más mensajes (hora de inicio, 0–23). Vacío si no hubo mensajes. */
export function peakHours(hours: number[], n = 2): number[] {
  return hours.map((v, h) => ({ v, h })).filter((x) => x.v > 0).sort((a, b) => b.v - a.v || a.h - b.h).slice(0, n).map((x) => x.h).sort((a, b) => a - b);
}
export const hourLabel = (h: number) => `${h % 12 === 0 ? 12 : h % 12} ${h < 12 ? "a. m." : "p. m."}`;

/** ¿Hubo algo que contar? (si no, no se manda el correo de la semana). */
export function hasActivity(r: Report): boolean {
  return r.inbound.current > 0 || r.orders.current > 0 || r.appointments.current > 0 || r.newCustomers.current > 0;
}

const n = (x: number, one: string, many: string) => `${x} ${x === 1 ? one : many}`;
const ymd = (s: string) => new Intl.DateTimeFormat("es-VE", { day: "numeric", month: "short", timeZone: "UTC" }).format(new Date(`${s}T00:00:00Z`));
export const periodText = (r: Pick<Report, "from" | "to">) => `${ymd(r.from)} al ${ymd(r.to)}`;

/** Líneas de texto del reporte (para el correo). */
export function reportLines(r: Report): string[] {
  const out: string[] = [];
  out.push(`Atendiste ${n(r.conversations, "conversación", "conversaciones")} y recibiste ${n(r.inbound.current, "mensaje", "mensajes")}${vsText(r.inbound)}.`);
  if (r.newCustomers.current > 0) out.push(`Clientes nuevos: ${r.newCustomers.current}${vsText(r.newCustomers)}.`);
  if (r.byAssistant + r.byPerson > 0) {
    const total = r.byAssistant + r.byPerson;
    out.push(`El asistente envió ${r.byAssistant} respuestas (${Math.round((r.byAssistant / total) * 100)} %) y tu equipo ${r.byPerson}.`);
  }
  if (r.conversations > 0) out.push(`${n(r.resolvedByAssistant, "conversación se resolvió", "conversaciones se resolvieron")} solo con el asistente; ${n(r.handoffs, "pasó", "pasaron")} a una persona.`);
  if (r.replyAssistantSecs !== null || r.replyPersonSecs !== null) {
    out.push(`Tiempo típico de primera respuesta: asistente ${fmtDuration(r.replyAssistantSecs)}, equipo ${fmtDuration(r.replyPersonSecs)}.`);
  }
  const peak = peakHours(r.hours);
  if (peak.length) out.push(`Tus clientes escriben más ${peak.length === 1 ? "a las" : "entre las"} ${peak.map(hourLabel).join(" y ")}.`);
  if (r.orders.current > 0) {
    const sales = r.sales.map((s) => formatMoney(s.totalMinor, s.currency)).join(" + ");
    out.push(`Pedidos: ${r.orders.current}${vsText(r.orders)}${sales ? `. Vendido (confirmado o entregado): ${sales}` : ""}.`);
    if (r.topProducts.length) out.push(`Lo más pedido: ${r.topProducts.map((p) => `${p.name} (${p.quantity})`).join(", ")}.`);
  }
  if (r.appointments.current > 0) {
    out.push(`Citas: ${r.appointments.current}${vsText(r.appointments)}; ${r.appointments.completed} completadas, ${r.appointments.cancelled} canceladas, ${r.appointments.noShow} sin asistir.`);
  }
  return out;
}

export function normalizeSales(rows: { currency: string; total: string | number }[]): { currency: Currency; totalMinor: number }[] {
  return rows.filter((r) => isCurrency(r.currency)).map((r) => ({ currency: r.currency as Currency, totalMinor: Number(r.total) }));
}
