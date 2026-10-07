import { randomBytes } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { decryptSecret, encryptSecret } from "@/lib/crypto";

const NEGOCIO_A = "11111111-1111-4111-8111-111111111111";
const NEGOCIO_B = "22222222-2222-4222-8222-222222222222";

describe("cifrado de secretos", () => {
  beforeAll(() => {
    process.env.ENCRYPTION_KEY_1 = randomBytes(32).toString("base64");
    process.env.ENCRYPTION_CURRENT_VERSION = "1";
  });

  it("cifra y descifra", () => {
    const { payload, keyVersion } = encryptSecret("token-secreto-123", NEGOCIO_A);
    expect(payload).not.toContain("token-secreto-123");
    expect(decryptSecret(payload, NEGOCIO_A, keyVersion)).toBe("token-secreto-123");
  });

  it("el mismo texto produce resultados distintos cada vez", () => {
    const a = encryptSecret("igual", NEGOCIO_A).payload;
    const b = encryptSecret("igual", NEGOCIO_A).payload;
    expect(a).not.toBe(b);
  });

  it("no descifra si se copia a otro negocio", () => {
    const { payload, keyVersion } = encryptSecret("token", NEGOCIO_A);
    expect(() => decryptSecret(payload, NEGOCIO_B, keyVersion)).toThrow();
  });

  it("detecta manipulación", () => {
    const { payload, keyVersion } = encryptSecret("token", NEGOCIO_A);
    const [iv, tag, enc] = payload.split(".");
    const dañado = Buffer.from(enc!, "base64");
    dañado[0] = dañado[0]! ^ 0xff;
    const alterado = [iv, tag, dañado.toString("base64")].join(".");
    expect(() => decryptSecret(alterado, NEGOCIO_A, keyVersion)).toThrow();
  });

  it("rechaza etiquetas truncadas", () => {
    const { payload, keyVersion } = encryptSecret("token", NEGOCIO_A);
    const [iv, tag, enc] = payload.split(".");
    const corta = Buffer.from(tag!, "base64").subarray(0, 4).toString("base64");
    expect(() => decryptSecret([iv, corta, enc].join("."), NEGOCIO_A, keyVersion)).toThrow();
  });

  it("falla si falta la clave", () => {
    const { payload } = encryptSecret("token", NEGOCIO_A);
    expect(() => decryptSecret(payload, NEGOCIO_A, 99)).toThrow(/clave de cifrado/);
  });
});
