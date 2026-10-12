#!/usr/bin/env bash
# Paso 13A: agenda (servicios, horario semanal, zona horaria, bloqueos y cálculo de horarios libres).
# Ejecútalo desde la raíz del proyecto:  bash aplicar-paso-13a.sh
set -euo pipefail

[ -f package.json ] && grep -q '"name": "saas-whatsapp"' package.json || { echo "✖ Ejecuta esto dentro de ~/proyectos/saas-whatsapp"; exit 1; }
[ -f db/migrations/0012_estilo_asistente.sql ] || { echo "✖ Falta el Paso 12 (migración 0012). Aplícalo primero."; exit 1; }

if [ "$(git rev-parse --abbrev-ref HEAD 2>/dev/null)" = "main" ]; then
  git checkout -b paso-13a 2>/dev/null || git checkout paso-13a
  echo "✔ Rama paso-13a lista"
fi

BK=".paso13a-backup"
mkdir -p "$BK"
backup() { if [ -f "$1" ]; then mkdir -p "$BK/$(dirname "$1")"; cp "$1" "$BK/$1"; fi; }
grep -q "^.paso13a-backup" .gitignore 2>/dev/null || printf "\n.paso13a-backup/\n" >> .gitignore
backup db/migrations/0013_agenda.sql
backup src/lib/agenda/tz.ts
backup src/lib/agenda/slots.ts
backup src/lib/agenda/load.ts
backup src/lib/agenda/labels.ts
backup src/lib/auth/permissions.ts
backup src/app/api/agenda/config/route.ts
backup src/app/api/agenda/settings/route.ts
backup src/app/api/agenda/hours/route.ts
backup src/app/api/agenda/services/route.ts
backup src/app/api/agenda/services/update/route.ts
backup src/app/api/agenda/time-off/route.ts
backup src/app/api/agenda/time-off/delete/route.ts
backup src/app/api/agenda/slots/route.ts
backup src/components/AgendaConfig.tsx
backup src/components/AppHeader.tsx
backup src/app/agenda/page.tsx
backup tests/agenda-tz.test.ts
backup tests/agenda.test.ts

mkdir -p db/migrations
cat > db/migrations/0013_agenda.sql <<'EOF_DB_MIGRATIONS_0013_AGENDA_SQL'
-- Paso 13A: agenda (servicios, horario semanal, bloqueos) y tabla de citas.
-- btree_gist permite la regla "no se cruzan dos citas del mismo negocio" directamente en la base de datos.
-- (Es una extensión de confianza: la puede crear el dueño de la base, app_owner.)
CREATE EXTENSION IF NOT EXISTS btree_gist;

-- ------------------------------------------------------------ ajustes
CREATE TABLE agenda_settings (
  tenant_id uuid PRIMARY KEY REFERENCES tenants (id) ON DELETE CASCADE,
  timezone text NOT NULL DEFAULT 'America/Caracas' CHECK (char_length(timezone) BETWEEN 3 AND 64),
  min_notice_minutes integer NOT NULL DEFAULT 120 CHECK (min_notice_minutes BETWEEN 0 AND 10080),
  max_days_ahead integer NOT NULL DEFAULT 30 CHECK (max_days_ahead BETWEEN 1 AND 365),
  slot_step_minutes integer NOT NULL DEFAULT 30 CHECK (slot_step_minutes IN (5, 10, 15, 20, 30, 45, 60)),
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid
);
ALTER TABLE agenda_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE agenda_settings FORCE ROW LEVEL SECURITY;
CREATE POLICY agenda_settings_aislamiento ON agenda_settings
  USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());

-- ------------------------------------------------------------ servicios
-- No se borran: se desactivan (las citas viejas siguen apuntando a ellos).
CREATE TABLE agenda_services (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 80),
  duration_minutes integer NOT NULL CHECK (duration_minutes BETWEEN 5 AND 480),
  price_text text CHECK (char_length(price_text) <= 40),
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id)
);
CREATE UNIQUE INDEX agenda_services_nombre_idx ON agenda_services (tenant_id, lower(name)) WHERE active;
ALTER TABLE agenda_services ENABLE ROW LEVEL SECURITY;
ALTER TABLE agenda_services FORCE ROW LEVEL SECURITY;
CREATE POLICY agenda_services_aislamiento ON agenda_services
  USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());

-- ------------------------------------------------------------ horario semanal
-- weekday: 1 = lunes … 7 = domingo. Minutos desde la medianoche, en la zona horaria del negocio.
-- La regla EXCLUDE impide dos tramos que se pisen el mismo día.
CREATE TABLE agenda_hours (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  weekday smallint NOT NULL CHECK (weekday BETWEEN 1 AND 7),
  start_min smallint NOT NULL CHECK (start_min BETWEEN 0 AND 1439),
  end_min smallint NOT NULL CHECK (end_min BETWEEN 1 AND 1440),
  CHECK (start_min < end_min),
  EXCLUDE USING gist (tenant_id WITH =, weekday WITH =, int4range(start_min::int, end_min::int) WITH &&)
);
ALTER TABLE agenda_hours ENABLE ROW LEVEL SECURITY;
ALTER TABLE agenda_hours FORCE ROW LEVEL SECURITY;
CREATE POLICY agenda_hours_aislamiento ON agenda_hours
  USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());

-- ------------------------------------------------------------ bloqueos (vacaciones, feriados…)
CREATE TABLE agenda_time_off (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  reason text CHECK (char_length(reason) <= 200),
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (starts_at < ends_at),
  CHECK (ends_at - starts_at <= interval '400 days')
);
CREATE INDEX agenda_time_off_idx ON agenda_time_off (tenant_id, ends_at);
ALTER TABLE agenda_time_off ENABLE ROW LEVEL SECURITY;
ALTER TABLE agenda_time_off FORCE ROW LEVEL SECURITY;
CREATE POLICY agenda_time_off_aislamiento ON agenda_time_off
  USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());

-- ------------------------------------------------------------ citas
-- Un solo calendario por negocio: dos citas activas (pendiente/confirmada) no pueden cruzarse.
-- La regla vive en la base de datos, así que ningún error de código puede dejar una cita doble.
CREATE TABLE appointments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  service_id uuid NOT NULL,
  contact_id uuid,
  conversation_id uuid,
  customer_name text NOT NULL CHECK (char_length(customer_name) BETWEEN 1 AND 120),
  customer_phone text CHECK (char_length(customer_phone) <= 32),
  notes text CHECK (char_length(notes) <= 1000),
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'pendiente' CHECK (status IN ('pendiente', 'confirmada', 'cancelada', 'completada', 'no_asistio')),
  source text NOT NULL CHECK (source IN ('manual', 'agente')),
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (starts_at < ends_at),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, service_id) REFERENCES agenda_services (tenant_id, id),
  FOREIGN KEY (tenant_id, contact_id) REFERENCES contacts (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, conversation_id) REFERENCES conversations (tenant_id, id) ON DELETE CASCADE,
  EXCLUDE USING gist (tenant_id WITH =, tstzrange(starts_at, ends_at) WITH &&) WHERE (status IN ('pendiente', 'confirmada'))
);
CREATE INDEX appointments_agenda_idx ON appointments (tenant_id, starts_at);
ALTER TABLE appointments ENABLE ROW LEVEL SECURITY;
ALTER TABLE appointments FORCE ROW LEVEL SECURITY;
CREATE POLICY appointments_aislamiento ON appointments
  USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());
EOF_DB_MIGRATIONS_0013_AGENDA_SQL
echo "✔ db/migrations/0013_agenda.sql"
mkdir -p src/lib/agenda
cat > src/lib/agenda/tz.ts <<'EOF_SRC_LIB_AGENDA_TZ_TS'
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
EOF_SRC_LIB_AGENDA_TZ_TS
echo "✔ src/lib/agenda/tz.ts"
mkdir -p src/lib/agenda
cat > src/lib/agenda/slots.ts <<'EOF_SRC_LIB_AGENDA_SLOTS_TS'
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
EOF_SRC_LIB_AGENDA_SLOTS_TS
echo "✔ src/lib/agenda/slots.ts"
mkdir -p src/lib/agenda
cat > src/lib/agenda/load.ts <<'EOF_SRC_LIB_AGENDA_LOAD_TS'
import type { PoolClient } from "pg";
import { computeSlots, isSlotAvailable, MAX_SLOT_DAYS, type HoursRange, type Slot, type SlotInput } from "./slots";
import { addDays, localToUtc } from "./tz";

export interface AgendaSettings { timezone: string; minNoticeMinutes: number; maxDaysAhead: number; slotStepMinutes: number }
export const DEFAULT_AGENDA: AgendaSettings = { timezone: "America/Caracas", minNoticeMinutes: 120, maxDaysAhead: 30, slotStepMinutes: 30 };

type Db = Pick<PoolClient, "query">;

export async function loadSettings(db: Db, tenantId: string): Promise<AgendaSettings> {
  const r = await db.query("SELECT timezone, min_notice_minutes, max_days_ahead, slot_step_minutes FROM agenda_settings WHERE tenant_id = $1", [tenantId]);
  const x = r.rows[0];
  return x ? { timezone: x.timezone, minNoticeMinutes: x.min_notice_minutes, maxDaysAhead: x.max_days_ahead, slotStepMinutes: x.slot_step_minutes } : DEFAULT_AGENDA;
}

export async function loadHours(db: Db, tenantId: string): Promise<HoursRange[]> {
  const r = await db.query("SELECT weekday, start_min, end_min FROM agenda_hours WHERE tenant_id = $1 ORDER BY weekday, start_min", [tenantId]);
  return r.rows.map((x) => ({ weekday: x.weekday, startMin: x.start_min, endMin: x.end_min }));
}

/** Todo lo necesario para calcular huecos de un servicio entre dos instantes. */
async function slotContext(db: Db, tenantId: string, serviceId: string, fromMs: number, toMs: number): Promise<Omit<SlotInput, "fromDate" | "days"> | null> {
  const svc = await db.query("SELECT duration_minutes FROM agenda_services WHERE tenant_id = $1 AND id = $2 AND active", [tenantId, serviceId]);
  if (svc.rowCount !== 1) return null;
  const settings = await loadSettings(db, tenantId);
  const hours = await loadHours(db, tenantId);
  const range = [new Date(fromMs).toISOString(), new Date(toMs).toISOString()];
  const off = await db.query("SELECT starts_at, ends_at FROM agenda_time_off WHERE tenant_id = $1 AND ends_at > $2 AND starts_at < $3", [tenantId, ...range]);
  const busy = await db.query(
    "SELECT starts_at, ends_at FROM appointments WHERE tenant_id = $1 AND status IN ('pendiente', 'confirmada') AND ends_at > $2 AND starts_at < $3",
    [tenantId, ...range],
  );
  const iv = (r: { starts_at: Date; ends_at: Date }) => ({ startMs: r.starts_at.getTime(), endMs: r.ends_at.getTime() });
  return {
    tz: settings.timezone, nowMs: Date.now(), durationMin: svc.rows[0].duration_minutes, stepMin: settings.slotStepMinutes, hours,
    timeOff: off.rows.map(iv), busy: busy.rows.map(iv), minNoticeMin: settings.minNoticeMinutes, maxDaysAhead: settings.maxDaysAhead,
  };
}

/** Huecos libres de un servicio desde `fromDate` durante `days` días. null = el servicio no existe o está inactivo. */
export async function slotsForService(db: Db, tenantId: string, serviceId: string, fromDate: string, days: number): Promise<Slot[] | null> {
  const d = Math.max(1, Math.min(MAX_SLOT_DAYS, days));
  const settings = await loadSettings(db, tenantId);
  // Ventana amplia (un día de margen a cada lado) para cubrir diferencias de zona horaria.
  const from = (localToUtc(addDays(fromDate, -1), 0, settings.timezone) ?? Date.parse(fromDate) - 86_400_000);
  const to = (localToUtc(addDays(fromDate, d + 1), 0, settings.timezone) ?? Date.parse(fromDate) + (d + 1) * 86_400_000);
  const ctx = await slotContext(db, tenantId, serviceId, from, to);
  if (!ctx) return null;
  return computeSlots({ ...ctx, fromDate, days: d });
}

