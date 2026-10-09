import { getPool } from "@/lib/db";
import { buildSessionCookie } from "./cookies";
import { checkCode, hashRecovery, type StoredSecret } from "./mfa";
import { tokenHashOf } from "./session";
import { newSessionToken } from "./tokens";

export interface PendingLogin {
  tokenHash: Buffer;
  userId: string;
  stored: StoredSecret;
}

/** Sesión que ya puso la contraseña y está esperando el código 2FA. */
export async function getPendingLogin(req: Request): Promise<PendingLogin | null> {
  const tokenHash = tokenHashOf(req);
  if (!tokenHash) return null;
  const r = await getPool().query("SELECT * FROM mfa_get_pending($1)", [tokenHash]);
  const row = r.rows[0];
  if (!row) return null;
  return {
    tokenHash,
    userId: row.p_user_id,
    stored: {
      secretEnc: row.p_secret_enc,
      keyVersion: row.p_key_version,
      lastStep: Number(row.p_last_step),
      lockedUntil: row.p_locked_until,
      enabled: true,
    },
  };
}

export type MfaOutcome =
  | { ok: true; setCookie: string; codesLeft?: number }
  | { ok: false; locked: boolean };

/** Verifica un código TOTP y, si es válido, cambia la sesión pendiente por una completa NUEVA. */
export async function completeWithTotp(req: Request, p: PendingLogin, code: string): Promise<MfaOutcome> {
  const pool = getPool();
  const step = checkCode(p.userId, p.stored, code);
  if (step !== null) {
    const { token, hash } = newSessionToken();
    const r = await pool.query<{ mfa_complete: number | null }>(
      "SELECT mfa_complete($1, $2, $3, $4)",
      [p.tokenHash, step, hash, req.headers.get("user-agent") ?? ""],
    );
    const age = r.rows[0]?.mfa_complete;
    if (age) return { ok: true, setCookie: buildSessionCookie(token, age) };
  }
  const f = await pool.query<{ mfa_fail: boolean }>("SELECT mfa_fail($1)", [p.tokenHash]);
  return { ok: false, locked: !!f.rows[0]?.mfa_fail };
}

export async function completeWithRecovery(req: Request, p: PendingLogin, code: string): Promise<MfaOutcome> {
  if (p.stored.lockedUntil && p.stored.lockedUntil.getTime() > Date.now()) {
    return { ok: false, locked: true };
  }
  const { token, hash } = newSessionToken();
  const r = await getPool().query<{ max_age_seconds: number; codes_left: number }>(
    "SELECT * FROM mfa_complete_recovery($1, $2, $3, $4)",
    [p.tokenHash, hashRecovery(code), hash, req.headers.get("user-agent") ?? ""],
  );
  const row = r.rows[0];
  if (!row) return { ok: false, locked: false };
  return { ok: true, setCookie: buildSessionCookie(token, row.max_age_seconds), codesLeft: row.codes_left };
}
