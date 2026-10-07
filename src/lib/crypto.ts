import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const ALGORITHM = "aes-256-gcm";
const IV_BYTES = 12;
const TAG_BYTES = 16;

function loadKey(version: number): Buffer {
  const raw = process.env[`ENCRYPTION_KEY_${version}`];
  if (!raw) throw new Error(`Falta la clave de cifrado versión ${version}`);
  const key = Buffer.from(raw, "base64");
  if (key.length !== 32) {
    throw new Error(`La clave de cifrado versión ${version} debe tener 32 bytes en base64`);
  }
  return key;
}

export function currentKeyVersion(): number {
  const v = Number(process.env.ENCRYPTION_CURRENT_VERSION ?? "1");
  if (!Number.isInteger(v) || v < 1) throw new Error("ENCRYPTION_CURRENT_VERSION inválida");
  return v;
}

/**
 * Cifra un texto con AES-256-GCM.
 * `aad` ata el resultado a un contexto (por ejemplo el id del negocio):
 * si alguien copia el texto cifrado a otro negocio, el descifrado falla.
 */
export function encryptSecret(
  plaintext: string,
  aad: string,
): { payload: string; keyVersion: number } {
  const keyVersion = currentKeyVersion();
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, loadKey(keyVersion), iv, { authTagLength: TAG_BYTES });
  cipher.setAAD(Buffer.from(aad, "utf8"));
  const enc = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  const payload = [iv, tag, enc].map((b) => b.toString("base64")).join(".");
  return { payload, keyVersion };
}

export function decryptSecret(payload: string, aad: string, keyVersion: number): string {
  const [ivB64, tagB64, encB64] = payload.split(".");
  if (!ivB64 || !tagB64 || !encB64) throw new Error("Formato de secreto inválido");
  const iv = Buffer.from(ivB64, "base64");
  const tag = Buffer.from(tagB64, "base64");
  if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) {
    throw new Error("Formato de secreto inválido");
  }
  const decipher = createDecipheriv(ALGORITHM, loadKey(keyVersion), iv, {
    authTagLength: TAG_BYTES,
  });
  decipher.setAAD(Buffer.from(aad, "utf8"));
  decipher.setAuthTag(tag);
  const dec = Buffer.concat([decipher.update(Buffer.from(encB64, "base64")), decipher.final()]);
  return dec.toString("utf8");
}