/** ¿Ese inicio exacto sigue libre para ese servicio? null = servicio inexistente. */
export async function checkSlot(db: Db, tenantId: string, serviceId: string, startIso: string): Promise<boolean | null> {
  const ms = Date.parse(startIso);
  if (Number.isNaN(ms)) return false;
  const ctx = await slotContext(db, tenantId, serviceId, ms - 86_400_000, ms + 2 * 86_400_000);
  if (!ctx) return null;
  return isSlotAvailable(ctx, startIso);
}
EOF_SRC_LIB_AGENDA_LOAD_TS
echo "✔ src/lib/agenda/load.ts"
mkdir -p src/lib/agenda
cat > src/lib/agenda/labels.ts <<'EOF_SRC_LIB_AGENDA_LABELS_TS'
export const WEEKDAYS = [
  { n: 1, label: "Lunes" },
  { n: 2, label: "Martes" },
  { n: 3, label: "Miércoles" },
  { n: 4, label: "Jueves" },
  { n: 5, label: "Viernes" },
  { n: 6, label: "Sábado" },
  { n: 7, label: "Domingo" },
] as const;

/** Zonas más comunes entre hispanohablantes. (La API acepta cualquier nombre IANA válido.) */
export const COMMON_TIMEZONES: { id: string; label: string }[] = [
  { id: "America/Caracas", label: "Venezuela (Caracas)" },
  { id: "America/Bogota", label: "Colombia (Bogotá)" },
  { id: "America/Mexico_City", label: "México (Ciudad de México)" },
  { id: "America/Argentina/Buenos_Aires", label: "Argentina (Buenos Aires)" },
  { id: "America/Santiago", label: "Chile (Santiago)" },
  { id: "America/Lima", label: "Perú (Lima)" },
  { id: "America/Guayaquil", label: "Ecuador (Guayaquil)" },
  { id: "America/La_Paz", label: "Bolivia (La Paz)" },
  { id: "America/Montevideo", label: "Uruguay (Montevideo)" },
  { id: "America/Asuncion", label: "Paraguay (Asunción)" },
  { id: "America/Panama", label: "Panamá" },
  { id: "America/Costa_Rica", label: "Costa Rica" },
  { id: "America/Guatemala", label: "Guatemala" },
  { id: "America/Santo_Domingo", label: "República Dominicana" },
  { id: "America/Puerto_Rico", label: "Puerto Rico" },
  { id: "America/New_York", label: "EE. UU. Este (Nueva York)" },
  { id: "America/Chicago", label: "EE. UU. Centro (Chicago)" },
  { id: "America/Denver", label: "EE. UU. Montaña (Denver)" },
  { id: "America/Los_Angeles", label: "EE. UU. Pacífico (Los Ángeles)" },
  { id: "Europe/Madrid", label: "España (Madrid)" },
];

export const STEP_OPTIONS = [5, 10, 15, 20, 30, 45, 60] as const;
export const NOTICE_OPTIONS: { minutes: number; label: string }[] = [
  { minutes: 0, label: "Sin preaviso" },
  { minutes: 30, label: "30 minutos" },
  { minutes: 60, label: "1 hora" },
  { minutes: 120, label: "2 horas" },
  { minutes: 240, label: "4 horas" },
  { minutes: 720, label: "12 horas" },
  { minutes: 1440, label: "1 día" },
  { minutes: 2880, label: "2 días" },
];
EOF_SRC_LIB_AGENDA_LABELS_TS
echo "✔ src/lib/agenda/labels.ts"
mkdir -p src/lib/auth
cat > src/lib/auth/permissions.ts <<'EOF_SRC_LIB_AUTH_PERMISSIONS_TS'
export const ROLES = ["owner", "admin", "agent"] as const;
export type Role = (typeof ROLES)[number];

const MATRIX = {
  "conversations:read": ["owner", "admin", "agent"],
  "conversations:reply": ["owner", "admin", "agent"],
  "contacts:manage": ["owner", "admin"],
  "team:manage": ["owner", "admin"],
  "team:roles": ["owner"],
  "settings:edit": ["owner", "admin"],
  "integrations:manage": ["owner", "admin"],
  "agent:manage": ["owner", "admin"],
  "agenda:read": ["owner", "admin", "agent"],
  "agenda:manage": ["owner", "admin"],
  "billing:manage": ["owner"],
  "tenant:delete": ["owner"],
} as const satisfies Record<string, readonly Role[]>;

export type Permission = keyof typeof MATRIX;

export function can(role: Role | null | undefined, permission: Permission): boolean {
  if (!role) return false;
  return (MATRIX[permission] as readonly Role[]).includes(role);
}
EOF_SRC_LIB_AUTH_PERMISSIONS_TS
echo "✔ src/lib/auth/permissions.ts"
mkdir -p src/app/api/agenda/config
cat > src/app/api/agenda/config/route.ts <<'EOF_SRC_APP_API_AGENDA_CONFIG_ROUTE_TS'
import { requireTenant } from "@/lib/auth/guard";
import { jsonResponse, route } from "@/lib/auth/http";
import { can } from "@/lib/auth/permissions";
import { withTenant } from "@/lib/db";
import { loadHours, loadSettings } from "@/lib/agenda/load";

/** Configuración de la agenda: zona horaria y reglas, servicios, horario semanal y bloqueos próximos. */
export const GET = route(async (req) => {
  const auth = await requireTenant(req, "agenda:read");
  if (!auth.ok) return auth.response;
  const { tenantId } = auth.ctx;
  const data = await withTenant(tenantId, async (db) => {
    const settings = await loadSettings(db, tenantId);
    const hours = await loadHours(db, tenantId);
    const services = await db.query("SELECT id, name, duration_minutes, price_text, active FROM agenda_services WHERE tenant_id = $1 ORDER BY active DESC, lower(name)", [tenantId]);
    const off = await db.query("SELECT id, starts_at, ends_at, reason FROM agenda_time_off WHERE tenant_id = $1 AND ends_at > now() ORDER BY starts_at LIMIT 200", [tenantId]);
    return { settings, hours, services: services.rows, off: off.rows };
  });
  return jsonResponse({
    settings: data.settings,
    hours: data.hours,
    services: data.services.map((s) => ({ id: s.id, name: s.name, durationMinutes: s.duration_minutes, priceText: s.price_text, active: s.active })),
    timeOff: data.off.map((o) => ({ id: o.id, startsAt: o.starts_at, endsAt: o.ends_at, reason: o.reason })),
    canManage: can(auth.ctx.role, "agenda:manage"),
  });
});
EOF_SRC_APP_API_AGENDA_CONFIG_ROUTE_TS
echo "✔ src/app/api/agenda/config/route.ts"
mkdir -p src/app/api/agenda/settings
cat > src/app/api/agenda/settings/route.ts <<'EOF_SRC_APP_API_AGENDA_SETTINGS_ROUTE_TS'
import { z } from "zod";
import { requireTenant } from "@/lib/auth/guard";
import { checkOrigin, jsonResponse, readJson, route } from "@/lib/auth/http";
import { withTenant } from "@/lib/db";
import { isValidTimeZone } from "@/lib/agenda/tz";

const schema = z.object({
  timezone: z.string().trim().refine(isValidTimeZone, "Zona horaria no válida (ejemplo: America/Caracas)"),
  minNoticeMinutes: z.number().int().min(0).max(10080),
  maxDaysAhead: z.number().int().min(1).max(365),
  slotStepMinutes: z.number().int().refine((n) => [5, 10, 15, 20, 30, 45, 60].includes(n), "Elige 5, 10, 15, 20, 30, 45 o 60 minutos"),
});

export const PUT = route(async (req) => {
  const blocked = checkOrigin(req);
  if (blocked) return blocked;
  const auth = await requireTenant(req, "agenda:manage");
  if (!auth.ok) return auth.response;
  const body = await readJson(req, schema);
  if (!body.ok) return body.response;
  const d = body.data;
  const { tenantId } = auth.ctx;
  await withTenant(tenantId, async (db) => {
    await db.query(
      `INSERT INTO agenda_settings (tenant_id, timezone, min_notice_minutes, max_days_ahead, slot_step_minutes, updated_by)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (tenant_id) DO UPDATE SET timezone = EXCLUDED.timezone, min_notice_minutes = EXCLUDED.min_notice_minutes,
         max_days_ahead = EXCLUDED.max_days_ahead, slot_step_minutes = EXCLUDED.slot_step_minutes, updated_at = now(), updated_by = EXCLUDED.updated_by`,
      [tenantId, d.timezone, d.minNoticeMinutes, d.maxDaysAhead, d.slotStepMinutes, auth.session.userId],
    );
    await db.query("INSERT INTO audit_log (tenant_id, actor_id, action, target_type, metadata) VALUES ($1, $2, 'agenda.settings', 'agenda', $3)", [tenantId, auth.session.userId, JSON.stringify(d)]);
  });
  return jsonResponse({ ok: true });
});
EOF_SRC_APP_API_AGENDA_SETTINGS_ROUTE_TS
echo "✔ src/app/api/agenda/settings/route.ts"
mkdir -p src/app/api/agenda/hours
cat > src/app/api/agenda/hours/route.ts <<'EOF_SRC_APP_API_AGENDA_HOURS_ROUTE_TS'
import { z } from "zod";
import { requireTenant } from "@/lib/auth/guard";
import { checkOrigin, errorResponse, jsonResponse, readJson, route } from "@/lib/auth/http";
import { withTenant } from "@/lib/db";
import { parseHm } from "@/lib/agenda/tz";

const range = z.object({ start: z.string(), end: z.string() });
const schema = z.object({
  days: z.array(z.object({ weekday: z.number().int().min(1).max(7), ranges: z.array(range).max(3, "Máximo 3 tramos por día") })).max(7),
});

/** Reemplaza TODO el horario semanal (los días que no vengan quedan cerrados). */
export const PUT = route(async (req) => {
  const blocked = checkOrigin(req);
  if (blocked) return blocked;
  const auth = await requireTenant(req, "agenda:manage");
  if (!auth.ok) return auth.response;
  const body = await readJson(req, schema);
  if (!body.ok) return body.response;

  const rows: { weekday: number; start: number; end: number }[] = [];
  const seen = new Set<number>();
  for (const day of body.data.days) {
    if (seen.has(day.weekday)) return errorResponse(400, "datos_invalidos", "Un día aparece repetido.");
    seen.add(day.weekday);
    for (const r of day.ranges) {
      const start = parseHm(r.start);
      const end = parseHm(r.end, true);
      if (start === null || end === null) return errorResponse(400, "datos_invalidos", "Usa horas válidas con formato HH:MM.");
      if (start >= end) return errorResponse(400, "datos_invalidos", "La hora de cierre debe ser después de la de apertura.");
      rows.push({ weekday: day.weekday, start, end });
    }
  }

  const { tenantId } = auth.ctx;
  try {
    await withTenant(tenantId, async (db) => {
      await db.query("DELETE FROM agenda_hours WHERE tenant_id = $1", [tenantId]);
      for (const r of rows) {
        await db.query("INSERT INTO agenda_hours (tenant_id, weekday, start_min, end_min) VALUES ($1, $2, $3, $4)", [tenantId, r.weekday, r.start, r.end]);
      }
      await db.query("INSERT INTO audit_log (tenant_id, actor_id, action, target_type, metadata) VALUES ($1, $2, 'agenda.hours', 'agenda', $3)", [tenantId, auth.session.userId, JSON.stringify({ ranges: rows.length })]);
    });
  } catch (e) {
    if ((e as { code?: string }).code === "23P01") return errorResponse(400, "datos_invalidos", "Hay tramos que se cruzan el mismo día.");
    throw e;
  }
  return jsonResponse({ ok: true });
});
EOF_SRC_APP_API_AGENDA_HOURS_ROUTE_TS
echo "✔ src/app/api/agenda/hours/route.ts"
mkdir -p src/app/api/agenda/services
cat > src/app/api/agenda/services/route.ts <<'EOF_SRC_APP_API_AGENDA_SERVICES_ROUTE_TS'
import { z } from "zod";
import { requireTenant } from "@/lib/auth/guard";
import { checkOrigin, errorResponse, jsonResponse, readJson, route } from "@/lib/auth/http";
import { withTenant } from "@/lib/db";

const MAX_ACTIVE_SERVICES = 50;

const schema = z.object({
  name: z.string().trim().min(1, "Escribe el nombre del servicio").max(80, "Máximo 80 caracteres"),
  durationMinutes: z.number().int().min(5, "Mínimo 5 minutos").max(480, "Máximo 8 horas"),
  priceText: z.string().trim().max(40, "Máximo 40 caracteres").optional(),
});

