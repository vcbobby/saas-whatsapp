import Link from "next/link";
import { withTenant } from "@/lib/db";
import { loadSubscription } from "@/lib/billing/data";
import { subscriptionNotice } from "@/lib/billing/notice";

/** Aviso de vencimiento o de pago pendiente. No muestra nada si todo está al día. */
export async function SubscriptionNotice({ tenantId, canPay }: { tenantId: string; canPay: boolean }) {
  const sub = await withTenant(tenantId, (db) => loadSubscription(db, tenantId));
  const n = subscriptionNotice(sub, canPay);
  if (!n) return null;
  return (
    <p className={n.level === "error" ? "alert-error mt-8" : "alert-warn mt-8"} role={n.level === "error" ? "alert" : "status"} style={{ maxWidth: 720 }}>
      {n.text}{" "}
      {canPay && <Link href="/plan" className="link">Ir a Plan y pagos</Link>}
    </p>
  );
}
