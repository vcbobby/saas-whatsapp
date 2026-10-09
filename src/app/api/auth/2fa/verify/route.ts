import { checkOrigin, errorResponse, jsonResponse, readJson, route } from "@/lib/auth/http";
import { isRecoveryShape } from "@/lib/auth/mfa";
import { completeWithRecovery, completeWithTotp, getPendingLogin } from "@/lib/auth/mfa-login";
import { mfaVerifySchema } from "@/lib/auth/validation";

export const POST = route(async (req) => {
  const blocked = checkOrigin(req);
  if (blocked) return blocked;
  const body = await readJson(req, mfaVerifySchema);
  if (!body.ok) return body.response;

  const pending = await getPendingLogin(req);
  if (!pending) {
    return errorResponse(401, "sesion_expirada", "Tu inicio de sesión venció. Vuelve a entrar.");
  }

  let outcome;
  if ("code" in body.data) {
    outcome = await completeWithTotp(req, pending, body.data.code);
  } else if (isRecoveryShape(body.data.recoveryCode)) {
    outcome = await completeWithRecovery(req, pending, body.data.recoveryCode);
  } else {
    return errorResponse(401, "codigo_invalido", "Código incorrecto.");
  }

  if (!outcome.ok) {
    if (outcome.locked || (pending.stored.lockedUntil && pending.stored.lockedUntil.getTime() > Date.now())) {
      return errorResponse(429, "bloqueado", "Demasiados intentos. Espera 15 minutos y vuelve a entrar.");
    }
    return errorResponse(401, "codigo_invalido", "Código incorrecto.");
  }
  return jsonResponse({ ok: true, codesLeft: outcome.codesLeft }, 200, {
    "Set-Cookie": outcome.setCookie,
  });
});