export const POST = route(async (req) => {
  const blocked = checkOrigin(req);
  if (blocked) return blocked;
  const auth = await requireTenant(req, "agenda:manage");
  if (!auth.ok) return auth.response;
  const body = await readJson(req, schema);
  if (!body.ok) return body.response;
  const { tenantId } = auth.ctx;
  const d = body.data;
  const out = await withTenant(tenantId, async (db) => {
    const n = await db.query("SELECT count(*)::int AS n FROM agenda_services WHERE tenant_id = $1 AND active", [tenantId]);
    if (n.rows[0].n >= MAX_ACTIVE_SERVICES) return "limite" as const;
    try {
      const r = await db.query("INSERT INTO agenda_services (tenant_id, name, duration_minutes, price_text) VALUES ($1, $2, $3, $4) RETURNING id", [tenantId, d.name, d.durationMinutes, d.priceText || null]);
      return r.rows[0].id as string;
    } catch (e) {
      if ((e as { code?: string }).code === "23505") return "duplicado" as const;
      throw e;
    }
  });
  if (out === "limite") return errorResponse(409, "limite_servicios", `Máximo ${MAX_ACTIVE_SERVICES} servicios activos.`);
  if (out === "duplicado") return errorResponse(409, "servicio_duplicado", "Ya tienes un servicio con ese nombre.");
  return jsonResponse({ ok: true, id: out }, 201);
});
EOF_SRC_APP_API_AGENDA_SERVICES_ROUTE_TS
echo "✔ src/app/api/agenda/services/route.ts"
mkdir -p src/app/api/agenda/services/update
cat > src/app/api/agenda/services/update/route.ts <<'EOF_SRC_APP_API_AGENDA_SERVICES_UPDATE_ROUTE_TS'
import { z } from "zod";
import { requireTenant } from "@/lib/auth/guard";
import { checkOrigin, errorResponse, jsonResponse, readJson, route } from "@/lib/auth/http";
import { withTenant } from "@/lib/db";

const schema = z.object({
  id: z.uuid(),
  name: z.string().trim().min(1).max(80).optional(),
  durationMinutes: z.number().int().min(5).max(480).optional(),
  priceText: z.string().trim().max(40).nullable().optional(),
  active: z.boolean().optional(),
});

/** Cambiar un servicio. Cambiar la duración no mueve las citas ya agendadas. */
export const POST = route(async (req) => {
  const blocked = checkOrigin(req);
  if (blocked) return blocked;
  const auth = await requireTenant(req, "agenda:manage");
  if (!auth.ok) return auth.response;
  const body = await readJson(req, schema);
  if (!body.ok) return body.response;
  const { tenantId } = auth.ctx;
  const d = body.data;
  const out = await withTenant(tenantId, async (db) => {
    try {
      const r = await db.query(
        `UPDATE agenda_services SET name = COALESCE($3, name), duration_minutes = COALESCE($4, duration_minutes),
                price_text = CASE WHEN $5::boolean THEN $6 ELSE price_text END, active = COALESCE($7, active)
          WHERE tenant_id = $1 AND id = $2`,
        [tenantId, d.id, d.name ?? null, d.durationMinutes ?? null, d.priceText !== undefined, d.priceText || null, d.active ?? null],
      );
      return r.rowCount === 1 ? ("ok" as const) : ("no_existe" as const);
    } catch (e) {
      if ((e as { code?: string }).code === "23505") return "duplicado" as const;
      throw e;
    }
  });
  if (out === "no_existe") return errorResponse(404, "no_encontrado", "No encontrado.");
  if (out === "duplicado") return errorResponse(409, "servicio_duplicado", "Ya tienes un servicio activo con ese nombre.");
  return jsonResponse({ ok: true });
});
EOF_SRC_APP_API_AGENDA_SERVICES_UPDATE_ROUTE_TS
echo "✔ src/app/api/agenda/services/update/route.ts"
mkdir -p src/app/api/agenda/time-off
cat > src/app/api/agenda/time-off/route.ts <<'EOF_SRC_APP_API_AGENDA_TIME-OFF_ROUTE_TS'
import { z } from "zod";
import { requireTenant } from "@/lib/auth/guard";
import { checkOrigin, errorResponse, jsonResponse, readJson, route } from "@/lib/auth/http";
import { withTenant } from "@/lib/db";

const MAX_FUTURE = 200;
const schema = z.object({
  startsAt: z.iso.datetime({ offset: true }),
  endsAt: z.iso.datetime({ offset: true }),
  reason: z.string().trim().max(200, "Máximo 200 caracteres").optional(),
});

/** Bloquea un periodo (vacaciones, feriado, descanso). Las citas ya agendadas no se tocan: se avisa cuántas hay dentro. */
export const POST = route(async (req) => {
  const blocked = checkOrigin(req);
  if (blocked) return blocked;
  const auth = await requireTenant(req, "agenda:manage");
  if (!auth.ok) return auth.response;
  const body = await readJson(req, schema);
  if (!body.ok) return body.response;
  const { tenantId } = auth.ctx;
  const d = body.data;
  const s = Date.parse(d.startsAt), e = Date.parse(d.endsAt);
  if (!(s < e)) return errorResponse(400, "datos_invalidos", "El final debe ser después del inicio.");
  if (e - s > 400 * 86_400_000) return errorResponse(400, "datos_invalidos", "El bloqueo es demasiado largo (máximo 400 días).");
  if (e <= Date.now()) return errorResponse(400, "datos_invalidos", "El bloqueo debe terminar en el futuro.");

  const out = await withTenant(tenantId, async (db) => {
    const n = await db.query("SELECT count(*)::int AS n FROM agenda_time_off WHERE tenant_id = $1 AND ends_at > now()", [tenantId]);
    if (n.rows[0].n >= MAX_FUTURE) return "limite" as const;
    const r = await db.query("INSERT INTO agenda_time_off (tenant_id, starts_at, ends_at, reason, created_by) VALUES ($1, $2, $3, $4, $5) RETURNING id", [tenantId, d.startsAt, d.endsAt, d.reason || null, auth.session.userId]);
    const c = await db.query("SELECT count(*)::int AS n FROM appointments WHERE tenant_id = $1 AND status IN ('pendiente', 'confirmada') AND ends_at > $2 AND starts_at < $3", [tenantId, d.startsAt, d.endsAt]);
    return { id: r.rows[0].id as string, affected: c.rows[0].n as number };
  });
  if (out === "limite") return errorResponse(409, "limite_bloqueos", `Máximo ${MAX_FUTURE} bloqueos vigentes.`);
  return jsonResponse({ ok: true, id: out.id, appointmentsInside: out.affected }, 201);
});
EOF_SRC_APP_API_AGENDA_TIME-OFF_ROUTE_TS
echo "✔ src/app/api/agenda/time-off/route.ts"
mkdir -p src/app/api/agenda/time-off/delete
cat > src/app/api/agenda/time-off/delete/route.ts <<'EOF_SRC_APP_API_AGENDA_TIME-OFF_DELETE_ROUTE_TS'
import { z } from "zod";
import { requireTenant } from "@/lib/auth/guard";
import { checkOrigin, errorResponse, jsonResponse, readJson, route } from "@/lib/auth/http";
import { withTenant } from "@/lib/db";

export const POST = route(async (req) => {
  const blocked = checkOrigin(req);
  if (blocked) return blocked;
  const auth = await requireTenant(req, "agenda:manage");
  if (!auth.ok) return auth.response;
  const body = await readJson(req, z.object({ id: z.uuid() }));
  if (!body.ok) return body.response;
  const { tenantId } = auth.ctx;
  const r = await withTenant(tenantId, (db) => db.query("DELETE FROM agenda_time_off WHERE tenant_id = $1 AND id = $2", [tenantId, body.data.id]));
  return r.rowCount === 1 ? jsonResponse({ ok: true }) : errorResponse(404, "no_encontrado", "No encontrado.");
});
EOF_SRC_APP_API_AGENDA_TIME-OFF_DELETE_ROUTE_TS
echo "✔ src/app/api/agenda/time-off/delete/route.ts"
mkdir -p src/app/api/agenda/slots
cat > src/app/api/agenda/slots/route.ts <<'EOF_SRC_APP_API_AGENDA_SLOTS_ROUTE_TS'
import { z } from "zod";
import { requireTenant } from "@/lib/auth/guard";
import { errorResponse, jsonResponse, route } from "@/lib/auth/http";
import { withTenant } from "@/lib/db";
import { slotsForService } from "@/lib/agenda/load";
import { MAX_SLOT_DAYS } from "@/lib/agenda/slots";
import { isValidYmd } from "@/lib/agenda/tz";

const query = z.object({
  serviceId: z.uuid(),
  date: z.string().refine(isValidYmd, "Fecha inválida (AAAA-MM-DD)"),
  days: z.coerce.number().int().min(1).max(MAX_SLOT_DAYS).default(1),
});

/** Huecos libres de un servicio a partir de una fecha (hora local del negocio). */
export const GET = route(async (req) => {
  const auth = await requireTenant(req, "agenda:read");
  if (!auth.ok) return auth.response;
  const sp = new URL(req.url).searchParams;
  const q = query.safeParse({ serviceId: sp.get("serviceId"), date: sp.get("date"), days: sp.get("days") ?? undefined });
  if (!q.success) return errorResponse(400, "datos_invalidos", q.error.issues[0]?.message ?? "Datos inválidos.");
  const { tenantId } = auth.ctx;
  const slots = await withTenant(tenantId, (db) => slotsForService(db, tenantId, q.data.serviceId, q.data.date, q.data.days));
  if (!slots) return errorResponse(404, "no_encontrado", "Servicio no encontrado o inactivo.");
  return jsonResponse({ slots });
});
EOF_SRC_APP_API_AGENDA_SLOTS_ROUTE_TS
echo "✔ src/app/api/agenda/slots/route.ts"
mkdir -p src/components
cat > src/components/AgendaConfig.tsx <<'EOF_SRC_COMPONENTS_AGENDACONFIG_TSX'
"use client";

import { useCallback, useEffect, useId, useState, type FormEvent } from "react";
import { COMMON_TIMEZONES, NOTICE_OPTIONS, STEP_OPTIONS, WEEKDAYS } from "@/lib/agenda/labels";
import { addDays, formatHm, localToUtc, parseHm } from "@/lib/agenda/tz";

interface Settings { timezone: string; minNoticeMinutes: number; maxDaysAhead: number; slotStepMinutes: number }
interface Service { id: string; name: string; durationMinutes: number; priceText: string | null; active: boolean }
interface Off { id: string; startsAt: string; endsAt: string; reason: string | null }
interface Config { settings: Settings; hours: { weekday: number; startMin: number; endMin: number }[]; services: Service[]; timeOff: Off[]; canManage: boolean }
type Ranges = { start: string; end: string }[];

async function call(url: string, method: string, body?: unknown): Promise<{ ok: boolean; data: Record<string, unknown> }> {
  try {
    const res = await fetch(url, { method, headers: body !== undefined ? { "content-type": "application/json" } : undefined, body: body !== undefined ? JSON.stringify(body) : undefined, cache: "no-store" });
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    return { ok: res.ok, data };
  } catch {
    return { ok: false, data: { message: "No hay conexión con el servidor. Revisa tu internet e intenta de nuevo." } };
  }
}
const msg = (d: Record<string, unknown>, fallback: string) => (typeof d.message === "string" ? d.message : fallback);

function Section({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <section className="card-light" style={{ maxWidth: 820 }}>
      <h2 className="text-[24px]">{title}</h2>
      {hint && <p className="muted mt-2 text-[14px]">{hint}</p>}
      <div className="mt-5 flex flex-col gap-5">{children}</div>
    </section>
  );
}

function Feedback({ error, saved }: { error: string | null; saved: boolean }) {
  return (
    <>
      <div role="alert" aria-live="assertive">{error && <p className="alert-error">{error}</p>}</div>
      <div role="status" aria-live="polite">{saved && <p className="muted">Guardado.</p>}</div>
    </>
  );
}

