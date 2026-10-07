import { checkOrigin, jsonResponse, route } from "@/lib/auth/http";
import { requireSession } from "@/lib/auth/guard";
import { clearCookie, endAllSessions } from "@/lib/auth/session";

export const POST = route(async (req) => {
  const blocked = checkOrigin(req);
  if (blocked) return blocked;
  const auth = await requireSession(req);
  if (!auth.ok) return auth.response;
  await endAllSessions(req);
  return jsonResponse({ ok: true }, 200, { "Set-Cookie": clearCookie() });
});
