import { requireSession } from "@/lib/auth/guard";
import { checkOrigin, jsonResponse, route } from "@/lib/auth/http";
import { sendVerificationEmail } from "@/lib/email/flows";

/** Reenvía el correo de verificación a quien tiene la sesión abierta. */
export const POST = route(async (req) => {
  const blocked = checkOrigin(req);
  if (blocked) return blocked;
  const auth = await requireSession(req);
  if (!auth.ok) return auth.response;
  const sent = await sendVerificationEmail(auth.session.userId);
  return jsonResponse({ ok: true, sent, message: sent ? "Listo: te enviamos un correo nuevo. Revisa también spam." : "No se envió: tu correo ya está confirmado o pediste demasiados enlaces. Intenta en una hora." });
}, { limit: "verifyEmail" });