export function AgendaConfig() {
  const uid = useId();
  const [cfg, setCfg] = useState<Config | null>(null);
  const [loadError, setLoadError] = useState(false);

  const load = useCallback(async () => {
    const r = await call("/api/agenda/config", "GET");
    if (r.ok) setCfg(r.data as unknown as Config);
    else setLoadError(true);
  }, []);
  useEffect(() => {
    const t = setTimeout(() => void load(), 0);
    return () => clearTimeout(t);
  }, [load]);

  if (loadError) return <p className="alert-error" role="alert">No se pudo cargar la agenda. Recarga la página.</p>;
  if (!cfg) return <p className="muted-dark" role="status">Cargando…</p>;
  const dis = !cfg.canManage;

  return (
    <div className="flex flex-col gap-8">
      {dis && <p className="alert-warn" style={{ maxWidth: 820 }} role="note">Solo dueños y administradores pueden cambiar la agenda. Tú puedes verla y probar los horarios libres.</p>}
      <Rules uid={uid} settings={cfg.settings} disabled={dis} onSaved={load} />
      <Services uid={uid} services={cfg.services} disabled={dis} onChanged={load} />
      <Hours uid={uid} hours={cfg.hours} disabled={dis} onSaved={load} />
      <TimeOff uid={uid} off={cfg.timeOff} tz={cfg.settings.timezone} disabled={dis} onChanged={load} />
      <Tester uid={uid} services={cfg.services.filter((s) => s.active)} />
    </div>
  );
}

// ------------------------------------------------------------------ reglas
function Rules({ uid, settings, disabled, onSaved }: { uid: string; settings: Settings; disabled: boolean; onSaved: () => Promise<void> }) {
  const [s, setS] = useState(settings);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const known = COMMON_TIMEZONES.some((z) => z.id === s.timezone);
  async function save(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    setBusy(true); setError(null); setSaved(false);
    const r = await call("/api/agenda/settings", "PUT", s);
    if (r.ok) { setSaved(true); await onSaved(); } else setError(msg(r.data, "No se pudo guardar."));
    setBusy(false);
  }
  return (
    <Section title="Zona horaria y reglas" hint="Todos los horarios se entienden en la zona horaria de tu negocio.">
      <form onSubmit={save} className="flex flex-col gap-5">
        <div className="grid gap-5 sm:grid-cols-2">
          <div className="field">
            <label htmlFor={`${uid}-tz`}>Zona horaria</label>
            <select id={`${uid}-tz`} className="input" value={s.timezone} disabled={disabled} onChange={(e) => setS({ ...s, timezone: e.target.value })}>
              {!known && <option value={s.timezone}>{s.timezone}</option>}
              {COMMON_TIMEZONES.map((z) => <option key={z.id} value={z.id}>{z.label}</option>)}
            </select>
          </div>
          <div className="field">
            <label htmlFor={`${uid}-step`}>Una cita puede empezar cada</label>
            <select id={`${uid}-step`} className="input" value={s.slotStepMinutes} disabled={disabled} onChange={(e) => setS({ ...s, slotStepMinutes: Number(e.target.value) })}>
              {STEP_OPTIONS.map((m) => <option key={m} value={m}>{m} minutos</option>)}
            </select>
          </div>
          <div className="field">
            <label htmlFor={`${uid}-notice`}>Preaviso mínimo</label>
            <select id={`${uid}-notice`} className="input" value={s.minNoticeMinutes} disabled={disabled} onChange={(e) => setS({ ...s, minNoticeMinutes: Number(e.target.value) })}>
              {!NOTICE_OPTIONS.some((o) => o.minutes === s.minNoticeMinutes) && <option value={s.minNoticeMinutes}>{s.minNoticeMinutes} minutos</option>}
              {NOTICE_OPTIONS.map((o) => <option key={o.minutes} value={o.minutes}>{o.label}</option>)}
            </select>
          </div>
          <div className="field">
            <label htmlFor={`${uid}-days`}>Se puede reservar hasta (días)</label>
            <input id={`${uid}-days`} type="number" min={1} max={365} className="input" value={s.maxDaysAhead} disabled={disabled} onChange={(e) => setS({ ...s, maxDaysAhead: Number(e.target.value) })} />
          </div>
        </div>
        <Feedback error={error} saved={saved} />
        {!disabled && <button type="submit" className="btn btn-primary btn-sm" style={{ alignSelf: "flex-start" }} disabled={busy}>{busy ? "Guardando…" : "Guardar reglas"}</button>}
      </form>
    </Section>
  );
}

// ------------------------------------------------------------------ servicios
function Services({ uid, services, disabled, onChanged }: { uid: string; services: Service[]; disabled: boolean; onChanged: () => Promise<void> }) {
  const [name, setName] = useState("");
  const [minutes, setMinutes] = useState(30);
  const [price, setPrice] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function add(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    setBusy(true); setError(null);
    const r = await call("/api/agenda/services", "POST", { name, durationMinutes: minutes, ...(price.trim() ? { priceText: price } : {}) });
    if (r.ok) { setName(""); setPrice(""); await onChanged(); } else setError(msg(r.data, "No se pudo crear el servicio."));
    setBusy(false);
  }
  async function patch(id: string, body: Record<string, unknown>) {
    if (busy) return;
    setBusy(true); setError(null);
    const r = await call("/api/agenda/services/update", "POST", { id, ...body });
    if (!r.ok) setError(msg(r.data, "No se pudo cambiar el servicio."));
    await onChanged();
    setBusy(false);
  }
  return (
    <Section title="Servicios" hint="Lo que tus clientes pueden agendar. La duración decide cuánto espacio ocupa cada cita.">
      {services.length === 0 && <p className="muted">Todavía no tienes servicios. Agrega el primero abajo.</p>}
      <ul className="flex flex-col gap-3">
        {services.map((s) => (
          <li key={s.id} className="flex flex-wrap items-center justify-between gap-3 rounded-[16px] p-4" style={{ background: "var(--color-pure-white)", border: "1px solid var(--color-field-border)", opacity: s.active ? 1 : 0.7 }}>
            <div>
              <p className="font-medium">{s.name}{!s.active && " (desactivado)"}</p>
              <p className="muted text-[14px]">{s.durationMinutes} min{s.priceText ? ` · ${s.priceText}` : ""}</p>
            </div>
            {!disabled && (
              <div className="flex flex-wrap items-center gap-2">
                <label className="sr-only" htmlFor={`${uid}-d-${s.id}`}>Duración de {s.name}</label>
                <select id={`${uid}-d-${s.id}`} className="input" style={{ width: 130 }} value={s.durationMinutes} disabled={busy} onChange={(e) => void patch(s.id, { durationMinutes: Number(e.target.value) })}>
                  {[...new Set([5, 10, 15, 20, 30, 45, 60, 75, 90, 120, 150, 180, 240, 300, 360, 480, s.durationMinutes])].sort((a, b) => a - b).map((m) => <option key={m} value={m}>{m} min</option>)}
                </select>
                <button type="button" className="btn btn-sm btn-ghost-light" disabled={busy} onClick={() => void patch(s.id, { active: !s.active })}>{s.active ? "Desactivar" : "Activar"}</button>
              </div>
            )}
          </li>
        ))}
      </ul>
      <div role="alert" aria-live="assertive">{error && <p className="alert-error">{error}</p>}</div>
      {!disabled && (
        <form onSubmit={add} className="grid gap-4 sm:grid-cols-[2fr_1fr_1fr_auto] sm:items-end">
          <div className="field">
            <label htmlFor={`${uid}-sn`}>Nuevo servicio</label>
            <input id={`${uid}-sn`} className="input" value={name} maxLength={80} required onChange={(e) => setName(e.target.value)} placeholder="Corte de cabello" />
          </div>
          <div className="field">
            <label htmlFor={`${uid}-sm`}>Duración (min)</label>
            <input id={`${uid}-sm`} type="number" min={5} max={480} className="input" value={minutes} onChange={(e) => setMinutes(Number(e.target.value))} />
          </div>
          <div className="field">
            <label htmlFor={`${uid}-sp`}>Precio (opcional)</label>
            <input id={`${uid}-sp`} className="input" value={price} maxLength={40} onChange={(e) => setPrice(e.target.value)} placeholder="$8" />
          </div>
          <button type="submit" className="btn btn-primary btn-sm" disabled={busy}>Agregar</button>
        </form>
      )}
    </Section>
  );
}

// ------------------------------------------------------------------ horario
function toRanges(hours: Config["hours"]): Record<number, Ranges> {
  const out: Record<number, Ranges> = {};
  for (const h of hours) (out[h.weekday] ??= []).push({ start: formatHm(h.startMin), end: h.endMin === 1440 ? "24:00" : formatHm(h.endMin) });
  return out;
}

function Hours({ uid, hours, disabled, onSaved }: { uid: string; hours: Config["hours"]; disabled: boolean; onSaved: () => Promise<void> }) {
  const [days, setDays] = useState<Record<number, Ranges>>(() => toRanges(hours));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const set = (n: number, r: Ranges) => { setDays((d) => ({ ...d, [n]: r })); setSaved(false); };

  async function save(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    for (const w of WEEKDAYS) for (const r of days[w.n] ?? []) {
      const a = parseHm(r.start), b = parseHm(r.end, true);
      if (a === null || b === null) return setError(`${w.label}: completa las horas.`);
      if (a >= b) return setError(`${w.label}: la hora de cierre debe ser después de la de apertura.`);
    }
    setBusy(true); setError(null); setSaved(false);
    const r = await call("/api/agenda/hours", "PUT", { days: WEEKDAYS.map((w) => ({ weekday: w.n, ranges: days[w.n] ?? [] })).filter((d) => d.ranges.length > 0) });
    if (r.ok) { setSaved(true); await onSaved(); } else setError(msg(r.data, "No se pudo guardar el horario."));
    setBusy(false);
  }
  return (
    <Section title="Horario semanal" hint="Los días sin horario quedan cerrados. Puedes poner hasta 3 tramos por día (por ejemplo, mañana y tarde).">
      <form onSubmit={save} className="flex flex-col gap-4">
        {WEEKDAYS.map((w) => {
          const rs = days[w.n] ?? [];
          return (
            <div key={w.n} className="flex flex-wrap items-center gap-3">
              <span className="font-medium" style={{ width: 96 }}>{w.label}</span>
              {rs.length === 0 && <span className="muted">Cerrado</span>}
              {rs.map((r, i) => (
                <span key={i} className="flex flex-wrap items-center gap-2">
                  <label className="sr-only" htmlFor={`${uid}-${w.n}-${i}-a`}>{w.label}, abre</label>
                  <input id={`${uid}-${w.n}-${i}-a`} type="time" className="input" style={{ width: 160 }} value={r.start} disabled={disabled} onChange={(e) => set(w.n, rs.map((x, j) => (j === i ? { ...x, start: e.target.value } : x)))} />
                  <span aria-hidden>a</span>
                  <label className="sr-only" htmlFor={`${uid}-${w.n}-${i}-b`}>{w.label}, cierra</label>
                  <input id={`${uid}-${w.n}-${i}-b`} type="time" className="input" style={{ width: 160 }} value={r.end === "24:00" ? "23:59" : r.end} disabled={disabled} onChange={(e) => set(w.n, rs.map((x, j) => (j === i ? { ...x, end: e.target.value } : x)))} />
                  {!disabled && <button type="button" className="btn btn-sm btn-text" style={{ color: "var(--color-ink)", textDecoration: "underline" }} onClick={() => set(w.n, rs.filter((_, j) => j !== i))}>Quitar</button>}
                </span>
              ))}
              {!disabled && rs.length < 3 && (
                <button type="button" className="btn btn-sm btn-ghost-light" onClick={() => set(w.n, [...rs, rs.length === 0 ? { start: "09:00", end: "17:00" } : { start: rs[rs.length - 1]!.end, end: "18:00" }])}>
                  {rs.length === 0 ? "Abrir" : "Agregar tramo"}
                </button>
              )}
            </div>
          );
        })}
        {!disabled && (
          <div>
            <button type="button" className="btn btn-sm btn-text" style={{ color: "var(--color-ink)", textDecoration: "underline" }} onClick={() => { const mon = days[1] ?? []; setDays((d) => ({ ...d, 2: mon, 3: mon, 4: mon, 5: mon })); setSaved(false); }}>
              Copiar el horario del lunes a martes–viernes
            </button>
          </div>
        )}
        <Feedback error={error} saved={saved} />
        {!disabled && <button type="submit" className="btn btn-primary btn-sm" style={{ alignSelf: "flex-start" }} disabled={busy}>{busy ? "Guardando…" : "Guardar horario"}</button>}
      </form>
    </Section>
  );
}

