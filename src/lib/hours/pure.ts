import { addDays, formatHm, isoWeekday, localDate, localParts } from "@/lib/agenda/tz";

export interface Range { weekday: number; startMin: number; endMin: number }
export interface Opening { /** 0 = hoy, 1 = mañana… */ daysAhead: number; weekday: number; startMin: number }

const DAY_NAMES = ["", "lunes", "martes", "miércoles", "jueves", "viernes", "sábado", "domingo"];
export const dayName = (n: number) => DAY_NAMES[n] ?? "";

/** «8:00 a. m.», «1:30 p. m.», «medianoche». */
export function hmLabel(min: number): string {
  if (min >= 1440) return "medianoche";
  const h = Math.floor(min / 60), m = min % 60;
  return `${h % 12 === 0 ? 12 : h % 12}:${String(m).padStart(2, "0")} ${h < 12 ? "a. m." : "p. m."}`;
}

/** ¿Hay atención en ese instante (hora local del negocio)? */
export function isOpen(ranges: Range[], tz: string, nowMs: number): boolean {
  const p = localParts(nowMs, tz);
  const wd = isoWeekday(localDate(nowMs, tz));
  const min = p.hour * 60 + p.minute;
  return ranges.some((r) => r.weekday === wd && min >= r.startMin && min < r.endMin);
}

/** La próxima apertura (hoy más tarde o dentro de los próximos 7 días). null si no hay ningún tramo. */
export function nextOpening(ranges: Range[], tz: string, nowMs: number): Opening | null {
  if (ranges.length === 0) return null;
  const today = localDate(nowMs, tz);
  const p = localParts(nowMs, tz);
  const nowMin = p.hour * 60 + p.minute;
  for (let d = 0; d <= 7; d++) {
    const wd = isoWeekday(addDays(today, d));
    const starts = ranges.filter((r) => r.weekday === wd && (d > 0 || r.startMin > nowMin)).map((r) => r.startMin).sort((a, b) => a - b);
    if (starts.length) return { daysAhead: d, weekday: wd, startMin: starts[0]! };
  }
  return null;
}

/** «hoy a las 2:00 p. m.», «mañana a las 8:00 a. m.», «el lunes a las 8:00 a. m.». */
export function openingText(o: Opening): string {
  const when = o.daysAhead === 0 ? "hoy" : o.daysAhead === 1 ? "mañana" : `el ${dayName(o.weekday)}`;
  return `${when} a las ${hmLabel(o.startMin)}`;
}

/** El aviso que se añade cuando el cliente pide una persona fuera de horario. */
export function closedNotice(ranges: Range[], tz: string, nowMs: number, note?: string | null): string {
  const next = nextOpening(ranges, tz, nowMs);
  const when = next ? openingText(next) : "en cuanto volvamos";
  const base = `Ahora estamos fuera de horario; una persona te atenderá ${when}${when.endsWith(".") ? "" : "."}`;
  const extra = (note ?? "").replace(/\s+/g, " ").trim();
  return extra ? `${base} ${extra}` : base;
}

/** Resumen compacto del horario para el asistente: «lunes a viernes 8:00 a. m.–5:00 p. m.; sábado …». */
export function scheduleText(ranges: Range[]): string {
  if (ranges.length === 0) return "";
  const byDay = new Map<number, string>();
  for (let wd = 1; wd <= 7; wd++) {
    const rs = ranges.filter((r) => r.weekday === wd).sort((a, b) => a.startMin - b.startMin);
    byDay.set(wd, rs.map((r) => `${hmLabel(r.startMin)} a ${hmLabel(r.endMin)}`).join(" y "));
  }
  const parts: string[] = [];
  let wd = 1;
  while (wd <= 7) {
    const v = byDay.get(wd)!;
    let end = wd;
    while (end < 7 && byDay.get(end + 1) === v) end++;
    if (v) parts.push(`${end === wd ? dayName(wd) : end === wd + 1 ? `${dayName(wd)} y ${dayName(end)}` : `${dayName(wd)} a ${dayName(end)}`}: ${v}`);
    wd = end + 1;
  }
  return parts.join("; ");
}
export { formatHm };
