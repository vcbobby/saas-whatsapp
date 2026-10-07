import { checkOrigin, jsonResponse, route } from "@/lib/auth/http";
import { clearCookie, endSession } from "@/lib/auth/session";

export const POST = route(async (req) => {
  const blocked = checkOrigin(req);
  if (blocked) return blocked;
  await endSession(req);
  return jsonResponse({ ok: true }, 200, { "Set-Cookie": clearCookie() });
});
