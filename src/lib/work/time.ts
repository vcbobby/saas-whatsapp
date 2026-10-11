// Fechas legibles en español (sin dependencias; se usa en las pantallas).

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/** "ahora", "hace 5 min", "hace 3 h", "hace 2 días" o la fecha si pasó más de una semana. */
export function relativeTime(value: string | Date | null | undefined, now: number = Date.now()): string {
  if (!value) return "";
  const t = typeof value === "string" ? Date.parse(value) : value.getTime();
  if (Number.isNaN(t)) return "";
  const diff = now - t;
  if (diff < -MIN) return "en el futuro";
  if (diff < MIN) return "ahora";
  if (diff < HOUR) return `hace ${Math.floor(diff / MIN)} min`;
  if (diff < DAY) return `hace ${Math.floor(diff / HOUR)} h`;
  if (diff < 7 * DAY) {
    const d = Math.floor(diff / DAY);
    return d === 1 ? "hace 1 día" : `hace ${d} días`;
  }
  return new Intl.DateTimeFormat("es-VE", { day: "numeric", month: "short" }).format(t);
}

/** Fecha límite: "Venció hace 2 h" (atrasada) o "Vence hoy, 3:00 p. m." / "Vence el 5 oct, 10:00 a. m.". */
export function dueInfo(value: string | null | undefined, now: number = Date.now()): { text: string; overdue: boolean } | null {
  if (!value) return null;
  const t = Date.parse(value);
  if (Number.isNaN(t)) return null;
  if (t < now) return { text: `Venció ${relativeTime(value, now)}`, overdue: true };
  const time = new Intl.DateTimeFormat("es-VE", { hour: "numeric", minute: "2-digit" }).format(t);
  const sameDay = new Date(t).toDateString() === new Date(now).toDateString();
  if (sameDay) return { text: `Vence hoy, ${time}`, overdue: false };
  const date = new Intl.DateTimeFormat("es-VE", { day: "numeric", month: "short" }).format(t);
  return { text: `Vence el ${date}, ${time}`, overdue: false };
}

/** Hora de un mensaje: "3:05 p. m." hoy, o "5 oct, 3:05 p. m." otro día. */
export function messageTime(value: string, now: number = Date.now()): string {
  const t = Date.parse(value);
  if (Number.isNaN(t)) return "";
  const time = new Intl.DateTimeFormat("es-VE", { hour: "numeric", minute: "2-digit" }).format(t);
  if (new Date(t).toDateString() === new Date(now).toDateString()) return time;
  return `${new Intl.DateTimeFormat("es-VE", { day: "numeric", month: "short" }).format(t)}, ${time}`;
}
