import { getPool } from "@/lib/db";
import { requireSession } from "@/lib/auth/guard";
import { checkOrigin, errorResponse, jsonResponse, readJson, route } from "@/lib/auth/http";
import { tokenHashOf } from "@/lib/auth/session";
import { hashToken } from "@/lib/auth/tokens";
import { inviteTokenSchema } from "@/lib/auth/validation";

/** Aceptar una invitación con una cuenta que ya existe (debe ser la del correo invitado). */
export const POST = route(async (req) => {
  const blocked = checkOrigin(req);
  if (blocked) return blocked;
  const auth = await requireSession(req);
  if (!auth.ok) return auth.response;
  const body = await readJson(req, inviteTokenSchema);
  if (!body.ok) return body.response;
  try {
    await getPool().query("SELECT invite_accept($1, $2)", [
      tokenHashOf(req)!, hashToken(body.data.token),
    ]);
  } catch (err) {
    const e = err as { code?: string };
    if (e.code === "P0002" || e.code === "42501") {
      return errorResponse(404, "invitacion_invalida", "La invitación no es válida, venció o es de otro correo.");
    }
    throw err;
  }
  return jsonResponse({ ok: true });
});
