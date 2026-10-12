import { addDays, isoWeekday, localDate, localToUtc } from "./tz";

export interface HoursRange { weekday: number; startMin: number; endMin: number }
export interface Interval { startMs: number; endMs: number }

export interface SlotInput {
  tz: string;
  nowMs: number;
  /** Primer día a calcular, AAAA-MM-DD (en la zona del negocio). */
  fromDate: string;
  /** Cuántos días calcular (máximo 31). */
  days: number;
  durationMin: number;
  stepMin: number;
  hours: HoursRange[];
  timeOff: Interval[];
  /** Citas activas (pendiente o confirmada). */
  busy: Interval[];
  minNoticeMin: number;
  maxDaysAhead: number;
}

export interface Slot {
  startsAt: string;
  endsAt: string;
  /** Fecha local del negocio. */
  date: string;
  /** Hora local del negocio, HH:MM. */
  time: string;
}

export const MAX_SLOT_DAYS = 31;
const overlaps = (a: Interval, b: Interval) => a.startMs < b.endMs && b.startMs < a.endMs;

/**
 * Huecos libres. Es LA ÚNICA fuente de verdad: lo que el cliente ve, lo que la persona elige a mano y lo que
 * valida el servidor al crear una cita salen de esta misma función.
 * Un hueco es válido si cabe entero en un tramo del horario, respeta el preaviso y el máximo de días,
 * y no choca con bloqueos ni con otras citas activas.
 */
export function computeSlots(i: SlotInput): Slot[] {
  const days = Math.max(0, Math.min(MAX_SLOT_DAYS, Math.floor(i.days)));
  const earliest = i.nowMs + i.minNoticeMin * 60_000;
  const latest = i.nowMs + i.maxDaysAhead * 86_400_000;
  const out: Slot[] = [];
  for (let n = 0; n < days; n++) {
    const date = addDays(i.fromDate, n);
    const ranges = i.hours.filter((h) => h.weekday === isoWeekday(date)).sort((a, b) => a.startMin - b.startMin);
    for (const r of ranges) {
      for (let t = r.startMin; t + i.durationMin <= r.endMin; t += i.stepMin) {
        const start = localToUtc(date, t, i.tz);
        if (start === null) continue; // esa hora no existe (cambio de horario)
        if (start < earliest || start >= latest) continue;
        const slot: Interval = { startMs: start, endMs: start + i.durationMin * 60_000 };
        if (i.timeOff.some((o) => overlaps(slot, o)) || i.busy.some((b) => overlaps(slot, b))) continue;
        const hh = String(Math.floor(t / 60)).padStart(2, "0");
        const mm = String(t % 60).padStart(2, "0");
        out.push({ startsAt: new Date(slot.startMs).toISOString(), endsAt: new Date(slot.endMs).toISOString(), date, time: `${hh}:${mm}` });
      }
    }
  }
  return out.sort((a, b) => a.startsAt.localeCompare(b.startsAt));
}

/** ¿Este inicio exacto es un hueco libre? (Para validar una cita antes de guardarla.) */
export function isSlotAvailable(i: Omit<SlotInput, "fromDate" | "days">, startIso: string): boolean {
  const ms = Date.parse(startIso);
  if (Number.isNaN(ms)) return false;
  const date = localDate(ms, i.tz);
  return computeSlots({ ...i, fromDate: date, days: 1 }).some((s) => Date.parse(s.startsAt) === ms);
}