// ------------------------------------------------------------------ bloqueos
function TimeOff({ uid, off, tz, disabled, onChanged }: { uid: string; off: Off[]; tz: string; disabled: boolean; onChanged: () => Promise<void> }) {
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const fmt = (iso: string) => new Intl.DateTimeFormat("es-VE", { timeZone: tz, day: "numeric", month: "short", year: "numeric", hour: "numeric", minute: "2-digit" }).format(new Date(iso));

  async function add(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    setError(null); setNotice(null);
    const start = localToUtc(from, 0, tz);
    const end = localToUtc(addDays(to || from, 1), 0, tz);
    if (start === null || end === null) return setError("Elige las fechas.");
    if (end <= start) return setError("La fecha final no puede ser antes de la inicial.");
    setBusy(true);
    const r = await call("/api/agenda/time-off", "POST", { startsAt: new Date(start).toISOString(), endsAt: new Date(end).toISOString(), ...(reason.trim() ? { reason } : {}) });
    if (r.ok) {
      setFrom(""); setTo(""); setReason("");
      const n = Number(r.data.appointmentsInside ?? 0);
      if (n > 0) setNotice(`Ojo: ya hay ${n} cita(s) dentro de ese periodo. No se cancelaron; habrá que reprogramarlas.`);
      await onChanged();
    } else setError(msg(r.data, "No se pudo crear el bloqueo."));
    setBusy(false);
  }
  async function remove(id: string) {
    if (busy) return;
    setBusy(true); setError(null);
    const r = await call("/api/agenda/time-off/delete", "POST", { id });
    if (!r.ok) setError(msg(r.data, "No se pudo quitar el bloqueo."));
    await onChanged();
    setBusy(false);
  }
  return (
    <Section title="Días bloqueados" hint="Vacaciones, feriados o descansos: en esas fechas no se ofrecen horarios. Se bloquean días completos.">
      {off.length === 0 && <p className="muted">No tienes bloqueos próximos.</p>}
      <ul className="flex flex-col gap-3">
        {off.map((o) => (
          <li key={o.id} className="flex flex-wrap items-center justify-between gap-3 rounded-[16px] p-4" style={{ background: "var(--color-pure-white)", border: "1px solid var(--color-field-border)" }}>
            <div>
              <p className="font-medium">{fmt(o.startsAt)} → {fmt(o.endsAt)}</p>
              {o.reason && <p className="muted text-[14px]">{o.reason}</p>}
            </div>
            {!disabled && <button type="button" className="btn btn-sm btn-ghost-light" disabled={busy} onClick={() => void remove(o.id)}>Quitar</button>}
          </li>
        ))}
      </ul>
      <div role="alert" aria-live="assertive">{error && <p className="alert-error">{error}</p>}</div>
      {notice && <p className="alert-warn" role="status">{notice}</p>}
      {!disabled && (
        <form onSubmit={add} className="grid gap-4 sm:grid-cols-[1fr_1fr_2fr_auto] sm:items-end">
          <div className="field">
            <label htmlFor={`${uid}-of`}>Desde</label>
            <input id={`${uid}-of`} type="date" className="input" value={from} required onChange={(e) => setFrom(e.target.value)} />
          </div>
          <div className="field">
            <label htmlFor={`${uid}-ot`}>Hasta (inclusive)</label>
            <input id={`${uid}-ot`} type="date" className="input" value={to} min={from || undefined} onChange={(e) => setTo(e.target.value)} />
          </div>
          <div className="field">
            <label htmlFor={`${uid}-or`}>Motivo (opcional)</label>
            <input id={`${uid}-or`} className="input" value={reason} maxLength={200} onChange={(e) => setReason(e.target.value)} placeholder="Vacaciones" />
          </div>
          <button type="submit" className="btn btn-primary btn-sm" disabled={busy}>Bloquear</button>
        </form>
      )}
    </Section>
  );
}

