import { getPool } from "@/lib/db";
import { checkOrigin, jsonResponse, readJson, route } from "@/lib/auth/http";
import { requireSuperAdmin } from "@/lib/auth/guard";
import { impersonationSchema } from "@/lib/auth/validation";

export const POST = route(async (req) => {
  const blocked = checkOrigin(req);
  if (blocked) return blocked;
  const auth = await requireSuperAdmin(req);
  if (!auth.ok) return auth.response;
  const body = await readJson(req, impersonationSchema);
  if (!body.ok) return body.response;
  const r = await getPool().query<{ until: Date }>(
    "SELECT admin_start_impersonation($1, $2, $3) AS until",
    [auth.tokenHash, body.data.tenantId, body.data.reason],
  );
  return jsonResponse({ ok: true, until: r.rows[0]!.until });
});

export const DELETE = route(async (req) => {
  const blocked = checkOrigin(req);
  if (blocked) return blocked;
  const auth = await requireSuperAdmin(req);
  if (!auth.ok) return auth.response;
  await getPool().query("SELECT admin_stop_impersonation($1)", [auth.tokenHash]);
  return jsonResponse({ ok: true });
});
