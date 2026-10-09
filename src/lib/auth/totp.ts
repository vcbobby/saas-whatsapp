import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

// TOTP según RFC 6238 (el mismo que usan Google Authenticator, Authy, 1Password...).
const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
export const TOTP_PERIOD = 30;
const DIGITS = 6;

export function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(text: string): Buffer {
  const clean = text.toUpperCase().replace(/=+$/, "");
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const idx = ALPHABET.indexOf(ch);
    if (idx === -1) throw new Error("Base32 inválido");
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** Secreto nuevo de 160 bits (lo recomendado para HMAC-SHA1), en base32. */
export function newTotpSecret(): string {
  return base32Encode(randomBytes(20));
}

export function stepAt(ms: number): number {
  return Math.floor(ms / 1000 / TOTP_PERIOD);
}

export function hotp(secretB32: string, counter: number): string {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const mac = createHmac("sha1", base32Decode(secretB32)).update(msg).digest();
  const offset = mac[mac.length - 1]! & 0x0f;
  const bin =
    ((mac[offset]! & 0x7f) << 24) |
    (mac[offset + 1]! << 16) |
    (mac[offset + 2]! << 8) |
    mac[offset + 3]!;
  return String(bin % 10 ** DIGITS).padStart(DIGITS, "0");
}

export function totpAt(secretB32: string, ms: number): string {
  return hotp(secretB32, stepAt(ms));
}

/**
 * Comprueba un código admitiendo ±1 paso (±30 s) por desfase de relojes.
 * Devuelve el paso que coincidió (para impedir reutilizarlo) o null.
 * Revisa los 3 pasos siempre, sin cortar al primero que coincide.
 */
export function verifyTotp(secretB32: string, code: string, nowMs: number): number | null {
  const clean = code.replace(/\s/g, "");
  if (!/^\d{6}$/.test(clean)) return null;
  const current = stepAt(nowMs);
  const given = Buffer.from(clean);
  let matched: number | null = null;
  for (const step of [current - 1, current, current + 1]) {
    const expected = Buffer.from(hotp(secretB32, step));
    if (timingSafeEqual(expected, given) && (matched === null || step > matched)) matched = step;
  }
  return matched;
}

export function otpauthUrl(secretB32: string, account: string, issuer: string): string {
  const label = `${encodeURIComponent(issuer)}:${encodeURIComponent(account)}`;
  const params = new URLSearchParams({
    secret: secretB32,
    issuer,
    algorithm: "SHA1",
    digits: String(DIGITS),
    period: String(TOTP_PERIOD),
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}
