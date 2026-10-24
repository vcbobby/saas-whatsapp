import { checkOrigin, readJson, route } from "@/lib/auth/http";
import { buildExport } from "@/lib/privacy/export";
import { confirmIdentity, confirmSchema, requireOwner } from "@/lib/privacy/guard";
import { withTenant } from "@/lib/db";

/** Descarga de TODOS los datos del negocio (archivo JSON). Solo la persona dueña, con contraseña (y código si usa 2 pasos). */
export const POST = route(async (req) => {
  const blocked = checkOrigin(req);
  if (blocked) return blocked;
  const owner = await requireOwner(req);
  if (!owner.ok) return owner.response;
  const body = await readJson(req, confirmSchema);
  if (!body.ok) return body.response;
  const denied = await confirmIdentity(owner.session, owner.tokenHash, body.data);
  if (denied) return denied;

  const file = await buildExport(owner.tenantId, owner.session.userId);
  await withTenant(owner.tenantId, (db) =>
    db.query("INSERT INTO audit_log (tenant_id, actor_id, action, target_type, target_id) VALUES ($1::uuid, $2, 'tenant.exported', 'tenant', $1::text)", [owner.tenantId, owner.session.userId]),
  );
  const day = file.generatedAt.slice(0, 10);
  return new Response(JSON.stringify(file), {
    status: 200,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "content-disposition": `attachment; filename="mis-datos-${day}.json"`,
      "cache-control": "no-store",
    },
  });
}, { limit: "privacy" });
