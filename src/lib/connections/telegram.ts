import { ipv4Fetch } from "@/lib/ai/provider";

export interface TelegramChat { id: string; title: string }
export type TelegramLookup = { ok: true; bot: string; chats: TelegramChat[] } | { ok: false; status: 422 | 502; code: string; message: string };

type FetchLike = typeof ipv4Fetch;

/** Pregunta a Telegram quién es el bot (getMe) y qué chats le han escrito (getUpdates). Solo habla con api.telegram.org. */
export async function findTelegramChats(token: string, fetchImpl: FetchLike = ipv4Fetch): Promise<TelegramLookup> {
  const call = async (method: string) => {
    const res = await fetchImpl(`https://api.telegram.org/bot${token}/${method}`, { method: "GET", headers: { accept: "application/json" } });
    const json = (await res.json().catch(() => null)) as { ok?: boolean; result?: unknown } | null;
    return { status: res.status, json };
  };
  let me: Awaited<ReturnType<typeof call>>;
  try { me = await call("getMe"); } catch { return { ok: false, status: 502, code: "telegram_no_responde", message: "No se pudo hablar con Telegram. Intenta de nuevo en un momento." }; }
  if (me.status === 401 || me.status === 404 || !me.json?.ok) return { ok: false, status: 422, code: "token_rechazado", message: "Telegram no reconoce ese token. Revisa que lo copiaste completo desde @BotFather." };
  const bot = String((me.json.result as { username?: string } | undefined)?.username ?? "tu bot");
  let up: Awaited<ReturnType<typeof call>>;
  try { up = await call("getUpdates"); } catch { return { ok: false, status: 502, code: "telegram_no_responde", message: "No se pudo hablar con Telegram. Intenta de nuevo en un momento." }; }
  if (up.status === 409) return { ok: false, status: 422, code: "bot_en_uso", message: "Ese bot ya está conectado a otro programa (webhook activo). Crea un bot nuevo con @BotFather para esta conexión." };
  const chats = new Map<string, string>();
  const list = Array.isArray(up.json?.result) ? (up.json!.result as unknown[]) : [];
  for (const u of list) {
    const m = (u as { message?: { chat?: { id?: number; type?: string; title?: string; first_name?: string; last_name?: string; username?: string } }; channel_post?: { chat?: { id?: number; title?: string } }; my_chat_member?: { chat?: { id?: number; title?: string } } }) ?? {};
    const c = m.message?.chat ?? m.channel_post?.chat ?? m.my_chat_member?.chat;
    if (!c || typeof c.id !== "number") continue;
    const full = c as { title?: string; first_name?: string; last_name?: string; username?: string; type?: string };
    const name = full.title || [full.first_name, full.last_name].filter(Boolean).join(" ") || (full.username ? `@${full.username}` : "Chat");
    chats.set(String(c.id), `${name.slice(0, 60)}${full.type && full.type !== "private" ? " (grupo)" : ""}`);
  }
  return { ok: true, bot, chats: [...chats].slice(0, 10).map(([id, title]) => ({ id, title })) };
}
