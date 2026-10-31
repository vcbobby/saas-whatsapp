import { z } from "zod";
import { requireTenant } from "@/lib/auth/guard";
import { checkOrigin, errorResponse, jsonResponse, readJson, route } from "@/lib/auth/http";
import { withTenant } from "@/lib/db";
import { cleanSupportText } from "@/lib/support/schema";

const schema = z.object({
  kind: z.enum(["idea", "problema", "otro"]),
  message: z.string().transform(cleanSupportText).pipe(z.string().min(3, "Cuéntanos un poco más").max(2000, "Máximo 2000 letras")),
  page: z.string().trim().max(120).regex(/^\/[A-Za-z0-9/_\-.]*$/).optional(),
});

/** Comentario de un tester (cualquier persona del equipo). Llega al súper admin en /admin/comentarios. */
export const POST = route(async (req) => {
  const blocked = checkOrigin(req);
  if (blocked) return blocked;
  const auth = await requireTenant(req, "feedback:send");
  if (!auth.ok) return auth.response;
  if (auth.ctx.impersonating) return errorResponse(403, "sin_permiso", "El soporte no puede enviar comentarios en nombre de un negocio.");
  const body = await readJson(req, schema);
  if (!body.ok) return body.response;
  const { tenantId } = auth.ctx;
  await withTenant(tenantId, (db) =>
    db.query("INSERT INTO feedback (tenant_id, user_id, kind, message, page) VALUES ($1,$2,$3,$4,$5)", [tenantId, auth.session.userId, body.data.kind, body.data.message, body.data.page ?? null]),
  );
  return jsonResponse({ ok: true }, 201);
}, { limit: "support" });
