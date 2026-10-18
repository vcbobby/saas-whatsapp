import { getPool } from "@/lib/db";
import { requireSuperAdmin } from "@/lib/auth/guard";
import { checkOrigin, errorResponse, jsonResponse, readJson, route } from "@/lib/auth/http";
import { billingSettingsSchema } from "@/lib/auth/validation";

/** Tasa BCV y datos de cobro de la plataforma. Solo súper admin. */
export const GET = route(async (req) => {
  const auth = await requireSuperAdmin(req);
  if (!auth.ok) return auth.response;
  const r = await getPool().query("SELECT admin_get_payment_settings($1) AS s", [auth.tokenHash]);
  return jsonResponse({ settings: r.rows[0].s });
});

export const POST = route(async (req) => {
  const blocked = checkOrigin(req);
  if (blocked) return blocked;
  const auth = await requireSuperAdmin(req);
  if (!auth.ok) return auth.response;
  const body = await readJson(req, billingSettingsSchema);
  if (!body.ok) return body.response;
  const d = body.data;
  try {
    await getPool().query("SELECT admin_set_payment_settings($1,$2,$3,$4,$5,$6,$7,$8,$9)", [auth.tokenHash, d.rate, d.pmBank, d.pmPhone, d.pmHolderId, d.pmHolderName, d.paypal, d.binance, d.notes]);
  } catch (e) {
    if ((e as { code?: string }).code === "22023") return errorResponse(400, "datos_invalidos", "Tasa inválida.");
    throw e;
  }
  return jsonResponse({ ok: true });
});
