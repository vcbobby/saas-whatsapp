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
