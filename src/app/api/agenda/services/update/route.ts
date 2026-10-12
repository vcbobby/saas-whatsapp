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
