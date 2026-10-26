import { z } from "zod";
import { requireTenant } from "@/lib/auth/guard";
import { checkOrigin, errorResponse, jsonResponse, readJson, route } from "@/lib/auth/http";
import { TELEGRAM_TOKEN_RE } from "@/lib/connections/apps";
import { findTelegramChats } from "@/lib/connections/telegram";

const schema = z.object({ token: z.string().trim().max(200) });

/** Paso del asistente de Telegram: con el token del bot, busca los chats que le han escrito (para no pedir el «chat id» a mano). */
export const POST = route(async (req) => {
  const blocked = checkOrigin(req);
  if (blocked) return blocked;
  const auth = await requireTenant(req, "integrations:manage", "automatizaciones");
  if (!auth.ok) return auth.response;
  const body = await readJson(req, schema);
  if (!body.ok) return body.response;
  if (!TELEGRAM_TOKEN_RE.test(body.data.token)) return errorResponse(422, "token_no_valido", "Ese token no parece de un bot de Telegram. Cópialo completo desde @BotFather (tiene dos puntos en medio).", { fields: ["token"] });
  const r = await findTelegramChats(body.data.token);
  if (!r.ok) return errorResponse(r.status, r.code, r.message);
  return jsonResponse({ bot: r.bot, chats: r.chats });
});
