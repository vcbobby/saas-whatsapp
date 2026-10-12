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
