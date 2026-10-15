import { randomBytes } from "node:crypto";
import { encryptSecret } from "@/lib/crypto";
import { aadFor } from "./deliver";

/** Secreto de firma nuevo: «whsec_» + 32 bytes aleatorios. Se muestra UNA vez; en la base queda cifrado. */
export const newSecret = () => `whsec_${randomBytes(32).toString("base64url")}`;

export function sealSecret(secret: string, tenantId: string, endpointId: string) {
  const { payload, keyVersion } = encryptSecret(secret, aadFor(tenantId, endpointId));
  return { secretEnc: payload, keyVersion };
}

/** La dirección sin parámetros ni usuario: los parámetros pueden llevar claves privadas y no se muestran en pantalla. */
export function displayUrl(raw: string): string {
  try {
    const u = new URL(raw);
    return `${u.protocol}//${u.host}${u.pathname === "/" ? "" : u.pathname}${u.search ? "?…" : ""}`;
  } catch {
    return "(dirección inválida)";
  }
}
