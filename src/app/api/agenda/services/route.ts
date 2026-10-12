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
