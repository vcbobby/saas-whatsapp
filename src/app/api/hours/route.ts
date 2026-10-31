import { z } from "zod";
import { requireTenant } from "@/lib/auth/guard";
import { checkOrigin, errorResponse, jsonResponse, readJson, route } from "@/lib/auth/http";
import { withTenant } from "@/lib/db";
import { isValidTimeZone, parseHm } from "@/lib/agenda/tz";
import { loadBusinessHours } from "@/lib/hours/load";
import { closedNotice, isOpen } from "@/lib/hours/pure";

export const GET = route(async (req) => {
  const auth = await requireTenant(req, "settings:edit");
  if (!auth.ok) return auth.response;
  const { tenantId } = auth.ctx;
  const h = await withTenant(tenantId, (db) => loadBusinessHours(db, tenantId));
  const now = Date.now();
  const open = h.ranges.length > 0 && isOpen(h.ranges, h.timezone, now);
  return jsonResponse({ ...h, openNow: open, sample: h.ranges.length > 0 ? closedNotice(h.ranges, h.timezone, now, h.closedNote) : "" });
});

const range = z.object({ start: z.string(), end: z.string() });
const schema = z.object({
  enabled: z.boolean(),
  timezone: z.string().trim().refine(isValidTimeZone, "Zona horaria no válida (ejemplo: America/Caracas)"),
  closedNote: z.string().trim().max(300, "El texto extra admite hasta 300 letras").nullable(),
  days: z.array(z.object({ weekday: z.number().int().min(1).max(7), ranges: z.array(range).max(3, "Máximo 3 tramos por día") })).max(7),
});

/** Guarda todo el horario de atención de una vez (los días que no vengan quedan cerrados). */
export const PUT = route(async (req) => {
  const blocked = checkOrigin(req);
  if (blocked) return blocked;
  const auth = await requireTenant(req, "settings:edit");
  if (!auth.ok) return auth.response;
  const body = await readJson(req, schema);
  if (!body.ok) return body.response;
  const d = body.data;

  const rows: { weekday: number; start: number; end: number }[] = [];
  const seen = new Set<number>();
  for (const day of d.days) {
    if (seen.has(day.weekday)) return errorResponse(400, "datos_invalidos", "Un día aparece repetido.");
    seen.add(day.weekday);
    for (const r of day.ranges) {
      const start = parseHm(r.start), end = parseHm(r.end, true);
      if (start === null || end === null) return errorResponse(400, "datos_invalidos", "Usa horas válidas con formato HH:MM.");
      if (start >= end) return errorResponse(400, "datos_invalidos", "La hora de cierre debe ser después de la de apertura.");
      rows.push({ weekday: day.weekday, start, end });
    }
  }
  if (d.enabled && rows.length === 0) return errorResponse(400, "datos_invalidos", "Para activarlo, abre al menos un día.");

  const { tenantId } = auth.ctx;
  try {
    await withTenant(tenantId, async (db) => {
      await db.query("DELETE FROM business_hours WHERE tenant_id = $1", [tenantId]);
      for (const r of rows) await db.query("INSERT INTO business_hours (tenant_id, weekday, start_min, end_min) VALUES ($1,$2,$3,$4)", [tenantId, r.weekday, r.start, r.end]);
      await db.query(
        `INSERT INTO business_hours_settings (tenant_id, enabled, closed_note) VALUES ($1,$2,$3)
         ON CONFLICT (tenant_id) DO UPDATE SET enabled = EXCLUDED.enabled, closed_note = EXCLUDED.closed_note, updated_at = now()`,
        [tenantId, d.enabled, d.closedNote || null]);
      // La zona horaria es la misma que usa la agenda.
      await db.query(
        "INSERT INTO agenda_settings (tenant_id, timezone, updated_by) VALUES ($1,$2,$3) ON CONFLICT (tenant_id) DO UPDATE SET timezone = EXCLUDED.timezone, updated_at = now(), updated_by = EXCLUDED.updated_by",
        [tenantId, d.timezone, auth.session.userId]);
      await db.query("INSERT INTO audit_log (tenant_id, actor_id, action, target_type, metadata) VALUES ($1,$2,'hours.update','tenant',$3::jsonb)", [tenantId, auth.session.userId, JSON.stringify({ enabled: d.enabled, ranges: rows.length, timezone: d.timezone })]);
    });
  } catch (e) {
    if ((e as { code?: string }).code === "23P01") return errorResponse(400, "datos_invalidos", "Hay tramos que se cruzan el mismo día.");
    throw e;
  }
  return jsonResponse({ ok: true });
});
