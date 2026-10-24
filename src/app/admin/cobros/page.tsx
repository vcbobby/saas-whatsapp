import type { Metadata } from "next";
import { Suspense } from "react";
import { AdminBilling } from "@/components/AdminBilling";
import { AppHeader } from "@/components/AppHeader";
import { requireAdminPage } from "@/lib/admin/page";
import { getPool } from "@/lib/db";

export const metadata: Metadata = { title: "Cobros" };

export default function BillingPage() {
  return (
    <Suspense fallback={<div className="container-app py-24 muted-dark" role="status">Cargando…</div>}>
      <Content />
    </Suspense>
  );
}

async function Content() {
  const auth = await requireAdminPage();
  const planRows = (await getPool().query("SELECT id, name, price_usd_cents FROM plans ORDER BY position, name")).rows;
  const st = (await getPool().query("SELECT admin_get_payment_settings($1) AS s", [auth.tokenHash])).rows[0].s as Record<string, string | number | null>;
  const hist = (await getPool().query("SELECT * FROM admin_rate_history($1)", [auth.tokenHash])).rows;
  const billing = {
    rateInfo: {
      mode: (st.rate_mode === "auto" ? "auto" : "manual") as "auto" | "manual", source: st.rate_source === null || st.rate_source === undefined ? null : String(st.rate_source),
      lastOkAt: st.rate_last_ok_at ? String(st.rate_last_ok_at) : null, lastAttemptAt: st.rate_last_attempt_at ? String(st.rate_last_attempt_at) : null, lastError: st.rate_last_error ? String(st.rate_last_error) : null,
      history: hist.map((h) => ({ rate: Number(h.h_rate), source: String(h.h_source), kind: h.h_kind as "auto" | "manual" | "rejected", note: h.h_note ? String(h.h_note) : null, at: new Date(h.h_at).toISOString() })),
    },
    rate: st.bcv_rate === null ? null : Number(st.bcv_rate), rateAgeHours: st.rate_age_hours === null || st.rate_age_hours === undefined ? null : Number(st.rate_age_hours),
    pmBank: String(st.pm_bank ?? ""), pmPhone: String(st.pm_phone ?? ""), pmHolderId: String(st.pm_holder_id ?? ""), pmHolderName: String(st.pm_holder_name ?? ""),
    paypal: String(st.paypal_email ?? ""), binance: String(st.binance_id ?? ""), notes: String(st.notes ?? ""),
  };
  const priced = planRows.map((r) => ({ id: String(r.id), name: String(r.name), priceCents: r.price_usd_cents === null ? null : Number(r.price_usd_cents) }));
  return (
    <div className="flex min-h-screen flex-col">
      <AppHeader email={auth.session.email} roleLabel="Súper admin" showAdmin adminMode />
      <main className="container-app flex-1 pb-24 pt-8">
        <p className="eyebrow eyebrow--dark">Solo súper admin</p>
        <h1 className="mt-3 text-[32px] sm:text-[48px]">Cobros</h1>
        <AdminBilling settings={billing} plans={priced} />
      </main>
    </div>
  );
}
