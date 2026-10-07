import { createHash, randomBytes } from "node:crypto";

// 32 bytes aleatorios en base64url = 43 caracteres.
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

export function newSessionToken(): { token: string; hash: Buffer } {
  const token = randomBytes(32).toString("base64url");
  return { token, hash: hashToken(token) };
}

export function hashToken(token: string): Buffer {
  return createHash("sha256").update(token).digest();
}

export function isWellFormedToken(token: string): boolean {
  return TOKEN_RE.test(token);
}
