import { z } from "zod";
import { requireTenant } from "@/lib/auth/guard";
import { checkOrigin, errorResponse, jsonResponse, readJson, route } from "@/lib/auth/http";
import { withTenant } from "@/lib/db";
import { clearDemo, demoCounts, loadDemo } from "@/lib/demo/seed";

export const GET = route(async (req) => {
  const auth = await requireTenant(req, "settings:edit");
  if (!auth.ok) return auth.response;
  const { tenantId } = auth.ctx;
  const c = await withTenant(tenantId, (db) => demoCounts(db, tenantId));
  return jsonResponse({ present: c.contacts + c.products + c.services + c.orders > 0, ...c });
});

const schema = z.object({ action: z.enum(["load", "clear"]) });

/** Carga o borra los datos de ejemplo del negocio. */
export const POST = route(async (req) => {
  const blocked = checkOrigin(req);
  if (blocked) return blocked;
  const auth = await requireTenant(req, "settings:edit");
  if (!auth.ok) return auth.response;
  const body = await readJson(req, schema);
  if (!body.ok) return body.response;
  const { tenantId } = auth.ctx;
  const res = await withTenant(tenantId, async (db) => {
    if (body.data.action === "load") {
      const ok = await loadDemo(db, tenantId);
      if (ok) await db.query("INSERT INTO audit_log (tenant_id, actor_id, action, target_type) VALUES ($1,$2,'demo.load','tenant')", [tenantId, auth.session.userId]);
      return ok ? ("ok" as const) : ("ya" as const);
    }
    const n = await clearDemo(db, tenantId);
    await db.query("INSERT INTO audit_log (tenant_id, actor_id, action, target_type, metadata) VALUES ($1,$2,'demo.clear','tenant',$3::jsonb)", [tenantId, auth.session.userId, JSON.stringify(n)]);
    return "ok" as const;
  });
  if (res === "ya") return errorResponse(409, "ya_hay_ejemplos", "Ya tienes datos de ejemplo. Bórralos primero si quieres cargarlos de nuevo.");
  return jsonResponse({ ok: true });
}, { limit: "dataTransfer" });
