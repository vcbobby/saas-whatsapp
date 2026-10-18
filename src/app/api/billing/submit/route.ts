import { getPool } from "@/lib/db";
import { requireTenant } from "@/lib/auth/guard";
import { checkOrigin, errorResponse, jsonResponse, readJson, route } from "@/lib/auth/http";
import { tokenHashOf } from "@/lib/auth/session";
import { parseAmountToCents } from "@/lib/billing/money";
import { MAX_PROOF_BYTES, sniffImage } from "@/lib/billing/proof";
import { billingErrorResponse } from "@/lib/billing/errors";
import { paySubmitSchema } from "@/lib/auth/validation";

/** Envía el comprobante de un pago para que una persona lo confirme. */
export const POST = route(async (req) => {
  const blocked = checkOrigin(req);
  if (blocked) return blocked;
  const auth = await requireTenant(req, "billing:manage");
  if (!auth.ok) return auth.response;
  const body = await readJson(req, paySubmitSchema, { maxChars: 3_000_000 });
  if (!body.ok) return body.response;
  const d = body.data;
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(d.proof)) return errorResponse(400, "imagen_invalida", "La imagen del comprobante no es válida.");
  const bytes = Buffer.from(d.proof, "base64");
  if (bytes.length > MAX_PROOF_BYTES) return errorResponse(413, "imagen_grande", "La imagen pesa más de 2 MB.");
  const mime = sniffImage(bytes);
  if (!mime) return errorResponse(400, "imagen_invalida", "El comprobante debe ser una imagen JPG, PNG o WebP.");
  const cents = parseAmountToCents(d.declared);
  if (cents === null) return errorResponse(400, "monto_invalido", "No entendí el monto. Escríbelo como 1.234,56.");
  try {
    await getPool().query("SELECT payment_submit($1, $2, $3, $4, $5, $6, $7::date, $8, $9, $10)", [
      tokenHashOf(req)!, auth.ctx.tenantId, d.paymentId, d.reference, d.bank, d.phone, d.paidOn, cents, bytes, mime,
    ]);
  } catch (e) {
    const r = billingErrorResponse(e);
    if (r) return r;
    throw e;
  }
  return jsonResponse({ ok: true });
});