// ------------------------------------------------------------------ probar huecos
function Tester({ uid, services }: { uid: string; services: Service[] }) {
  const [serviceId, setServiceId] = useState(services[0]?.id ?? "");
  const [date, setDate] = useState("");
  const [result, setResult] = useState<{ time: string; date: string }[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const sel = services.some((s) => s.id === serviceId) ? serviceId : services[0]?.id ?? "";

  async function run(e: FormEvent) {
    e.preventDefault();
    if (busy || !sel) return;
    setBusy(true); setError(null); setResult(null);
    const r = await call(`/api/agenda/slots?serviceId=${sel}&date=${date}&days=1`, "GET");
    if (r.ok) setResult((r.data.slots as { time: string; date: string }[]) ?? []);
    else setError(msg(r.data, "No se pudo calcular."));
    setBusy(false);
  }
  return (
    <Section title="Probar horarios libres" hint="Comprueba qué horarios vería un cliente. Es el mismo cálculo que usará el asistente.">
      {services.length === 0 ? (
        <p className="muted">Crea un servicio para poder probar.</p>
      ) : (
        <form onSubmit={run} className="grid gap-4 sm:grid-cols-[2fr_1fr_auto] sm:items-end">
          <div className="field">
            <label htmlFor={`${uid}-ts`}>Servicio</label>
            <select id={`${uid}-ts`} className="input" value={sel} onChange={(e) => setServiceId(e.target.value)}>
              {services.map((s) => <option key={s.id} value={s.id}>{s.name} ({s.durationMinutes} min)</option>)}
            </select>
          </div>
          <div className="field">
            <label htmlFor={`${uid}-td`}>Fecha</label>
            <input id={`${uid}-td`} type="date" className="input" value={date} required onChange={(e) => setDate(e.target.value)} />
          </div>
          <button type="submit" className="btn btn-primary btn-sm" disabled={busy}>Ver horarios</button>
        </form>
      )}
      <div role="alert" aria-live="assertive">{error && <p className="alert-error">{error}</p>}</div>
      <div role="status" aria-live="polite">
        {result && (result.length === 0 ? <p className="muted">No hay horarios libres ese día.</p> : (
          <ul className="flex flex-wrap gap-2" aria-label="Horarios libres">
            {result.map((s) => <li key={s.time} className="rounded-full px-3 py-1 text-[14px]" style={{ background: "var(--color-pure-white)", border: "1px solid var(--color-field-border)" }}>{s.time}</li>)}
          </ul>
        ))}
      </div>
    </Section>
  );
}
EOF_SRC_COMPONENTS_AGENDACONFIG_TSX
echo "✔ src/components/AgendaConfig.tsx"
mkdir -p src/components
cat > src/components/AppHeader.tsx <<'EOF_SRC_COMPONENTS_APPHEADER_TSX'
import Link from "next/link";
import { brand } from "@/config/brand";
import { LogoutButton } from "./LogoutButton";

export const ROLE_LABEL: Record<string, string> = {
  owner: "Dueño",
  admin: "Administrador",
  agent: "Agente",
};

export function AppHeader({
  email,
  roleLabel,
  showAdmin,
  showTeam,
  showWork = true,
}: {
  email: string;
  roleLabel?: string;
  showAdmin?: boolean;
  showTeam?: boolean;
  /** Enlaces «Hoy» y «Conversaciones». Se ocultan donde no hay negocio (p. ej. administración). */
  showWork?: boolean;
}) {
  return (
    <header className="container-app flex min-h-20 flex-wrap items-center justify-between gap-4 py-4">
      <Link href="/panel" className="text-lg font-medium" style={{ letterSpacing: "-0.01em" }}>
        {brand.name}
      </Link>
      <div className="flex flex-wrap items-center gap-3">
        {showWork && (
          <>
            <Link href="/hoy" className="btn btn-text btn-sm">
              Hoy
            </Link>
            <Link href="/conversaciones" className="btn btn-text btn-sm">
              Conversaciones
            </Link>
            <Link href="/agenda" className="btn btn-text btn-sm">
              Agenda
            </Link>
          </>
        )}
        {showAdmin && (
          <Link href="/admin" className="btn btn-text btn-sm">
            Administración
          </Link>
        )}
        {showTeam && (
          // Quien puede gestionar el equipo (dueño y administrador) también gestiona el asistente.
          <>
            <Link href="/agente" className="btn btn-text btn-sm">
              Asistente
            </Link>
            <Link href="/conocimiento" className="btn btn-text btn-sm">
              Conocimiento
            </Link>
            <Link href="/equipo" className="btn btn-text btn-sm">
              Equipo
            </Link>
          </>
        )}
        <Link href="/seguridad" className="btn btn-text btn-sm">
          Seguridad
        </Link>
        <span className="muted-dark text-sm">{email}</span>
        {roleLabel && <span className="badge badge-neutral">{roleLabel}</span>}
        <LogoutButton />
      </div>
    </header>
  );
}
EOF_SRC_COMPONENTS_APPHEADER_TSX
echo "✔ src/components/AppHeader.tsx"
mkdir -p src/app/agenda
cat > src/app/agenda/page.tsx <<'EOF_SRC_APP_AGENDA_PAGE_TSX'
import type { Metadata } from "next";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { Suspense } from "react";
import { AgendaConfig } from "@/components/AgendaConfig";
import { AppHeader, ROLE_LABEL } from "@/components/AppHeader";
import { can } from "@/lib/auth/permissions";
import { effectiveTenant, getSessionFromHeaders } from "@/lib/auth/session";

export const metadata: Metadata = { title: "Agenda" };

export default function AgendaPage() {
  return (
    <Suspense fallback={<div className="container-app py-24 muted-dark" role="status">Cargando…</div>}>
      <AgendaContent />
    </Suspense>
  );
}

async function AgendaContent() {
  const auth = await getSessionFromHeaders(await headers());
  if (!auth) redirect("/entrar");
  const { session } = auth;
  if (session.needsMfaSetup) redirect("/seguridad");
  const ctx = effectiveTenant(session);
  if (!ctx) redirect("/panel");

  return (
    <div className="flex min-h-screen flex-col">
      <AppHeader
        email={session.email}
        roleLabel={ctx.impersonating ? "Soporte" : ROLE_LABEL[ctx.role]}
        showAdmin={session.isSuperAdmin}
        showTeam={can(ctx.role, "team:manage")}
      />
      <main className="container-app flex-1 pb-24 pt-8">
        <p className="eyebrow eyebrow--dark">Tu negocio</p>
        <h1 className="mt-3 text-[32px] sm:text-[48px]">Agenda</h1>
        <p className="muted-dark mt-3 max-w-[640px]">Define tus servicios y horarios. Las citas se agendarán solo en los huecos libres.</p>
        <div className="mt-10">
          <AgendaConfig />
        </div>
      </main>
    </div>
  );
}
EOF_SRC_APP_AGENDA_PAGE_TSX
echo "✔ src/app/agenda/page.tsx"
mkdir -p tests
cat > tests/agenda-tz.test.ts <<'EOF_TESTS_AGENDA-TZ_TEST_TS'
import { describe, expect, it } from "vitest";
import { computeSlots, isSlotAvailable, type SlotInput } from "@/lib/agenda/slots";
import { addDays, formatHm, isValidTimeZone, isValidYmd, isoWeekday, localDate, localParts, localToUtc, parseHm } from "@/lib/agenda/tz";

const iso = (ms: number | null) => (ms === null ? null : new Date(ms).toISOString());

describe("zonas horarias", () => {
  it("valida nombres IANA y rechaza basura", () => {
    expect(isValidTimeZone("America/Caracas")).toBe(true);
    expect(isValidTimeZone("America/Argentina/Buenos_Aires")).toBe(true);
    for (const bad of ["", "UTC", "EST", "Mars/Olympus", "America/Caracas; DROP", "../etc/passwd", "America"]) expect(isValidTimeZone(bad)).toBe(false);
  });

  it("Caracas es UTC-4 todo el año: 08:00 local = 12:00Z", () => {
    expect(iso(localToUtc("2026-03-10", 8 * 60, "America/Caracas"))).toBe("2026-03-10T12:00:00.000Z");
    expect(iso(localToUtc("2026-07-10", 8 * 60, "America/Caracas"))).toBe("2026-07-10T12:00:00.000Z");
  });

  it("con horario de verano: Nueva York cambia de -5 a -4", () => {
    expect(iso(localToUtc("2026-01-15", 9 * 60, "America/New_York"))).toBe("2026-01-15T14:00:00.000Z");
    expect(iso(localToUtc("2026-07-15", 9 * 60, "America/New_York"))).toBe("2026-07-15T13:00:00.000Z");
  });

  it("la hora que no existe (salto de verano) devuelve null; la repetida devuelve la primera", () => {
    expect(localToUtc("2026-03-08", 2 * 60 + 30, "America/New_York")).toBeNull(); // 02:30 no existe ese día
    expect(iso(localToUtc("2026-03-08", 3 * 60, "America/New_York"))).toBe("2026-03-08T07:00:00.000Z");
    expect(iso(localToUtc("2026-11-01", 60 + 30, "America/New_York"))).toBe("2026-11-01T05:30:00.000Z"); // primera 01:30 (EDT)
  });

  it("ida y vuelta en varias zonas", () => {
    for (const tz of ["America/Caracas", "America/Santiago", "Europe/Madrid", "Asia/Kolkata", "Pacific/Auckland"]) {
      for (const ymd of ["2026-01-05", "2026-06-20", "2026-12-31"]) {
        const ms = localToUtc(ymd, 10 * 60 + 15, tz)!;
        const p = localParts(ms, tz);
        expect([p.hour, p.minute]).toEqual([10, 15]);
        expect(localDate(ms, tz)).toBe(ymd);
      }
    }
  });

  it("la fecha local puede ser distinta de la UTC", () => {
    const ms = Date.parse("2026-05-02T02:00:00Z"); // 22:00 del 1 de mayo en Caracas
    expect(localDate(ms, "America/Caracas")).toBe("2026-05-01");
  });

  it("fechas: validar, sumar días, día de la semana", () => {
    expect(isValidYmd("2026-02-28")).toBe(true);
    expect(isValidYmd("2026-02-30")).toBe(false);
    expect(isValidYmd("26-02-01")).toBe(false);
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
    expect(isoWeekday("2026-10-12")).toBe(1); // lunes
    expect(isoWeekday("2026-10-18")).toBe(7); // domingo
  });

  it("horas HH:MM", () => {
    expect(parseHm("08:30")).toBe(510);
    expect(parseHm("24:00")).toBeNull();
    expect(parseHm("24:00", true)).toBe(1440);
    for (const bad of ["8:30", "25:00", "12:60", "ab:cd", ""]) expect(parseHm(bad)).toBeNull();
    expect(formatHm(510)).toBe("08:30");
  });
});

const NOW = Date.parse("2026-10-12T12:00:00Z"); // lunes 08:00 en Caracas
const base: SlotInput = {
  tz: "America/Caracas", nowMs: NOW, fromDate: "2026-10-12", days: 1, durationMin: 60, stepMin: 60,
  hours: [{ weekday: 1, startMin: 9 * 60, endMin: 12 * 60 }, { weekday: 1, startMin: 14 * 60, endMin: 17 * 60 }],
  timeOff: [], busy: [], minNoticeMin: 0, maxDaysAhead: 30,
};
const times = (i: Partial<SlotInput>) => computeSlots({ ...base, ...i }).map((s) => s.time);

describe("huecos libres", () => {
  it("genera los huecos de cada tramo y respeta la duración", () => {
    expect(times({})).toEqual(["09:00", "10:00", "11:00", "14:00", "15:00", "16:00"]);
    expect(times({ durationMin: 90, stepMin: 30 })).toEqual(["09:00", "09:30", "10:00", "10:30", "14:00", "14:30", "15:00", "15:30"]);
  });

  it("un día sin horario no tiene huecos", () => {
    expect(times({ fromDate: "2026-10-13" })).toEqual([]);
    expect(times({ hours: [] })).toEqual([]);
  });

  it("devuelve horas locales y los instantes UTC correctos", () => {
    const s = computeSlots(base)[0]!;
    expect(s).toEqual({ startsAt: "2026-10-12T13:00:00.000Z", endsAt: "2026-10-12T14:00:00.000Z", date: "2026-10-12", time: "09:00" });
  });

  it("preaviso mínimo: no ofrece lo que ya queda muy cerca", () => {
    expect(times({ minNoticeMin: 150 })).toEqual(["11:00", "14:00", "15:00", "16:00"]); // ahora 08:00 → desde 10:30
    expect(times({ minNoticeMin: 120 })).toEqual(["10:00", "11:00", "14:00", "15:00", "16:00"]); // 10:00 exacto sí
  });

  it("no ofrece horas pasadas", () => {
    expect(times({ nowMs: Date.parse("2026-10-12T19:00:00Z") })).toEqual(["15:00", "16:00"]); // ahora 15:00 local: el hueco de las 15:00 aún vale
    expect(times({ nowMs: Date.parse("2026-10-12T19:00:01Z") })).toEqual(["16:00"]);
  });

  it("máximo de días hacia adelante", () => {
    const s = computeSlots({ ...base, fromDate: "2026-10-12", days: 31, hours: [1, 2, 3, 4, 5, 6, 7].map((w) => ({ weekday: w, startMin: 9 * 60, endMin: 10 * 60 })), maxDaysAhead: 3 });
    expect([...new Set(s.map((x) => x.date))]).toEqual(["2026-10-12", "2026-10-13", "2026-10-14"]);
    expect(s.every((x) => Date.parse(x.startsAt) < NOW + 3 * 86_400_000)).toBe(true);
    expect(s.some((x) => x.date === "2026-10-16")).toBe(false);
  });

  it("bloqueos: quita los huecos que se cruzan (aunque el bloqueo cubra solo un pedazo)", () => {
    const off = [{ startMs: Date.parse("2026-10-12T14:30:00Z"), endMs: Date.parse("2026-10-12T15:30:00Z") }]; // 10:30–11:30 local
    expect(times({ timeOff: off })).toEqual(["09:00", "14:00", "15:00", "16:00"]);
  });

  it("citas ocupadas: quita los huecos que se cruzan; una cita que termina justo cuando empieza otro no estorba", () => {
    const busy = [{ startMs: Date.parse("2026-10-12T14:00:00Z"), endMs: Date.parse("2026-10-12T15:00:00Z") }]; // 10:00–11:00 local
    expect(times({ busy })).toEqual(["09:00", "11:00", "14:00", "15:00", "16:00"]);
  });

  it("un servicio largo no cabe si el tramo termina antes", () => {
    expect(times({ durationMin: 180, stepMin: 60 })).toEqual(["09:00", "14:00"]);
    expect(times({ durationMin: 240, stepMin: 60 })).toEqual([]);
  });

  it("varios días, en orden, con el día de la semana correcto", () => {
    const s = computeSlots({ ...base, days: 8, hours: [{ weekday: 1, startMin: 540, endMin: 600 }, { weekday: 3, startMin: 540, endMin: 600 }] });
    expect(s.map((x) => x.date)).toEqual(["2026-10-12", "2026-10-14", "2026-10-19"]);
  });

  it("DST: el día del cambio de hora no ofrece una hora inexistente", () => {
    const s = computeSlots({ ...base, tz: "America/New_York", nowMs: Date.parse("2026-03-01T00:00:00Z"), fromDate: "2026-03-08", durationMin: 30, stepMin: 30, hours: [{ weekday: 7, startMin: 60, endMin: 240 }] });
    expect(s.map((x) => x.time)).toEqual(["01:00", "01:30", "03:00", "03:30"]); // 02:00 y 02:30 no existen
  });

  it("límite de días calculados (31) y valores raros", () => {
    expect(computeSlots({ ...base, days: 1000, hours: [1, 2, 3, 4, 5, 6, 7].map((w) => ({ weekday: w, startMin: 540, endMin: 600 })), maxDaysAhead: 365 })).toHaveLength(31);
    expect(computeSlots({ ...base, days: 0 })).toEqual([]);
    expect(computeSlots({ ...base, days: -3 })).toEqual([]);
  });

  it("isSlotAvailable: solo acepta inicios que son hueco exacto", () => {
    const { fromDate, days, ...rest } = base;
    void fromDate; void days;
    expect(isSlotAvailable(rest, "2026-10-12T13:00:00.000Z")).toBe(true); // 09:00
    expect(isSlotAvailable(rest, "2026-10-12T13:30:00.000Z")).toBe(false); // 09:30 no es múltiplo
    expect(isSlotAvailable(rest, "2026-10-12T16:00:00.000Z")).toBe(false); // 12:00 fuera del tramo
    expect(isSlotAvailable(rest, "no-es-fecha")).toBe(false);
    expect(isSlotAvailable({ ...rest, busy: [{ startMs: Date.parse("2026-10-12T13:00:00Z"), endMs: Date.parse("2026-10-12T14:00:00Z") }] }, "2026-10-12T13:00:00.000Z")).toBe(false);
  });
});
EOF_TESTS_AGENDA-TZ_TEST_TS
echo "✔ tests/agenda-tz.test.ts"
mkdir -p tests
cat > tests/agenda.test.ts <<'EOF_TESTS_AGENDA_TEST_TS'
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { POST as signup } from "@/app/api/auth/signup/route";
import { GET as me } from "@/app/api/me/route";
import { GET as getConfig } from "@/app/api/agenda/config/route";
import { PUT as putSettings } from "@/app/api/agenda/settings/route";
import { PUT as putHours } from "@/app/api/agenda/hours/route";
import { POST as createService } from "@/app/api/agenda/services/route";
import { POST as updateService } from "@/app/api/agenda/services/update/route";
import { POST as createOff } from "@/app/api/agenda/time-off/route";
import { POST as deleteOff } from "@/app/api/agenda/time-off/delete/route";
import { GET as getSlots } from "@/app/api/agenda/slots/route";
import { can } from "@/lib/auth/permissions";
import { addDays, localDate } from "@/lib/agenda/tz";
import { encryptSecret } from "@/lib/crypto";
import { getPool, withTenant } from "@/lib/db";
import { closeLockClient } from "@/lib/queue/lock";


const RUN = randomUUID().slice(0, 8);
process.env.QUEUE_PREFIX = `test-a-${RUN}`;
const ORIGIN = new URL(process.env.APP_URL!).origin;
const PASSWORD = "contraseña-de-prueba-123";
const TOKEN = "EAAtoken-de-prueba-del-negocio-1234567890";
const owner = new Pool({ connectionString: process.env.MIGRATION_DATABASE_URL, max: 2 });
const tenantIds: string[] = [];
let seq = 0;
const newPhoneId = () => `7${RUN.replace(/\D/g, "").padEnd(4, "5").slice(0, 4)}${Date.now() % 100000}${seq++}`.slice(0, 18);

function api(method: string, path: string, cookie?: string, body?: unknown) {
  return new Request(`${ORIGIN}${path}`, {
    method,
    headers: { origin: ORIGIN, ...(body !== undefined ? { "content-type": "application/json" } : {}), ...(cookie ? { cookie } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

async function register(name: string, opts: { agent?: boolean } = {}) {
  const email = `ag-${RUN}-${name}@example.test`;
  const res = await signup(api("POST", "/api/auth/signup", undefined, { email, password: PASSWORD, businessName: `Negocio ${name}` }));
  expect(res.status).toBe(201);
  const cookie = (res.headers.get("set-cookie") ?? "").split(";")[0]!;
  const info = await (await me(api("GET", "/api/me", cookie))).json();
  const tenantId = info.tenant.id as string;
  tenantIds.push(tenantId);
  const phoneId = newPhoneId();
  const { payload, keyVersion } = encryptSecret(TOKEN, `wa:${tenantId}:${phoneId}`);
  await owner.query("INSERT INTO tenant_integrations (tenant_id, provider, external_id, secret_enc, key_version) VALUES ($1,'whatsapp',$2,$3,$4)", [tenantId, phoneId, payload, keyVersion]);
  if (opts.agent) {
    await withTenant(tenantId, (db) => db.query("INSERT INTO tenant_agents (tenant_id, enabled, assistant_name, instructions) VALUES ($1, true, 'Ana', 'Abrimos de 8am a 5pm.')", [tenantId]));
  }
  return { tenantId, phoneId, cookie };
}
type T = Awaited<ReturnType<typeof register>>;


beforeAll(async () => { await getPool().query("SELECT 1"); });

afterAll(async () => {
  await closeLockClient();
  await owner.query("DELETE FROM users WHERE email LIKE $1", [`ag-${RUN}-%`]);
  for (const id of tenantIds) {
    const c = await owner.connect();
    try {
      await c.query("BEGIN");
      await c.query("SELECT set_config('app.tenant_id', $1, true)", [id]);
      await c.query("ALTER TABLE audit_log DISABLE TRIGGER audit_log_sin_cambios");
      await c.query("DELETE FROM audit_log WHERE tenant_id = $1", [id]);
      await c.query("ALTER TABLE audit_log ENABLE TRIGGER audit_log_sin_cambios");
      const del = await c.query("DELETE FROM tenants WHERE id = $1", [id]);
      if (del.rowCount !== 1) throw new Error("La limpieza no borró el negocio de prueba " + id);
      await c.query("COMMIT");
    } catch (e) {
      await c.query("ROLLBACK");
      throw e;
    } finally {
      c.release();
    }
  }
  await owner.end();
  await getPool().end();
});



const post = (fn: (r: Request) => Promise<Response>, path: string, t: T, body: unknown, method = "POST") => fn(api(method, path, t.cookie, body));
const putCfg = (t: T, o: Record<string, unknown> = {}) => post(putSettings, "/api/agenda/settings", t, { timezone: "America/Caracas", minNoticeMinutes: 120, maxDaysAhead: 30, slotStepMinutes: 30, ...o }, "PUT");
const putH = (t: T, days: unknown) => post(putHours, "/api/agenda/hours", t, { days }, "PUT");
const mkService = async (t: T, name = "Corte", durationMinutes = 60, extra: Record<string, unknown> = {}) => {
  const r = await post(createService, "/api/agenda/services", t, { name, durationMinutes, ...extra });
  return { status: r.status, id: (await r.json()).id as string };
};
const slots = async (t: T, serviceId: string, date: string, days = 1) => {
  const r = await getSlots(api("GET", `/api/agenda/slots?serviceId=${serviceId}&date=${date}&days=${days}`, t.cookie));
  return { status: r.status, body: await r.json() };
};
const timesOf = (b: { slots: { time: string }[] }) => b.slots.map((s) => s.time);
const ownerExec = async (tenantId: string, sql: string, params: unknown[] = []) => {
  const c = await owner.connect();
  try {
    await c.query("BEGIN");
    await c.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
    const r = await c.query(sql, params);
    await c.query("COMMIT");
    return r;
  } catch (e) {
    await c.query("ROLLBACK");
    throw e;
  } finally {
    c.release();
  }
};
const codeOf = async (p: Promise<unknown>) => { try { await p; return undefined; } catch (e) { return (e as { code?: string }).code; } };
/** Un día (en Caracas) dentro de 5 a 10 días, con su día de la semana. */
const future = (plus = 5) => {
  const date = addDays(localDate(Date.now(), "America/Caracas"), plus);
  const wd = ((new Date(date + "T00:00:00Z").getUTCDay() + 6) % 7) + 1;
  return { date, wd };
};
const allDays = (ranges: { start: string; end: string }[]) => [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({ weekday, ranges }));

describe("agenda: permisos", () => {
  it("leer la agenda: todos los roles; configurarla: solo dueño y administrador", () => {
    expect(can("owner", "agenda:manage")).toBe(true);
    expect(can("admin", "agenda:manage")).toBe(true);
    expect(can("agent", "agenda:manage")).toBe(false);
    for (const r of ["owner", "admin", "agent"] as const) expect(can(r, "agenda:read")).toBe(true);
    expect(can(null, "agenda:read")).toBe(false);
  });
});

describe("agenda: configuración (API)", () => {
  it("un negocio nuevo tiene valores por defecto y sin servicios ni horario", async () => {
    const t = await register("c1");
    const cfg = await (await getConfig(api("GET", "/api/agenda/config", t.cookie))).json();
    expect(cfg.settings).toEqual({ timezone: "America/Caracas", minNoticeMinutes: 120, maxDaysAhead: 30, slotStepMinutes: 30 });
    expect(cfg).toMatchObject({ hours: [], services: [], timeOff: [], canManage: true });
  });

  it("sin sesión: 401 en todo", async () => {
    expect((await getConfig(api("GET", "/api/agenda/config"))).status).toBe(401);
    expect((await putSettings(api("PUT", "/api/agenda/settings", undefined, {}))).status).toBe(401);
    expect((await getSlots(api("GET", `/api/agenda/slots?serviceId=${randomUUID()}&date=2030-01-01`))).status).toBe(401);
  });

  it("origen ajeno: 403 al modificar", async () => {
    const t = await register("c2");
    const bad = new Request(`${ORIGIN}/api/agenda/settings`, { method: "PUT", headers: { origin: "https://malo.example", "content-type": "application/json", cookie: t.cookie }, body: JSON.stringify({ timezone: "America/Caracas", minNoticeMinutes: 0, maxDaysAhead: 5, slotStepMinutes: 30 }) });
    expect((await putSettings(bad)).status).toBe(403);
  });

  it("guarda la zona horaria y las reglas; rechaza valores inválidos", async () => {
    const t = await register("c3");
    expect((await putCfg(t, { timezone: "America/Bogota", minNoticeMinutes: 30, maxDaysAhead: 60, slotStepMinutes: 15 })).status).toBe(200);
    const cfg = await (await getConfig(api("GET", "/api/agenda/config", t.cookie))).json();
    expect(cfg.settings).toEqual({ timezone: "America/Bogota", minNoticeMinutes: 30, maxDaysAhead: 60, slotStepMinutes: 15 });
    for (const bad of [{ timezone: "Mars/Olympus" }, { timezone: "UTC" }, { timezone: "x'; DROP TABLE" }, { minNoticeMinutes: -1 }, { minNoticeMinutes: 99999 }, { maxDaysAhead: 0 }, { maxDaysAhead: 400 }, { slotStepMinutes: 7 }, { slotStepMinutes: 1.5 }]) {
      expect((await putCfg(t, bad)).status).toBe(400);
    }
    expect((await (await getConfig(api("GET", "/api/agenda/config", t.cookie))).json()).settings.timezone).toBe("America/Bogota");
  });

  it("horario semanal: se guarda, se devuelve y un nuevo guardado lo reemplaza", async () => {
    const t = await register("h1");
    expect((await putH(t, [{ weekday: 1, ranges: [{ start: "09:00", end: "12:00" }, { start: "14:00", end: "18:00" }] }, { weekday: 6, ranges: [{ start: "08:00", end: "24:00" }] }])).status).toBe(200);
    let cfg = await (await getConfig(api("GET", "/api/agenda/config", t.cookie))).json();
    expect(cfg.hours).toEqual([{ weekday: 1, startMin: 540, endMin: 720 }, { weekday: 1, startMin: 840, endMin: 1080 }, { weekday: 6, startMin: 480, endMin: 1440 }]);
    expect((await putH(t, [{ weekday: 2, ranges: [{ start: "10:00", end: "11:00" }] }])).status).toBe(200);
    cfg = await (await getConfig(api("GET", "/api/agenda/config", t.cookie))).json();
    expect(cfg.hours).toEqual([{ weekday: 2, startMin: 600, endMin: 660 }]);
    expect((await putH(t, [])).status).toBe(200);
    expect((await (await getConfig(api("GET", "/api/agenda/config", t.cookie))).json()).hours).toEqual([]);
  });

  it("horario inválido: tramos cruzados, fin antes del inicio, formato, día repetido, más de 3 tramos; y NO borra el horario anterior", async () => {
    const t = await register("h2");
    await putH(t, [{ weekday: 1, ranges: [{ start: "09:00", end: "10:00" }] }]);
    const R = (start: string, end: string) => ({ start, end });
    const bads = [
      [{ weekday: 1, ranges: [R("09:00", "11:00"), R("10:00", "12:00")] }],
      [{ weekday: 1, ranges: [R("12:00", "09:00")] }],
      [{ weekday: 1, ranges: [R("09:00", "09:00")] }],
      [{ weekday: 1, ranges: [R("9:00", "10:00")] }],
      [{ weekday: 1, ranges: [R("09:00", "25:00")] }],
      [{ weekday: 1, ranges: [R("24:00", "24:00")] }],
      [{ weekday: 8, ranges: [R("09:00", "10:00")] }],
      [{ weekday: 1, ranges: [R("09:00", "10:00")] }, { weekday: 1, ranges: [R("11:00", "12:00")] }],
      [{ weekday: 1, ranges: [R("01:00", "02:00"), R("03:00", "04:00"), R("05:00", "06:00"), R("07:00", "08:00")] }],
    ];
    for (const b of bads) expect((await putH(t, b)).status).toBe(400);
    expect((await (await getConfig(api("GET", "/api/agenda/config", t.cookie))).json()).hours).toEqual([{ weekday: 1, startMin: 540, endMin: 600 }]);
  });

  it("tramos que se tocan (termina 12:00 / empieza 12:00) sí se permiten", async () => {
    const t = await register("h3");
    expect((await putH(t, [{ weekday: 1, ranges: [{ start: "09:00", end: "12:00" }, { start: "12:00", end: "14:00" }] }])).status).toBe(200);
  });
});

describe("agenda: servicios (API)", () => {
  it("crear, listar, cambiar y desactivar", async () => {
    const t = await register("s1");
    const a = await mkService(t, "Corte de cabello", 45, { priceText: "$8" });
    expect(a.status).toBe(201);
    let cfg = await (await getConfig(api("GET", "/api/agenda/config", t.cookie))).json();
    expect(cfg.services).toEqual([{ id: a.id, name: "Corte de cabello", durationMinutes: 45, priceText: "$8", active: true }]);
    expect((await post(updateService, "/api/agenda/services/update", t, { id: a.id, durationMinutes: 30, priceText: null })).status).toBe(200);
    expect((await post(updateService, "/api/agenda/services/update", t, { id: a.id, active: false })).status).toBe(200);
    cfg = await (await getConfig(api("GET", "/api/agenda/config", t.cookie))).json();
    expect(cfg.services[0]).toMatchObject({ durationMinutes: 30, priceText: null, active: false, name: "Corte de cabello" });
  });

  it("nombre repetido (sin importar mayúsculas) entre activos: 409; si el otro está inactivo, se puede reutilizar", async () => {
    const t = await register("s2");
    const a = await mkService(t, "Barba", 20);
    expect((await mkService(t, "  BARBA ", 20)).status).toBe(409);
    await post(updateService, "/api/agenda/services/update", t, { id: a.id, active: false });
    expect((await mkService(t, "Barba", 25)).status).toBe(201);
    // Reactivar el viejo choca con el nuevo
    expect((await post(updateService, "/api/agenda/services/update", t, { id: a.id, active: true })).status).toBe(409);
  });

  it("validación de servicios", async () => {
    const t = await register("s3");
    for (const bad of [{ name: "", durationMinutes: 30 }, { name: "x".repeat(81), durationMinutes: 30 }, { name: "A", durationMinutes: 4 }, { name: "A", durationMinutes: 481 }, { name: "A", durationMinutes: 30.5 }, { name: "A", durationMinutes: 30, priceText: "x".repeat(41) }]) {
      expect((await post(createService, "/api/agenda/services", t, bad)).status).toBe(400);
    }
  });

  it("máximo de 50 servicios activos", async () => {
    const t = await register("s4");
    await ownerExec(t.tenantId, "INSERT INTO agenda_services (tenant_id, name, duration_minutes) SELECT $1, 'S' || g, 30 FROM generate_series(1, 50) g", [t.tenantId]);
    const r = await post(createService, "/api/agenda/services", t, { name: "Uno más", durationMinutes: 30 });
    expect(r.status).toBe(409);
    expect((await r.json()).error).toBe("limite_servicios");
  });

  it("otro negocio no puede ver ni modificar mis servicios", async () => {
    const a = await register("s5");
    const b = await register("s6");
    const s = await mkService(a, "Privado", 30);
    expect((await post(updateService, "/api/agenda/services/update", b, { id: s.id, name: "Hackeado" })).status).toBe(404);
    expect((await (await getConfig(api("GET", "/api/agenda/config", b.cookie))).json()).services).toEqual([]);
    expect((await slots(b, s.id, future().date)).status).toBe(404);
  });
});

describe("agenda: bloqueos (API)", () => {
  const inDays = (n: number, h = 9) => new Date(Date.now() + n * 86_400_000 + h * 3_600_000).toISOString();

  it("crear, listar y quitar un bloqueo", async () => {
    const t = await register("o1");
    const r = await post(createOff, "/api/agenda/time-off", t, { startsAt: inDays(3), endsAt: inDays(5), reason: "Vacaciones" });
    expect(r.status).toBe(201);
    const { id, appointmentsInside } = await r.json();
    expect(appointmentsInside).toBe(0);
    let cfg = await (await getConfig(api("GET", "/api/agenda/config", t.cookie))).json();
    expect(cfg.timeOff).toHaveLength(1);
    expect(cfg.timeOff[0]).toMatchObject({ id, reason: "Vacaciones" });
    expect((await post(deleteOff, "/api/agenda/time-off/delete", t, { id })).status).toBe(200);
    expect((await post(deleteOff, "/api/agenda/time-off/delete", t, { id })).status).toBe(404);
    cfg = await (await getConfig(api("GET", "/api/agenda/config", t.cookie))).json();
    expect(cfg.timeOff).toEqual([]);
  });

  it("rechaza fechas al revés, ya pasadas, demasiado largas o mal escritas", async () => {
    const t = await register("o2");
    for (const bad of [
      { startsAt: inDays(5), endsAt: inDays(3) },
      { startsAt: inDays(3), endsAt: inDays(3) },
      { startsAt: inDays(-5), endsAt: inDays(-3) },
      { startsAt: inDays(1), endsAt: inDays(500) },
      { startsAt: "mañana", endsAt: inDays(3) },
      { startsAt: inDays(1), endsAt: inDays(2), reason: "x".repeat(201) },
    ]) expect((await post(createOff, "/api/agenda/time-off", t, bad)).status).toBe(400);
  });

  it("avisa cuántas citas activas quedan dentro del bloqueo (sin tocarlas)", async () => {
    const t = await register("o3");
    const s = await mkService(t, "Corte", 60);
    const start = new Date(Date.now() + 4 * 86_400_000);
    await ownerExec(t.tenantId, "INSERT INTO appointments (tenant_id, service_id, customer_name, starts_at, ends_at, source, status) VALUES ($1,$2,'Ana',$3,$4,'manual','confirmada')", [t.tenantId, s.id, start, new Date(start.getTime() + 3_600_000)]);
    const r = await (await post(createOff, "/api/agenda/time-off", t, { startsAt: inDays(3), endsAt: inDays(6) })).json();
    expect(r.appointmentsInside).toBe(1);
    const still = await ownerExec(t.tenantId, "SELECT status FROM appointments");
    expect(still.rows[0].status).toBe("confirmada");
  });

  it("otro negocio no puede quitar mi bloqueo", async () => {
    const a = await register("o4");
    const b = await register("o5");
    const { id } = await (await post(createOff, "/api/agenda/time-off", a, { startsAt: inDays(3), endsAt: inDays(4) })).json();
    expect((await post(deleteOff, "/api/agenda/time-off/delete", b, { id })).status).toBe(404);
    expect((await (await getConfig(api("GET", "/api/agenda/config", a.cookie))).json()).timeOff).toHaveLength(1);
  });
});

describe("agenda: huecos libres (API)", () => {
  async function ready(name: string, o: Record<string, unknown> = {}) {
    const t = await register(name);
    await putCfg(t, o);
    await putH(t, allDays([{ start: "09:00", end: "12:00" }, { start: "14:00", end: "16:00" }]));
    const s = await mkService(t, "Consulta", 60);
    return { t, s: s.id };
  }

  it("devuelve los huecos del servicio en hora local, con instantes UTC", async () => {
    const { t, s } = await ready("l1");
    const { date } = future();
    const r = await slots(t, s, date);
    expect(r.status).toBe(200);
    expect(timesOf(r.body)).toEqual(["09:00", "09:30", "10:00", "10:30", "11:00", "14:00", "14:30", "15:00"]);
    expect(r.body.slots[0]).toMatchObject({ date, time: "09:00", startsAt: `${date}T13:00:00.000Z`, endsAt: `${date}T14:00:00.000Z` });
  });

  it("cambiar la zona horaria del negocio cambia los instantes UTC pero no la hora local", async () => {
    const { t, s } = await ready("l2", { timezone: "America/Santiago", maxDaysAhead: 120 });
    const { date } = future(40);
    const r = await slots(t, s, date);
    expect(r.body.slots[0].time).toBe("09:00");
    expect(r.body.slots[0].startsAt).not.toBe(`${date}T13:00:00.000Z`);
  });

  it("una cita activa quita los huecos que se cruzan; una cancelada no", async () => {
    const { t, s } = await ready("l3");
    const { date } = future();
    const start = new Date(`${date}T14:00:00Z`); // 10:00 local
    const ins = (status: string) => ownerExec(t.tenantId, "INSERT INTO appointments (tenant_id, service_id, customer_name, starts_at, ends_at, source, status) VALUES ($1,$2,'Ana',$3,$4,'manual',$5) RETURNING id", [t.tenantId, s, start, new Date(start.getTime() + 3_600_000), status]);
    const a = await ins("cancelada");
    expect(timesOf((await slots(t, s, date)).body)).toContain("10:00");
    await ownerExec(t.tenantId, "DELETE FROM appointments WHERE id = $1", [a.rows[0].id]);
    await ins("pendiente");
    expect(timesOf((await slots(t, s, date)).body)).toEqual(["09:00", "11:00", "14:00", "14:30", "15:00"]);
  });

  it("un bloqueo quita los huecos del periodo", async () => {
    const { t, s } = await ready("l4");
    const { date } = future();
    await post(createOff, "/api/agenda/time-off", t, { startsAt: `${date}T13:00:00Z`, endsAt: `${date}T15:00:00Z` }); // 09:00–11:00 local
    expect(timesOf((await slots(t, s, date)).body)).toEqual(["11:00", "14:00", "14:30", "15:00"]);
  });

  it("respeta el máximo de días hacia adelante y el preaviso", async () => {
    const { t, s } = await ready("l5", { maxDaysAhead: 3, minNoticeMinutes: 0 });
    expect((await slots(t, s, future(10).date)).body.slots).toEqual([]);
    const { t: t2, s: s2 } = await ready("l6", { minNoticeMinutes: 10080 });
    expect((await slots(t2, s2, future(2).date)).body.slots).toEqual([]);
    expect((await slots(t2, s2, future(9).date)).body.slots.length).toBeGreaterThan(0);
  });

  it("varios días a la vez, ordenados", async () => {
    const { t, s } = await ready("l7");
    const r = await slots(t, s, future().date, 3);
    const dates = [...new Set(r.body.slots.map((x: { date: string }) => x.date))];
    expect(dates).toHaveLength(3);
    expect(r.body.slots.map((x: { startsAt: string }) => x.startsAt)).toEqual([...r.body.slots.map((x: { startsAt: string }) => x.startsAt)].sort());
  });

  it("servicio inactivo o inexistente: 404; datos mal formados: 400", async () => {
    const { t, s } = await ready("l8");
    await post(updateService, "/api/agenda/services/update", t, { id: s, active: false });
    expect((await slots(t, s, future().date)).status).toBe(404);
    expect((await slots(t, randomUUID(), future().date)).status).toBe(404);
    for (const q of [`serviceId=no-uuid&date=2030-01-01`, `serviceId=${s}&date=2030-02-31`, `serviceId=${s}&date=ayer`, `serviceId=${s}&date=2030-01-01&days=0`, `serviceId=${s}&date=2030-01-01&days=99`]) {
      expect((await getSlots(api("GET", `/api/agenda/slots?${q}`, t.cookie))).status).toBe(400);
    }
  });
});

describe("agenda: base de datos (citas)", () => {
  async function ready(name: string) {
    const t = await register(name);
    const s = (await mkService(t)).id;
    const ins = (start: string, minutes: number, status = "confirmada", tenant = t, service = s) =>
      ownerExec(tenant.tenantId, "INSERT INTO appointments (tenant_id, service_id, customer_name, starts_at, ends_at, source, status) VALUES ($1,$2,'Ana',$3,$3::timestamptz + ($4 || ' minutes')::interval,'manual',$5) RETURNING id", [tenant.tenantId, service, start, String(minutes), status]);
    return { t, s, ins };
  }

  it("dos citas activas que se cruzan: la base de datos lo impide (23P01)", async () => {
    const { ins } = await ready("d1");
    await ins("2031-05-05T14:00:00Z", 60);
    expect(await codeOf(ins("2031-05-05T14:30:00Z", 60))).toBe("23P01");
    expect(await codeOf(ins("2031-05-05T13:30:00Z", 60))).toBe("23P01");
    expect(await codeOf(ins("2031-05-05T14:10:00Z", 10))).toBe("23P01"); // contenida
    expect(await codeOf(ins("2031-05-05T14:00:00Z", 60, "pendiente"))).toBe("23P01");
  });

  it("citas pegadas (una termina cuando empieza la otra) sí caben", async () => {
    const { ins } = await ready("d2");
    await ins("2031-05-05T14:00:00Z", 60);
    await ins("2031-05-05T15:00:00Z", 60);
    await ins("2031-05-05T13:00:00Z", 60);
  });

  it("las canceladas, completadas y no-asistió no bloquean; al reactivar una, vuelve a regir la regla", async () => {
    const { t, ins } = await ready("d3");
    for (const st of ["cancelada", "completada", "no_asistio"]) await ins("2031-05-06T14:00:00Z", 60, st);
    const a = await ins("2031-05-06T14:00:00Z", 60, "confirmada");
    expect(await codeOf(ownerExec(t.tenantId, "UPDATE appointments SET status = 'confirmada' WHERE status = 'cancelada'"))).toBe("23P01");
    await ownerExec(t.tenantId, "UPDATE appointments SET status = 'cancelada' WHERE id = $1", [a.rows[0].id]);
    await ownerExec(t.tenantId, "UPDATE appointments SET status = 'confirmada' WHERE status = 'completada'");
  });

  it("negocios distintos pueden tener citas a la misma hora", async () => {
    const a = await ready("d4");
    const b = await ready("d5");
    await a.ins("2031-05-07T14:00:00Z", 60);
    await b.ins("2031-05-07T14:00:00Z", 60);
  });

  it("una cita no puede usar el servicio de otro negocio", async () => {
    const a = await ready("d6");
    const b = await ready("d7");
    expect(await codeOf(a.ins("2031-05-08T14:00:00Z", 60, "confirmada", a.t, b.s))).toBe("23503");
  });

  it("fin antes del inicio y estados/origen inválidos se rechazan", async () => {
    const { t, s } = await ready("d8");
    const q = (start: string, end: string, st = "confirmada", src = "manual") => ownerExec(t.tenantId, "INSERT INTO appointments (tenant_id, service_id, customer_name, starts_at, ends_at, source, status) VALUES ($1,$2,'A',$3,$4,$6,$5)", [t.tenantId, s, start, end, st, src]);
    expect(await codeOf(q("2031-05-09T15:00:00Z", "2031-05-09T14:00:00Z"))).toBe("23514");
    expect(await codeOf(q("2031-05-09T14:00:00Z", "2031-05-09T15:00:00Z", "inventado"))).toBe("23514");
    expect(await codeOf(q("2031-05-09T14:00:00Z", "2031-05-09T15:00:00Z", "confirmada", "otro"))).toBe("23514");
  });

  it("la aplicación (app_user) solo ve las citas de su negocio", async () => {
    const a = await ready("d9");
    const b = await ready("d10");
    await a.ins("2031-05-10T14:00:00Z", 60);
    const seen = await withTenant(b.t.tenantId, async (db) => (await db.query("SELECT count(*)::int AS n FROM appointments")).rows[0].n);
    expect(seen).toBe(0);
    const mine = await withTenant(a.t.tenantId, async (db) => (await db.query("SELECT count(*)::int AS n FROM appointments")).rows[0].n);
    expect(mine).toBe(1);
  });

  it("horario: la base de datos también impide tramos cruzados y fuera de rango", async () => {
    const t = await register("d11");
    const q = (w: number, a: number, b: number) => withTenant(t.tenantId, (db) => db.query("INSERT INTO agenda_hours (tenant_id, weekday, start_min, end_min) VALUES ($1,$2,$3,$4)", [t.tenantId, w, a, b]));
    await q(1, 540, 720);
    expect(await codeOf(q(1, 600, 800))).toBe("23P01");
    await q(2, 600, 800);
    expect(await codeOf(q(1, 700, 600))).toBe("23514");
    expect(await codeOf(q(8, 100, 200))).toBe("23514");
    expect(await codeOf(q(3, 0, 1441))).toBe("23514");
  });
});
EOF_TESTS_AGENDA_TEST_TS
echo "✔ tests/agenda.test.ts"

cat <<'FIN'

══════════════════════════════════════════════════════════
 Paso 13A aplicado. Ahora, en este orden:

   1) Abre Docker Desktop y:   npm run db:up
   2) npm run db:migrate       # aplica 0013 (agenda y citas). Crea la extensión btree_gist.
   3) npm run typecheck && npm run lint && npm test
   4) npm run dev:all          # reinícialo
   5) Prueba en «Agenda» (nuevo en el menú de arriba):
        - Crea un servicio (ej. «Corte», 30 min) y define tu horario semanal.
        - En «Probar horarios libres» elige una fecha futura: verás los horarios que se ofrecerían.
        - Bloquea un día y comprueba que ya no ofrece horarios ese día.

   Si el paso 2 falla con «permission denied to create extension "btree_gist"», avísame con el mensaje
   completo (no lo ignores): en ese caso se crea una vez como superusuario y te doy el comando.

   Nota: todavía no se pueden crear citas desde la pantalla (Paso 13B) ni las toma el asistente (13C).
══════════════════════════════════════════════════════════
FIN