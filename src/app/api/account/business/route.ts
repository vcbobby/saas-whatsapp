import { requireTenant } from "@/lib/auth/guard";
import { checkOrigin, errorResponse, jsonResponse, readJson, route } from "@/lib/auth/http";
import { withTenant } from "@/lib/db";
import { businessNameSchema } from "@/lib/account/schema";

/** Cambia el nombre del negocio. Solo dueño y administradores. */
export const PATCH = route(async (req) => {
  const blocked = checkOrigin(req);
  if (blocked) return blocked;
  const auth = await requireTenant(req, "settings:edit");
  if (!auth.ok) return auth.response;
  if (auth.ctx.impersonating) return errorResponse(403, "sin_permiso", "El soporte no puede cambiar el nombre de un negocio.");
  const body = await readJson(req, businessNameSchema);
  if (!body.ok) return body.response;
  const { tenantId } = auth.ctx;
  const name = body.data.name;
  const before = await withTenant(tenantId, async (db) => {
    const old = String((await db.query("SELECT name FROM tenants WHERE id = $1", [tenantId])).rows[0]?.name ?? "");
    if (old === name) return old;
    await db.query("UPDATE tenants SET name = $2 WHERE id = $1", [tenantId, name]);
    await db.query("INSERT INTO audit_log (tenant_id, actor_id, action, target_type, target_id, metadata) VALUES ($1, $2, 'tenant.renamed', 'tenant', $3, $4)", [tenantId, auth.session.userId, tenantId, JSON.stringify({ from: old, to: name })]);
    return old;
  });
  return jsonResponse({ ok: true, name, changed: before !== name });
});
