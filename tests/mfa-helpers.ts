import type { Pool } from "pg";
import { sealSecret } from "@/lib/auth/mfa";
import { hotp, newTotpSecret, stepAt } from "@/lib/auth/totp";

/** Activa el 2FA directamente en la base (para tests). Devuelve el secreto en claro. */
export async function enableMfaDirect(owner: Pool, userId: string): Promise<string> {
  const secret = newTotpSecret();
  const { payload, keyVersion } = sealSecret(secret, userId);
  await owner.query(
    `INSERT INTO user_mfa (user_id, secret_enc, key_version, enabled_at, last_step)
     VALUES ($1, $2, $3, now(), 0)
     ON CONFLICT (user_id) DO UPDATE SET secret_enc = $2, key_version = $3, enabled_at = now(), last_step = 0`,
    [userId, payload, keyVersion],
  );
  return secret;
}

/** Código TOTP del paso actual + offset (±1 lo acepta el servidor). */
export function codeFor(secret: string, offsetSteps = 0): string {
  return hotp(secret, stepAt(Date.now()) + offsetSteps);
}
