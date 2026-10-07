import { getPool } from "@/lib/db";
import { checkOrigin, errorResponse, jsonResponse, readJson, route } from "@/lib/auth/http";
import { burnPasswordCheck, verifyPassword } from "@/lib/auth/password";
import { startSession } from "@/lib/auth/session";
import { loginSchema } from "@/lib/auth/validation";

const GENERIC = "Correo o contraseña incorrectos, o la cuenta está bloqueada temporalmente.";

export const POST = route(async (req) => {
  const blocked = checkOrigin(req);
  if (blocked) return blocked;
  const body = await readJson(req, loginSchema);
  if (!body.ok) return body.response;
  const { email, password } = body.data;

  const pool = getPool();
  const found = await pool.query<{
    uid: string;
    pw_hash: string;
    user_status: string;
    lock_until: Date | null;
  }>("SELECT * FROM auth_get_login($1)", [email]);
  const user = found.rows[0];

  const locked = !!user?.lock_until && user.lock_until.getTime() > Date.now();
  const usable = !!user && user.user_status === "active" && !locked;

  // Siempre se hace una verificación de contraseña, exista o no el usuario,
  // para que el tiempo de respuesta no delate qué correos están registrados.
  let valid = false;
  if (usable) valid = await verifyPassword(user.pw_hash, password);
  else await burnPasswordCheck(password);

  if (!valid) {
    if (usable) await pool.query("SELECT auth_login_failed($1)", [user.uid]);
    // Mismo mensaje en todos los casos: no se revela si el correo existe.
    return errorResponse(401, "credenciales_invalidas", GENERIC);
  }

  await pool.query("SELECT auth_login_ok($1)", [user.uid]);
  const { setCookie } = await startSession(user.uid, req);
  return jsonResponse({ ok: true }, 200, { "Set-Cookie": setCookie });
});
