import { z } from "zod";
import { getPool } from "@/lib/db";
import { checkOrigin, errorResponse, jsonResponse, readJson, route } from "@/lib/auth/http";
import { hashToken, isWellFormedToken } from "@/lib/auth/tokens";

const schema = z.object({ token: z.string().max(100) });

/** Confirma el correo con el enlace que llegó por correo (un solo uso, vale 48 h). */
export const POST = route(async (req) => {
  const blocked = checkOrigin(req);
  if (blocked) return blocked;
  const body = await readJson(req, schema);
  if (!body.ok) return body.response;
  const ok = isWellFormedToken(body.data.token) && (await getPool().query<{ ok: boolean }>("SELECT auth_verify_email($1) AS ok", [hashToken(body.data.token)])).rows[0]?.ok === true;
  if (!ok) return errorResponse(400, "enlace_invalido", "Este enlace ya no sirve (venció o ya se usó). Entra a tu cuenta y pide uno nuevo.");
  return jsonResponse({ ok: true });
}, { limit: "verifyEmail" });
