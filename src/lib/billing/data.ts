import type { PoolClient } from "pg";

type Db = Pick<PoolClient, "query">;

export interface PlanOffer { id: string; slug: string; name: string; priceUsdCents: number; maxRepliesMonth: number | null; maxMembers: number; modules: string[] }
export interface PaymentRow {
  id: string; planId: string; months: number; method: "pago_movil" | "paypal" | "binance"; amountUsdCents: number;
  rate: number | null; amountBsCents: number | null; quoteExpiresAt: string; status: "pendiente" | "por_revisar" | "confirmado" | "rechazado" | "vencido";
  reference: string | null; paidOn: string | null; declaredCents: number | null; createdAt: string; submittedAt: string | null; rejectReason: string | null;
}
export interface Subscription { status: string; planName: string; expiresAt: string | null; daysLeft: number | null }

/** Planes que se pueden comprar (activos y con precio). */
export async function loadOffers(db: Db): Promise<PlanOffer[]> {
  const r = await db.query("SELECT id, slug, name, price_usd_cents, max_replies_month, max_members, modules FROM plans WHERE active AND price_usd_cents IS NOT NULL ORDER BY position, name");
  return r.rows.map((x) => ({ id: x.id, slug: x.slug, name: x.name, priceUsdCents: Number(x.price_usd_cents), maxRepliesMonth: x.max_replies_month === null ? null : Number(x.max_replies_month), maxMembers: Number(x.max_members), modules: x.modules }));
}

export async function loadPayments(db: Db, tenantId: string): Promise<PaymentRow[]> {
  const r = await db.query(
    `SELECT id, plan_id, months, method, amount_usd_cents, rate, amount_bs_cents, quote_expires_at, status, reference, to_char(paid_on, 'YYYY-MM-DD') AS paid_on, declared_cents, created_at, submitted_at, reject_reason
       FROM payments WHERE tenant_id = $1 ORDER BY created_at DESC LIMIT 20`, [tenantId]);
  return r.rows.map((x) => ({
    id: x.id, planId: x.plan_id, months: x.months, method: x.method, amountUsdCents: Number(x.amount_usd_cents),
    rate: x.rate === null ? null : Number(x.rate), amountBsCents: x.amount_bs_cents === null ? null : Number(x.amount_bs_cents),
    quoteExpiresAt: new Date(x.quote_expires_at).toISOString(), status: x.status, reference: x.reference,
    paidOn: x.paid_on,
    declaredCents: x.declared_cents === null ? null : Number(x.declared_cents),
    createdAt: new Date(x.created_at).toISOString(), submittedAt: x.submitted_at ? new Date(x.submitted_at).toISOString() : null, rejectReason: x.reject_reason,
  }));
}

export async function loadSubscription(db: Db, tenantId: string): Promise<Subscription | null> {
  const r = await db.query(
    `SELECT t.status, p.name, t.plan_expires_at,
            CASE WHEN t.plan_expires_at IS NULL THEN NULL ELSE CEIL(EXTRACT(EPOCH FROM (t.plan_expires_at - now())) / 86400)::int END AS days_left
       FROM tenants t JOIN plans p ON p.id = t.plan_id WHERE t.id = $1`, [tenantId]);
  const x = r.rows[0];
  if (!x) return null;
  return { status: x.status, planName: x.name, expiresAt: x.plan_expires_at ? new Date(x.plan_expires_at).toISOString() : null, daysLeft: x.days_left === null ? null : Number(x.days_left) };
}
