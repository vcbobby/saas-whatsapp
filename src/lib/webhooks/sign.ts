import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Firma de cada aviso (parecida a la de Stripe): cabecera  X-Webhook-Signature: t=<segundos>,v1=<hex>
 * donde v1 = HMAC-SHA256(secreto, `${t}.${cuerpo exacto}`). Quien recibe debe recalcularla y rechazar si no coincide
 * o si «t» es muy viejo (anti-repetición).
 */
export function signBody(secret: string, timestampSec: number, body: string): string {
  const mac = createHmac("sha256", secret).update(`${timestampSec}.${body}`).digest("hex");
  return `t=${timestampSec},v1=${mac}`;
}

export function verifySignature(secret: string, header: string | null | undefined, body: string, opts: { toleranceSec?: number; nowSec?: number } = {}): boolean {
  if (!header) return false;
  const parts = Object.fromEntries(header.split(",").map((p) => { const i = p.indexOf("="); return [p.slice(0, i).trim(), p.slice(i + 1).trim()]; }));
  const t = Number(parts.t);
  if (!Number.isInteger(t) || typeof parts.v1 !== "string" || !/^[0-9a-f]{64}$/.test(parts.v1)) return false;
  const now = opts.nowSec ?? Math.floor(Date.now() / 1000);
  if (Math.abs(now - t) > (opts.toleranceSec ?? 300)) return false;
  const expected = Buffer.from(createHmac("sha256", secret).update(`${t}.${body}`).digest("hex"), "hex");
  const given = Buffer.from(parts.v1, "hex");
  return expected.length === given.length && timingSafeEqual(expected, given);
}
