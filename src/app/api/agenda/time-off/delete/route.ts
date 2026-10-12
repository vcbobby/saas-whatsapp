import { z } from "zod";
import { requireTenant } from "@/lib/auth/guard";
import { checkOrigin, errorResponse, jsonResponse, readJson, route } from "@/lib/auth/http";
import { withTenant } from "@/lib/db";

export const POST = route(async (req) => {
  const blocked = checkOrigin(req);
  if (blocked) return blocked;
  const auth = await requireTenant(req, "agenda:manage");
  if (!auth.ok) return auth.response;
  const body = await readJson(req, z.object({ id: z.uuid() }));
  if (!body.ok) return body.response;
  const { tenantId } = auth.ctx;
  const r = await withTenant(tenantId, (db) => db.query("DELETE FROM agenda_time_off WHERE tenant_id = $1 AND id = $2", [tenantId, body.data.id]));
  return r.rowCount === 1 ? jsonResponse({ ok: true }) : errorResponse(404, "no_encontrado", "No encontrado.");
});
