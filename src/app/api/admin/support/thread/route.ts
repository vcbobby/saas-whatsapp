import { getPool } from "@/lib/db";
import { errorResponse, jsonResponse, route } from "@/lib/auth/http";
import { requireSuperAdmin } from "@/lib/auth/guard";
import { idQuerySchema } from "@/lib/support/schema";

export const GET = route(async (req) => {
  const auth = await requireSuperAdmin(req);
  if (!auth.ok) return auth.response;
  const id = idQuerySchema.safeParse(new URL(req.url).searchParams.get("id"));
  if (!id.success) return errorResponse(400, "datos_invalidos", "Consulta no válida.");
  const r = await getPool().query("SELECT admin_support_get($1, $2) AS t", [auth.tokenHash, id.data]);
  return jsonResponse({ ticket: r.rows[0].t });
});
