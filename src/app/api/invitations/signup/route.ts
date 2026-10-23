import { getPool } from "@/lib/db";
import { checkOrigin, errorResponse, jsonResponse, readJson, route } from "@/lib/auth/http";
import { hashPassword } from "@/lib/auth/password";
import { startSession } from "@/lib/auth/session";
import { hashToken } from "@/lib/auth/tokens";
import { inviteSignupSchema } from "@/lib/auth/validation";
import { CONSENT_REQUIRED_MESSAGE, consentVersionFor } from "@/lib/legal/consent";

/** Crea la cuenta de una persona invitada. El correo sale de la invitación. */
export const POST = route(async (req) => {
  const blocked = checkOrigin(req);
  if (blocked) return blocked;
  const body = await readJson(req, inviteSignupSchema);
  if (!body.ok) return body.response;

  const version = consentVersionFor(body.data.acceptTerms);
  if (version === "missing") return errorResponse(400, "debes_aceptar_terminos", CONSENT_REQUIRED_MESSAGE);

  const passwordHash = await hashPassword(body.data.password);
  try {
    const r = await getPool().query<{ invite_signup_consent: string }>(
      "SELECT invite_signup_consent($1, $2, $3)",
      [hashToken(body.data.token), passwordHash, version],
    );
    const { setCookie } = await startSession(r.rows[0]!.invite_signup_consent, req);
    return jsonResponse({ ok: true }, 201, { "Set-Cookie": setCookie });
  } catch (err) {
    const e = err as { code?: string };
    if (e.code === "23505") {
      return errorResponse(409, "ya_tiene_cuenta", "Ese correo ya tiene cuenta. Inicia sesión para aceptar la invitación.");
    }
    if (e.code === "P0002") {
      return errorResponse(404, "invitacion_invalida", "La invitación no es válida o ya venció.");
    }
    throw err;
  }
}, { limit: "invite" });
