import { z } from "zod";
import { getPool } from "@/lib/db";
import { requireSession } from "@/lib/auth/guard";
import { checkOrigin, errorResponse, jsonResponse, readJson, route } from "@/lib/auth/http";
import { hashPassword, verifyPassword } from "@/lib/auth/password";
import { tokenHashOf } from "@/lib/auth/session";
import { reauthenticate } from "@/lib/auth/reauth";
import { passwordSchema, totpCodeSchema } from "@/lib/auth/validation";

const schema = z.object({ currentPassword: z.string().min(1).max(128), newPassword: passwordSchema, code: totpCodeSchema.optional() });

/**
 * Cambia la contraseña de quien tiene la sesión abierta: pide la actual y cierra las sesiones de otros dispositivos.
 * Con la verificación en dos pasos activa, pide además un código válido (así una sesión robada no basta para quedarse con la cuenta).
 */
export const POST = route(async (req) => {
  const blocked = checkOrigin(req);
  if (blocked) return blocked;
  const auth = await requireSession(req);
  if (!auth.ok) return auth.response;
  const body = await readJson(req, schema);
  if (!body.ok) return body.response;
  const { currentPassword, newPassword } = body.data;
  const tokenHash = tokenHashOf(req);
  if (!tokenHash) return errorResponse(401, "no_autenticado", "Inicia sesión.");

  if (newPassword === currentPassword) return errorResponse(400, "datos_invalidos", "La contraseña nueva debe ser distinta de la actual.", { fields: ["newPassword"] });
  const local = auth.session.email.split("@")[0] ?? "";
  if (local.length >= 4 && newPassword.toLowerCase().includes(local)) return errorResponse(400, "datos_invalidos", "La contraseña no puede contener tu correo.", { fields: ["newPassword"] });

  const pool = getPool();

  if (auth.session.mfaEnabled) {
    if (!body.data.code) return errorResponse(400, "codigo_requerido", "Escribe el código de 6 dígitos de tu app de verificación.", { fields: ["code"] });
    const re = await reauthenticate(auth.session, tokenHash, { password: currentPassword, code: body.data.code });
    if (!re.ok) return re.response;
    const r = await pool.query<{ n: number }>("SELECT auth_change_password_mfa($1, $2, $3) AS n", [tokenHash, await hashPassword(newPassword), re.step]);
    const n = Number(r.rows[0]?.n ?? -1);
    if (n < 0) return errorResponse(401, "verificacion_fallida", "Contraseña o código incorrectos.");
    return jsonResponse({ ok: true, otherSessionsClosed: n });
  }

  const found = await pool.query<{ uid: string; pw_hash: string; lock_until: Date | null }>("SELECT uid, pw_hash, lock_until FROM auth_get_login($1)", [auth.session.email]);
  const user = found.rows[0];
  if (!user || (user.lock_until && user.lock_until.getTime() > Date.now())) return errorResponse(429, "bloqueada", "Demasiados intentos. Espera unos minutos e inténtalo de nuevo.");
  if (!(await verifyPassword(user.pw_hash, currentPassword))) {
    await pool.query("SELECT auth_login_failed($1)", [user.uid]); // los intentos fallidos aquí también cuentan para el bloqueo
    return errorResponse(401, "credenciales_invalidas", "La contraseña actual no es correcta.");
  }
  const r = await pool.query<{ closed: number }>("SELECT auth_change_password($1, $2) AS closed", [tokenHash, await hashPassword(newPassword)]);
  return jsonResponse({ ok: true, otherSessionsClosed: Number(r.rows[0]?.closed ?? 0) });
}, { limit: "password" });
