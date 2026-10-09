import { getPool } from "@/lib/db";
import { requireSession } from "@/lib/auth/guard";
import { checkOrigin, errorResponse, jsonResponse, readJson, route } from "@/lib/auth/http";
import { reauthenticate } from "@/lib/auth/reauth";
import { tokenHashOf } from "@/lib/auth/session";
import { mfaSensitiveSchema } from "@/lib/auth/validation";

export const POST = route(async (req) => {
  const blocked = checkOrigin(req);
  if (blocked) return blocked;
  const auth = await requireSession(req);
  if (!auth.ok) return auth.response;
  if (auth.session.isSuperAdmin) {
    return errorResponse(403, "obligatorio", "El súper admin no puede desactivar el 2FA.");
  }
  const body = await readJson(req, mfaSensitiveSchema);
  if (!body.ok) return body.response;
  const tokenHash = tokenHashOf(req)!;

  const re = await reauthenticate(auth.session, tokenHash, body.data);
  if (!re.ok) return re.response;
  const r = await getPool().query<{ mfa_disable: boolean }>("SELECT mfa_disable($1, $2)", [
    tokenHash,
    re.step,
  ]);
  if (!r.rows[0]?.mfa_disable) {
    return errorResponse(401, "verificacion_fallida", "Contraseña o código incorrectos.");
  }
  return jsonResponse({ ok: true });
});
