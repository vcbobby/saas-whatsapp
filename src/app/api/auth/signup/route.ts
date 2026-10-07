import { randomBytes } from "node:crypto";
import { getPool } from "@/lib/db";
import { checkOrigin, errorResponse, jsonResponse, readJson, route } from "@/lib/auth/http";
import { hashPassword } from "@/lib/auth/password";
import { startSession } from "@/lib/auth/session";
import { makeSlug, signupSchema } from "@/lib/auth/validation";

export const POST = route(async (req) => {
  const blocked = checkOrigin(req);
  if (blocked) return blocked;
  const body = await readJson(req, signupSchema);
  if (!body.ok) return body.response;
  const { email, password, businessName } = body.data;

  const passwordHash = await hashPassword(password);

  for (let attempt = 0; attempt < 3; attempt++) {
    const slug = makeSlug(businessName, randomBytes(3).toString("hex"));
    try {
      const r = await getPool().query<{ new_user_id: string }>(
        "SELECT * FROM auth_signup($1, $2, $3, $4)",
        [email, passwordHash, businessName, slug],
      );
      const { setCookie } = await startSession(r.rows[0]!.new_user_id, req);
      return jsonResponse({ ok: true }, 201, { "Set-Cookie": setCookie });
    } catch (err) {
      const e = err as { code?: string; constraint?: string };
      if (e.code === "23505" && e.constraint === "users_email_key") {
        return errorResponse(409, "no_se_pudo_crear", "No se pudo crear la cuenta con esos datos.");
      }
      if (e.code === "23505" && e.constraint === "tenants_slug_key") continue; // otro sufijo
      throw err;
    }
  }
  return errorResponse(500, "error_interno", "Ocurrió un error. Intenta de nuevo.");
});
