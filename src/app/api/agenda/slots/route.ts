import { z } from "zod";
import { requireTenant } from "@/lib/auth/guard";
import { errorResponse, jsonResponse, route } from "@/lib/auth/http";
import { withTenant } from "@/lib/db";
import { slotsForService } from "@/lib/agenda/load";
import { MAX_SLOT_DAYS } from "@/lib/agenda/slots";
import { isValidYmd } from "@/lib/agenda/tz";

const query = z.object({
  serviceId: z.uuid(),
  date: z.string().refine(isValidYmd, "Fecha inválida (AAAA-MM-DD)"),
  days: z.coerce.number().int().min(1).max(MAX_SLOT_DAYS).default(1),
});

/** Huecos libres de un servicio a partir de una fecha (hora local del negocio). */
export const GET = route(async (req) => {
  const auth = await requireTenant(req, "agenda:read");
  if (!auth.ok) return auth.response;
  const sp = new URL(req.url).searchParams;
  const q = query.safeParse({ serviceId: sp.get("serviceId"), date: sp.get("date"), days: sp.get("days") ?? undefined });
  if (!q.success) return errorResponse(400, "datos_invalidos", q.error.issues[0]?.message ?? "Datos inválidos.");
  const { tenantId } = auth.ctx;
  const slots = await withTenant(tenantId, (db) => slotsForService(db, tenantId, q.data.serviceId, q.data.date, q.data.days));
  if (!slots) return errorResponse(404, "no_encontrado", "Servicio no encontrado o inactivo.");
  return jsonResponse({ slots });
});
