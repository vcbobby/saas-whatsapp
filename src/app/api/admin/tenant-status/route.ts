import { getPool } from "@/lib/db";
import { checkOrigin, jsonResponse, readJson, route } from "@/lib/auth/http";
import { requireSuperAdmin } from "@/lib/auth/guard";
import { tenantStatusSchema } from "@/lib/auth/validation";

export const POST = route(async (req) => {
  const blocked = checkOrigin(req);
  if (blocked) return blocked;
  const auth = await requireSuperAdmin(req);
  if (!auth.ok) return auth.response;
  const body = await readJson(req, tenantStatusSchema);
  if (!body.ok) return body.response;
  await getPool().query("SELECT admin_set_tenant_status($1, $2, $3)", [
    auth.tokenHash,
    body.data.tenantId,
    body.data.status,
  ]);
  return jsonResponse({ ok: true });
});
