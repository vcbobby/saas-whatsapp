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

/** Todo lo necesario para calcular huecos con una duración dada entre dos instantes. */
async function slotContext(db: Db, tenantId: string, durationMin: number, fromMs: number, toMs: number, excludeId: string | null): Promise<Omit<SlotInput, "fromDate" | "days">> {
  const settings = await loadSettings(db, tenantId);
  const hours = await loadHours(db, tenantId);
  const range = [new Date(fromMs).toISOString(), new Date(toMs).toISOString()];
  const off = await db.query("SELECT starts_at, ends_at FROM agenda_time_off WHERE tenant_id = $1 AND ends_at > $2 AND starts_at < $3", [tenantId, ...range]);
  const busy = await db.query(
    "SELECT starts_at, ends_at FROM appointments WHERE tenant_id = $1 AND status IN ('pendiente', 'confirmada') AND ends_at > $2 AND starts_at < $3 AND ($4::uuid IS NULL OR id <> $4)",
    [tenantId, ...range, excludeId],
  );
  const iv = (r: { starts_at: Date; ends_at: Date }) => ({ startMs: r.starts_at.getTime(), endMs: r.ends_at.getTime() });
  return {
    tz: settings.timezone, nowMs: Date.now(), durationMin, stepMin: settings.slotStepMinutes, hours,
    timeOff: off.rows.map(iv), busy: busy.rows.map(iv), minNoticeMin: settings.minNoticeMinutes, maxDaysAhead: settings.maxDaysAhead,
  };
}

/** Duración de un servicio ACTIVO, o null si no existe / está inactivo. */
export async function activeServiceDuration(db: Db, tenantId: string, serviceId: string): Promise<number | null> {
  const svc = await db.query("SELECT duration_minutes FROM agenda_services WHERE tenant_id = $1 AND id = $2 AND active", [tenantId, serviceId]);
  return svc.rowCount === 1 ? (svc.rows[0].duration_minutes as number) : null;
}

/** Huecos libres de un servicio desde `fromDate` durante `days` días. null = el servicio no existe o está inactivo. */
export async function slotsForService(db: Db, tenantId: string, serviceId: string, fromDate: string, days: number): Promise<Slot[] | null> {
  const duration = await activeServiceDuration(db, tenantId, serviceId);
  if (duration === null) return null;
  const d = Math.max(1, Math.min(MAX_SLOT_DAYS, days));
  const settings = await loadSettings(db, tenantId);
  // Ventana amplia (un día de margen a cada lado) para cubrir diferencias de zona horaria.
  const from = (localToUtc(addDays(fromDate, -1), 0, settings.timezone) ?? Date.parse(fromDate) - 86_400_000);
  const to = (localToUtc(addDays(fromDate, d + 1), 0, settings.timezone) ?? Date.parse(fromDate) + (d + 1) * 86_400_000);
  const ctx = await slotContext(db, tenantId, duration, from, to, null);
  return computeSlots({ ...ctx, fromDate, days: d });
}

/**
 * ¿Ese inicio exacto es un hueco libre con esa duración? Es la validación que usa el servidor antes de guardar una cita.
 * `excludeId`: al reprogramar, la propia cita no cuenta como ocupada.
 */
export async function isStartFree(db: Db, tenantId: string, durationMin: number, startIso: string, excludeId: string | null = null): Promise<boolean> {
  const ms = Date.parse(startIso);
  if (Number.isNaN(ms)) return false;
  const ctx = await slotContext(db, tenantId, durationMin, ms - 86_400_000, ms + 2 * 86_400_000, excludeId);
  return isSlotAvailable(ctx, startIso);
}
