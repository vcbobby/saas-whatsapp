/**
 * Zonas horarias sin librerías externas (usa Intl, que ya trae la base IANA).
 * Todas las funciones son puras y se prueban con zonas con y sin horario de verano.
 */

export function isValidTimeZone(tz: string): boolean {
  if (!/^[A-Za-z]+(?:\/[A-Za-z0-9_+-]+){1,2}$/.test(tz)) return false; // solo nombres tipo "America/Caracas"
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

const fmtCache = new Map<string, Intl.DateTimeFormat>();
function formatter(tz: string): Intl.DateTimeFormat {
  let f = fmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric" });
    fmtCache.set(tz, f);
  }
  return f;
}

export interface LocalParts { year: number; month: number; day: number; hour: number; minute: number; second: number }

/** Fecha y hora que marca el reloj de esa zona en ese instante. */
export function localParts(utcMs: number, tz: string): LocalParts {
  const p: Record<string, number> = {};
  for (const part of formatter(tz).formatToParts(new Date(utcMs))) if (part.type !== "literal") p[part.type] = Number(part.value);
  return { year: p.year!, month: p.month!, day: p.day!, hour: p.hour! % 24, minute: p.minute!, second: p.second! };
}

function offsetMs(utcMs: number, tz: string): number {
  const p = localParts(utcMs, tz);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(utcMs / 1000) * 1000;
}

/**
 * Instante UTC (ms) en que el reloj de `tz` marca esa fecha y hora.
 * Devuelve null si esa hora NO existe (salto de horario de verano). Si existe dos veces, devuelve la primera.
 */
export function localToUtc(ymd: string, minutesOfDay: number, tz: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd);
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const h = Math.floor(minutesOfDay / 60);
  const mi = minutesOfDay % 60;
  const guess = Date.UTC(y, mo - 1, d, h, mi);
  const off1 = offsetMs(guess, tz);
  let t = guess - off1;
  const off2 = offsetMs(t, tz);
  if (off2 !== off1) t = guess - off2;
  const back = localParts(t, tz);
  if (back.year !== y || back.month !== mo || back.day !== d || back.hour !== h || back.minute !== mi) return null;
  return t;
}

export function isValidYmd(ymd: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd);
  if (!m) return false;
  const dt = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return dt.getUTCFullYear() === Number(m[1]) && dt.getUTCMonth() === Number(m[2]) - 1 && dt.getUTCDate() === Number(m[3]);
}

export function addDays(ymd: string, n: number): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd)!;
  const dt = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]) + n));
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, "0")}-${String(dt.getUTCDate()).padStart(2, "0")}`;
}

/** 1 = lunes … 7 = domingo. */
export function isoWeekday(ymd: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd)!;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))).getUTCDay();
  return d === 0 ? 7 : d;
}

/** Fecha local (AAAA-MM-DD) de un instante. */
export function localDate(utcMs: number, tz: string): string {
  const p = localParts(utcMs, tz);
  return `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
}

export function formatHm(minutes: number): string {
  return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
}

/** «08:30» → 510. null si no es válido. «24:00» solo sirve como fin de tramo (1440). */
export function parseHm(s: string, allowEndOfDay = false): number | null {
  const m = /^(\d{2}):(\d{2})$/.exec(s);
  if (!m) return null;
  const h = Number(m[1]), mi = Number(m[2]);
  if (mi > 59) return null;
  if (h === 24 && mi === 0) return allowEndOfDay ? 1440 : null;
  return h > 23 ? null : h * 60 + mi;
}
