import { z } from "zod";
import { checkOrigin, jsonResponse, readJson, route } from "@/lib/auth/http";
import { emailSchema } from "@/lib/auth/validation";
import { sendPasswordResetEmail } from "@/lib/email/flows";

const schema = z.object({ email: emailSchema });

/** «¿Olvidaste tu contraseña?»: SIEMPRE responde igual, exista o no el correo (así no se puede averiguar quién tiene cuenta). */
export const POST = route(async (req) => {
  const blocked = checkOrigin(req);
  if (blocked) return blocked;
  const body = await readJson(req, schema);
  if (!body.ok) return body.response;
  await sendPasswordResetEmail(body.data.email);
  return jsonResponse({ ok: true, message: "Si ese correo tiene una cuenta, te enviamos un enlace para cambiar la contraseña. Revisa también la carpeta de spam." });
}, { limit: "recover" });
