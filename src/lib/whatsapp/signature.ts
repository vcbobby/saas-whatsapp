import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Meta firma cada webhook: cabecera X-Hub-Signature-256 = "sha256=" + HMAC-SHA256
 * (clave = app secret) calculado sobre los bytes EXACTOS del cuerpo recibido.
 */
export function verifySignature(rawBody: Buffer, header: string | null, appSecret: string): boolean {
  if (!header || !header.startsWith("sha256=")) return false;
  const hex = header.slice(7);
  if (!/^[0-9a-f]{64}$/i.test(hex)) return false;
  const expected = createHmac("sha256", appSecret).update(rawBody).digest();
  return timingSafeEqual(expected, Buffer.from(hex, "hex"));
}

/** Comparación en tiempo constante de dos textos de cualquier largo. */
export function safeEqualText(a: string, b: string): boolean {
  const ha = createHmac("sha256", "cmp").update(a).digest();
  const hb = createHmac("sha256", "cmp").update(b).digest();
  return timingSafeEqual(ha, hb);
}

/** Lee el cuerpo crudo con tope de tamaño (sin cargar cuerpos gigantes en memoria). */
export async function readRawBody(req: Request, maxBytes: number): Promise<Buffer | null> {
  const declared = Number(req.headers.get("content-length") ?? 0);
  if (declared > maxBytes) return null;
  if (!req.body) return Buffer.alloc(0);
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}
