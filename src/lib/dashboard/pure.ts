import { addDays } from "@/lib/agenda/tz";
import type { Currency } from "@/lib/catalog/money";
import type { PlanModule } from "@/lib/plans/usage";

/** Días que muestran los gráficos (incluye hoy). */
export const DASH_DAYS = 14;

export interface DayPoint { day: string; inbound: number; outbound: number; appointments: number; orders: number }
export interface MoneyTotal { currency: Currency; totalMinor: number }
export interface Delta { current: number; previous: number }

export interface ChecklistItem { key: "whatsapp" | "agente" | "conocimiento" | "catalogo" | "equipo" | "mensaje"; label: string; hint: string; href: string; done: boolean }

export interface DashboardData {
  timezone: string;
  today: string;
  modules: PlanModule[];
  days: DayPoint[];
  /** Últimos 7 días contra los 7 anteriores. */
  week: { inbound: Delta; outbound: Delta; people: Delta; appointments: Delta; orders: Delta; sales: MoneyTotal[] };
  checklist: ChecklistItem[];
  /** Estado del asistente de bienvenida (si lo saltó, Inicio le ofrece retomarlo). */
  onboarding: "pending" | "done" | "skipped";
}

/** Rellena con ceros los días sin datos y deja la lista ordenada del más antiguo a hoy. Pura: se prueba sola. */
export function fillDays(today: string, rows: Map<string, Partial<Omit<DayPoint, "day">>>, n = DASH_DAYS): DayPoint[] {
  const out: DayPoint[] = [];
  for (let i = n - 1; i >= 0; i--) {
    const day = addDays(today, -i);
    const r = rows.get(day) ?? {};
    out.push({ day, inbound: r.inbound ?? 0, outbound: r.outbound ?? 0, appointments: r.appointments ?? 0, orders: r.orders ?? 0 });
  }
  return out;
}

export function sumDays(days: DayPoint[], key: Exclude<keyof DayPoint, "day">, from: number, to: number): number {
  let s = 0;
  for (let i = from; i < to && i < days.length; i++) s += days[i]![key];
  return s;
}

/** Variación porcentual redondeada; null si no hay base con la que comparar. */
export function pctChange(d: Delta): number | null {
  if (d.previous <= 0) return null;
  return Math.round(((d.current - d.previous) / d.previous) * 100);
}

export function buildChecklist(f: { whatsapp: boolean; agent: boolean; kb: boolean; catalog: boolean; team: boolean; message: boolean; sells?: boolean }): ChecklistItem[] {
  return [
    { key: "whatsapp", label: "Conecta tu WhatsApp", hint: "Sin esto el asistente no puede recibir mensajes.", href: "/whatsapp", done: f.whatsapp },
    { key: "agente", label: "Activa y configura tu asistente", hint: "Dile su nombre y cómo atiendes.", href: "/agente", done: f.agent },
    { key: "conocimiento", label: "Enséñale con tus preguntas frecuentes", hint: "Horarios, precios, ubicación, políticas.", href: "/conocimiento", done: f.kb },
    { key: "catalogo", label: "Carga tus servicios o productos", hint: "Para que el asistente pueda agendar o tomar pedidos.", href: f.sells ? "/catalogo" : "/agenda", done: f.catalog },
    { key: "equipo", label: "Invita a tu equipo", hint: "Para que más personas atiendan a los clientes.", href: "/equipo", done: f.team },
    { key: "mensaje", label: "Recibe tu primer mensaje", hint: "Prueba escribiéndole a tu número desde otro teléfono.", href: "/conversaciones", done: f.message },
  ];
}

