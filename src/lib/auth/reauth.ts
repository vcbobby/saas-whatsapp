import { getPool } from "@/lib/db";
import { errorResponse } from "./http";
import { checkCode, getOwnSecret } from "./mfa";
import { verifyPassword } from "./password";
import type { Session } from "./session";

/**
 * Para acciones delicadas (apagar el 2FA, regenerar códigos): exige contraseña Y código.
 * Devuelve el paso TOTP válido o una respuesta de error lista para enviar.
 */
export async function reauthenticate(
  session: Session,
  tokenHash: Buffer,
  input: { password: string; code: string },
): Promise<{ ok: true; step: number } | { ok: false; response: Response }> {
  const pool = getPool();
  const bad = (msg: string, status = 401) => ({
    ok: false as const,
    response: errorResponse(status, "verificacion_fallida", msg),
  });

  const stored = await getOwnSecret(tokenHash);
  if (!stored || !stored.enabled) return bad("La verificación en dos pasos no está activa.", 409);
  if (stored.lockedUntil && stored.lockedUntil.getTime() > Date.now()) {
    return bad("Demasiados intentos. Espera unos minutos.", 429);
  }

  const found = await pool.query<{ uid: string; pw_hash: string }>(
    "SELECT uid, pw_hash FROM auth_get_login($1)",
    [session.email],
  );
  const user = found.rows[0];
  const passOk = !!user && (await verifyPassword(user.pw_hash, input.password));
  const step = checkCode(session.userId, stored, input.code);

  if (!passOk || step === null) {
    // Cuenta como fallo de 2FA (a los 5 se bloquea 15 minutos).
    await pool.query("SELECT mfa_fail($1)", [tokenHash]);
    return bad("Contraseña o código incorrectos.");
  }
  return { ok: true, step };
}
