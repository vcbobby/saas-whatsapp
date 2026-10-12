import { z } from "zod";
import { requireTenant } from "@/lib/auth/guard";
import { checkOrigin, errorResponse, jsonResponse, readJson, route } from "@/lib/auth/http";
import { withTenant } from "@/lib/db";
import { activeServiceDuration, isStartFree, loadSettings } from "@/lib/agenda/load";
import { MAX_SLOT_DAYS } from "@/lib/agenda/slots";
import { addDays, isValidYmd, localToUtc } from "@/lib/agenda/tz";

const listQuery = z.object({
  date: z.string().refine(isValidYmd, "Fecha inválida (AAAA-MM-DD)"),
  days: z.coerce.number().int().min(1).max(MAX_SLOT_DAYS).default(1),
});

const SELECT = `SELECT a.id, a.service_id, s.name AS service_name, a.customer_name, a.customer_phone, a.notes, a.starts_at, a.ends_at,
                       a.status, a.source, a.conversation_id
                  FROM appointments a JOIN agenda_services s ON s.tenant_id = a.tenant_id AND s.id = a.service_id`;

function appointmentJson(a: Record<string, unknown>) {
  return {
    id: a.id, serviceId: a.service_id, serviceName: a.service_name, customerName: a.customer_name, customerPhone: a.customer_phone,
    notes: a.notes, startsAt: a.starts_at, endsAt: a.ends_at, status: a.status, source: a.source, conversationId: a.conversation_id,
  };
}

/** Citas de un rango de días (fechas locales del negocio). */
export const GET = route(async (req) => {
  const auth = await requireTenant(req, "agenda:read");
  if (!auth.ok) return auth.response;
  const sp = new URL(req.url).searchParams;
  const q = listQuery.safeParse({ date: sp.get("date"), days: sp.get("days") ?? undefined });
  if (!q.success) return errorResponse(400, "datos_invalidos", q.error.issues[0]?.message ?? "Datos inválidos.");
  const { tenantId } = auth.ctx;

  const data = await withTenant(tenantId, async (db) => {
    const { timezone } = await loadSettings(db, tenantId);
    const from = localToUtc(q.data.date, 0, timezone);
    const to = localToUtc(addDays(q.data.date, q.data.days), 0, timezone);
    if (from === null || to === null) return { timezone, rows: [] as Record<string, unknown>[] };
    const r = await db.query(`${SELECT} WHERE a.tenant_id = $1 AND a.starts_at >= $2 AND a.starts_at < $3 ORDER BY a.starts_at, a.id LIMIT 500`, [tenantId, new Date(from).toISOString(), new Date(to).toISOString()]);
    return { timezone, rows: r.rows };
  });
  return jsonResponse({ timezone: data.timezone, appointments: data.rows.map(appointmentJson) });
});

const createSchema = z.object({
  serviceId: z.uuid(),
  startsAt: z.iso.datetime({ offset: true }),
  customerName: z.string().trim().min(1, "Escribe el nombre del cliente").max(120, "Máximo 120 caracteres"),
  customerPhone: z.string().trim().regex(/^\+?[0-9 ()-]{5,32}$/, "Teléfono inválido").optional(),
  notes: z.string().trim().max(1000, "Máximo 1000 caracteres").optional(),
  conversationId: z.uuid().optional(),
});

/**
 * Crea una cita a mano. El servidor comprueba que ese inicio sea un hueco libre (misma función que muestra los horarios);
 * y la base de datos impide, además, que dos citas se crucen aunque dos personas reserven a la vez.
 */
export const POST = route(async (req) => {
  const blocked = checkOrigin(req);
  if (blocked) return blocked;
  const auth = await requireTenant(req, "agenda:book");
  if (!auth.ok) return auth.response;
  const body = await readJson(req, createSchema);
  if (!body.ok) return body.response;
  const { tenantId } = auth.ctx;
  const d = body.data;

  const out = await withTenant(tenantId, async (db) => {
    const duration = await activeServiceDuration(db, tenantId, d.serviceId);
    if (duration === null) return "servicio" as const;
    let contactId: string | null = null;
    if (d.conversationId) {
      const c = await db.query("SELECT contact_id FROM conversations WHERE tenant_id = $1 AND id = $2", [tenantId, d.conversationId]);
      if (c.rowCount !== 1) return "conversacion" as const;
      contactId = c.rows[0].contact_id as string;
    }
    if (!(await isStartFree(db, tenantId, duration, d.startsAt))) return "ocupado" as const;
    const start = new Date(d.startsAt);
    try {
      const r = await db.query(
        `INSERT INTO appointments (tenant_id, service_id, contact_id, conversation_id, customer_name, customer_phone, notes, starts_at, ends_at, status, source, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'confirmada', 'manual', $10) RETURNING id`,
        [tenantId, d.serviceId, contactId, d.conversationId ?? null, d.customerName, d.customerPhone || null, d.notes || null, start.toISOString(), new Date(start.getTime() + duration * 60_000).toISOString(), auth.session.userId],
      );
      return r.rows[0].id as string;
    } catch (e) {
      if ((e as { code?: string }).code === "23P01") return "ocupado" as const;
      throw e;
    }
  });
  if (out === "servicio") return errorResponse(404, "no_encontrado", "Servicio no encontrado o inactivo.");
  if (out === "conversacion") return errorResponse(404, "no_encontrado", "Conversación no encontrada.");
  if (out === "ocupado") return errorResponse(409, "horario_no_disponible", "Ese horario ya no está disponible. Elige otro.");
  return jsonResponse({ ok: true, id: out }, 201);
});
