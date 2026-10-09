import { getPool } from "@/lib/db";
import { requireSession } from "@/lib/auth/guard";
import { checkOrigin, errorResponse, jsonResponse, readJson, route } from "@/lib/auth/http";
import { hashRecovery, newRecoveryCodes } from "@/lib/auth/mfa";
import { reauthenticate } from "@/lib/auth/reauth";
import { tokenHashOf } from "@/lib/auth/session";
import { mfaSensitiveSchema } from "@/lib/auth/validation";

/** Genera 10 códigos de recuperación nuevos; los anteriores dejan de servir. */
export const POST = route(async (req) => {
  const blocked = checkOrigin(req);
  if (blocked) return blocked;
  const auth = await requireSession(req);
  if (!auth.ok) return auth.response;
  const body = await readJson(req, mfaSensitiveSchema);
  if (!body.ok) return body.response;
  const tokenHash = tokenHashOf(req)!;

  const re = await reauthenticate(auth.session, tokenHash, body.data);
  if (!re.ok) return re.response;
  const codes = newRecoveryCodes(10);
  const r = await getPool().query<{ mfa_regenerate_codes: boolean }>(
    "SELECT mfa_regenerate_codes($1, $2, $3)",
    [tokenHash, re.step, codes.map(hashRecovery)],
  );
  if (!r.rows[0]?.mfa_regenerate_codes) {
    return errorResponse(401, "verificacion_fallida", "Contraseña o código incorrectos.");
  }
  return jsonResponse({ ok: true, recoveryCodes: codes });
});
