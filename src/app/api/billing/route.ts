import { getPool, withTenant } from "@/lib/db";
import { requireTenant } from "@/lib/auth/guard";
import { jsonResponse, route } from "@/lib/auth/http";
import { tokenHashOf } from "@/lib/auth/session";
import { loadOffers, loadPayments, loadSubscription } from "@/lib/billing/data";

/** Planes a la venta, pagos del negocio, vencimiento y datos para pagar. Solo el dueño. */
export const GET = route(async (req) => {
  const auth = await requireTenant(req, "billing:manage");
  if (!auth.ok) return auth.response;
  const t = auth.ctx.tenantId;
  const [offers, payments, subscription] = await withTenant(t, async (db) => [await loadOffers(db), await loadPayments(db, t), await loadSubscription(db, t)] as const);
  const payee = (await getPool().query("SELECT payment_payee($1, $2) AS p", [tokenHashOf(req)!, t])).rows[0].p as Record<string, unknown>;
  return jsonResponse({ offers, payments, subscription, payee });
});
