import { z } from "zod";
import { getPool } from "@/lib/db";
import { checkOrigin, errorResponse, jsonResponse, readJson, route } from "@/lib/auth/http";
import { hashPassword } from "@/lib/auth/password";
import { hashToken, isWellFormedToken } from "@/lib/auth/tokens";
import { passwordSchema } from "@/lib/auth/validation";
import { sendPasswordChangedEmail } from "@/lib/email/flows";

const schema = z.object({ token: z.string().max(100), password: passwordSchema });
const INVALID = "Este enlace ya no sirve (venció o ya se usó). Pide uno nuevo en «¿Olvidaste tu contraseña?».";

/** Cambia la contraseña con el enlace del correo. Un solo uso; cierra TODAS las sesiones de la cuenta. */
export const POST = route(async (req) => {
  const blocked = checkOrigin(req);
  if (blocked) return blocked;
  const body = await readJson(req, schema);
  if (!body.ok) return body.response;
  const { token, password } = body.data;
  if (!isWellFormedToken(token)) return errorResponse(400, "enlace_invalido", INVALID);
  const hash = hashToken(token);
  const pool = getPool();
  const email = (await pool.query<{ email: string | null }>("SELECT auth_reset_peek($1) AS email", [hash])).rows[0]?.email;
  if (!email) return errorResponse(400, "enlace_invalido", INVALID);
  const local = email.split("@")[0] ?? "";
  if (local.length >= 4 && password.toLowerCase().includes(local)) return errorResponse(400, "datos_invalidos", "La contraseña no puede contener tu correo.", { fields: ["password"] });
  const done = (await pool.query<{ email: string | null }>("SELECT auth_reset_password($1, $2) AS email", [hash, await hashPassword(password)])).rows[0]?.email;
  if (!done) return errorResponse(400, "enlace_invalido", INVALID);
  await sendPasswordChangedEmail(done);
  return jsonResponse({ ok: true });
}, { limit: "password" });
