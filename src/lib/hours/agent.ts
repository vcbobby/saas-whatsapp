import { withTenant } from "@/lib/db";
import { loadBusinessHours } from "./load";
import { closedNotice, isOpen, scheduleText } from "./pure";

export interface HoursContext {
  /** Resumen del horario para el asistente. */
  schedule: string;
  open: boolean;
  /** Aviso a añadir cuando se pasa a una persona fuera de horario (vacío si estamos abiertos). */
  notice: string;
}

/** Horario de atención del negocio para el asistente; null si no lo configuró o lo apagó. Nunca lanza. */
export async function hoursContext(tenantId: string, nowMs: number = Date.now()): Promise<HoursContext | null> {
  try {
    const h = await withTenant(tenantId, (db) => loadBusinessHours(db, tenantId));
    if (!h.enabled || h.ranges.length === 0) return null;
    const open = isOpen(h.ranges, h.timezone, nowMs);
    return { schedule: scheduleText(h.ranges), open, notice: open ? "" : closedNotice(h.ranges, h.timezone, nowMs, h.closedNote) };
  } catch (err) {
    console.error("[horario] no se pudo leer:", err instanceof Error ? err.message : err);
    return null;
  }
}
