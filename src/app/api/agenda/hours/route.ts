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
