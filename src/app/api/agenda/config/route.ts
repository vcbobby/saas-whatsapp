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
