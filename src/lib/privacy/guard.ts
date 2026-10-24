import { z } from "zod";
import { getPool } from "@/lib/db";
import { errorResponse } from "@/lib/auth/http";
import { requireSession } from "@/lib/auth/guard";
import { can } from "@/lib/auth/permissions";
import { checkCode, getOwnSecret } from "@/lib/auth/mfa";
import { verifyPassword } from "@/lib/auth/password";
import { effectiveTenant, tokenHashOf, type Session } from "@/lib/auth/session";

/** Contraseña (y código de 2 pasos si la persona lo tiene activado) para acciones sobre todos los datos. */
export const confirmSchema = z.object({
  password: z.string().min(1).max(128),
  code: z.string().min(1).max(20).optional(),
});
export type Confirm = z.infer<typeof confirmSchema>;

type Owner = { ok: true; session: Session; tenantId: string; tokenHash: Buffer } | { ok: false; response: Response };

/**
 * Solo el DUEÑO del negocio, con su propia sesión (nunca un súper admin «entrando como» el negocio).
 * A propósito no exige negocio activo ni módulos del plan: tener el negocio suspendido no quita el derecho a descargar o borrar.
 */
export async function requireOwner(req: Request): Promise<Owner> {
  const auth = await requireSession(req);
  if (!auth.ok) return auth;
  const ctx = effectiveTenant(auth.session);
  const tokenHash = tokenHashOf(req);
  if (!ctx || !tokenHash) return { ok: false, response: errorResponse(403, "sin_negocio", "No tienes acceso a un negocio.") };
  if (ctx.impersonating || !can(ctx.role, "tenant:delete")) {
    return { ok: false, response: errorResponse(403, "sin_permiso", "Solo la persona dueña del negocio puede hacer esto.") };
  }
  return { ok: true, session: auth.session, tenantId: ctx.tenantId, tokenHash };
}

/** Vuelve a pedir la contraseña (y el código, si hay 2 pasos). Los intentos fallidos cuentan para el bloqueo. */
export async function confirmIdentity(session: Session, tokenHash: Buffer, input: Confirm): Promise<Response | null> {
  const pool = getPool();
  const bad = (status = 401) => errorResponse(status, "verificacion_fallida", "Contraseña o código incorrectos.");
  const stored = await getOwnSecret(tokenHash);
  const mfa = !!stored?.enabled;
  if (mfa && stored!.lockedUntil && stored!.lockedUntil.getTime() > Date.now()) {
    return errorResponse(429, "bloqueada", "Demasiados intentos. Espera unos minutos.");
  }
  const found = await pool.query<{ uid: string; pw_hash: string; lock_until: Date | null }>("SELECT uid, pw_hash, lock_until FROM auth_get_login($1)", [session.email]);
  const user = found.rows[0];
  if (!user || (user.lock_until && user.lock_until.getTime() > Date.now())) {
    return errorResponse(429, "bloqueada", "Demasiados intentos. Espera unos minutos e inténtalo de nuevo.");
  }
  const passOk = await verifyPassword(user.pw_hash, input.password);
  let codeOk = true;
  if (mfa) codeOk = !!input.code && checkCode(session.userId, stored!, input.code) !== null;
  if (!passOk || !codeOk) {
    if (mfa) await pool.query("SELECT mfa_fail($1)", [tokenHash]);
    else await pool.query("SELECT auth_login_failed($1)", [user.uid]);
    return bad();
  }
  return null;
}
