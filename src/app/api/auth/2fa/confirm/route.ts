import { getPool } from "@/lib/db";
import { requireSession } from "@/lib/auth/guard";
import { checkOrigin, errorResponse, jsonResponse, readJson, route } from "@/lib/auth/http";
import { checkCode, getOwnSecret, hashRecovery, newRecoveryCodes } from "@/lib/auth/mfa";
import { tokenHashOf } from "@/lib/auth/session";
import { mfaConfirmSchema } from "@/lib/auth/validation";

export const POST = route(async (req) => {
  const blocked = checkOrigin(req);
  if (blocked) return blocked;
  const auth = await requireSession(req);
  if (!auth.ok) return auth.response;
  const body = await readJson(req, mfaConfirmSchema);
  if (!body.ok) return body.response;
  const tokenHash = tokenHashOf(req)!;
  const pool = getPool();

  const stored = await getOwnSecret(tokenHash);
  if (!stored || stored.enabled) {
    return errorResponse(409, "sin_configuracion", "Empieza la configuración de nuevo.");
  }
  if (stored.lockedUntil && stored.lockedUntil.getTime() > Date.now()) {
    return errorResponse(429, "bloqueado", "Demasiados intentos. Espera unos minutos.");
  }
  const step = checkCode(auth.session.userId, stored, body.data.code);
  if (step === null) {
    await pool.query("SELECT mfa_fail($1)", [tokenHash]);
    return errorResponse(401, "codigo_invalido", "Código incorrecto. Revisa la hora de tu teléfono.");
  }

  const codes = newRecoveryCodes(10);
  const r = await pool.query<{ mfa_setup_enable: boolean }>(
    "SELECT mfa_setup_enable($1, $2, $3)",
    [tokenHash, step, codes.map(hashRecovery)],
  );
  if (!r.rows[0]?.mfa_setup_enable) {
    return errorResponse(409, "sin_configuracion", "Empieza la configuración de nuevo.");
  }
  // Los códigos se muestran UNA sola vez: en la base solo queda su hash.
  return jsonResponse({ ok: true, recoveryCodes: codes });
});
