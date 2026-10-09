import { brand } from "@/config/brand";
import { getPool } from "@/lib/db";
import { requireSession } from "@/lib/auth/guard";
import { checkOrigin, errorResponse, jsonResponse, route } from "@/lib/auth/http";
import { qrDataUrl, sealSecret } from "@/lib/auth/mfa";
import { tokenHashOf } from "@/lib/auth/session";
import { newTotpSecret, otpauthUrl } from "@/lib/auth/totp";

export const POST = route(async (req) => {
  const blocked = checkOrigin(req);
  if (blocked) return blocked;
  const auth = await requireSession(req);
  if (!auth.ok) return auth.response;
  const tokenHash = tokenHashOf(req)!;

  const secret = newTotpSecret();
  const { payload, keyVersion } = sealSecret(secret, auth.session.userId);
  const r = await getPool().query<{ mfa_setup_start: boolean }>(
    "SELECT mfa_setup_start($1, $2, $3)",
    [tokenHash, payload, keyVersion],
  );
  if (!r.rows[0]?.mfa_setup_start) {
    return errorResponse(409, "ya_activo", "La verificación en dos pasos ya está activa.");
  }
  const url = otpauthUrl(secret, auth.session.email, brand.name);
  return jsonResponse({ secret, qr: await qrDataUrl(url) });
});
