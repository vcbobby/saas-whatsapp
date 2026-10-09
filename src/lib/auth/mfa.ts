import { createHash, randomBytes } from "node:crypto";
import QRCode from "qrcode";
import { decryptSecret, encryptSecret } from "@/lib/crypto";
import { getPool } from "@/lib/db";
import { verifyTotp } from "./totp";

// El secreto cifrado queda atado al usuario (AAD): copiarlo a otra cuenta no sirve.
const aadFor = (userId: string) => `mfa:${userId}`;

export function sealSecret(secretB32: string, userId: string) {
  return encryptSecret(secretB32, aadFor(userId));
}

export function openSecret(payload: string, userId: string, keyVersion: number): string {
  return decryptSecret(payload, aadFor(userId), keyVersion);
}

export async function qrDataUrl(otpauth: string): Promise<string> {
  return QRCode.toDataURL(otpauth, { margin: 1, width: 220, errorCorrectionLevel: "M" });
}

// ------------------------------------------------------- códigos de recuperación
// 15 caracteres de un alfabeto sin 0/O/1/I = 75 bits. Formato XXXXX-XXXXX-XXXXX.
const RECOVERY_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export function newRecoveryCodes(count = 10): string[] {
  return Array.from({ length: count }, () => {
    const bytes = randomBytes(15);
    const chars = Array.from(bytes, (b) => RECOVERY_ALPHABET[b % RECOVERY_ALPHABET.length]).join("");
    return `${chars.slice(0, 5)}-${chars.slice(5, 10)}-${chars.slice(10, 15)}`;
  });
}

export function normalizeRecovery(code: string): string {
  return code.replace(/[\s-]/g, "").toUpperCase();
}

export function hashRecovery(code: string): Buffer {
  return createHash("sha256").update(normalizeRecovery(code)).digest();
}

export function isRecoveryShape(code: string): boolean {
  return /^[A-Z2-9]{15}$/.test(normalizeRecovery(code)) && !/[IO01]/.test(normalizeRecovery(code));
}

// ------------------------------------------------------- verificación con la base
export interface StoredSecret {
  secretEnc: string;
  keyVersion: number;
  lastStep: number;
  lockedUntil: Date | null;
  enabled: boolean;
}

export async function getOwnSecret(tokenHash: Buffer): Promise<StoredSecret | null> {
  const r = await getPool().query("SELECT * FROM mfa_get_secret($1)", [tokenHash]);
  const row = r.rows[0];
  if (!row) return null;
  return {
    secretEnc: row.g_secret_enc,
    keyVersion: row.g_key_version,
    lastStep: Number(row.g_last_step),
    lockedUntil: row.g_locked_until,
    enabled: row.g_enabled,
  };
}

/**
 * Comprueba un código TOTP contra el secreto guardado.
 * Devuelve el paso válido, o null (código malo, repetido o cuenta bloqueada).
 */
export function checkCode(
  userId: string,
  stored: Pick<StoredSecret, "secretEnc" | "keyVersion" | "lastStep" | "lockedUntil">,
  code: string,
): number | null {
  if (stored.lockedUntil && stored.lockedUntil.getTime() > Date.now()) return null;
  const secret = openSecret(stored.secretEnc, userId, stored.keyVersion);
  const step = verifyTotp(secret, code, Date.now());
  if (step === null || step <= stored.lastStep) return null;
  return step;
}
