import { AdminBilling } from "@/components/AdminBilling";
import { PlanEditor } from "@/components/PlanEditor";
import { rowToPlan } from "@/lib/plans/usage";
import type { Metadata } from "next";
import { headers } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { Suspense } from "react";
import { AppHeader } from "@/components/AppHeader";
import { TenantActions } from "@/components/TenantActions";
import { getPool } from "@/lib/db";
import { getSessionFromHeaders } from "@/lib/auth/session";

export const metadata: Metadata = { title: "Administración" };

const STATUS_LABEL: Record<string, string> = {
  trial: "Prueba",
  active: "Activa",
  past_due: "Pago pendiente",
  suspended: "Suspendida",
};

export default function AdminPage() {
  return (
    <Suspense fallback={<div className="container-app py-24 muted-dark" role="status">Cargando…</div>}>
      <AdminContent />
    </Suspense>
  );
}

async function AdminContent() {
  const auth = await getSessionFromHeaders(await headers());
  // Defensa en profundidad: el proxy ya responde 404 real a quien no es súper admin; aquí se repite la comprobación.
  if (!auth) notFound();
  if (auth.session.needsMfaSetup) redirect("/seguridad"); // súper admin sin 2FA
  if (!auth.session.isSuperAdmin) notFound(); // para el resto, esta página "no existe"

  const r = await getPool().query("SELECT * FROM admin_list_tenants($1)", [auth.tokenHash]);
  const planRows = (await getPool().query("SELECT * FROM plans ORDER BY position, name")).rows;
  const plans = planRows.map((r) => ({ ...rowToPlan(r), active: Boolean(r.active), isDefault: Boolean(r.is_default) }));
  const st = (await getPool().query("SELECT admin_get_payment_settings($1) AS s", [auth.tokenHash])).rows[0].s as Record<string, string | number | null>;
  const billing = {
    rate: st.bcv_rate === null ? null : Number(st.bcv_rate), rateAgeHours: st.rate_age_hours === null || st.rate_age_hours === undefined ? null : Number(st.rate_age_hours),
    pmBank: String(st.pm_bank ?? ""), pmPhone: String(st.pm_phone ?? ""), pmHolderId: String(st.pm_holder_id ?? ""), pmHolderName: String(st.pm_holder_name ?? ""),
    paypal: String(st.paypal_email ?? ""), binance: String(st.binance_id ?? ""), notes: String(st.notes ?? ""),
  };
  const priced = planRows.map((r) => ({ id: String(r.id), name: String(r.name), priceCents: r.price_usd_cents === null ? null : Number(r.price_usd_cents) }));
  const fmt = new Intl.DateTimeFormat("es-VE", { dateStyle: "medium" });

  return (
    <div className="flex min-h-screen flex-col">
      <AppHeader email={auth.session.email} roleLabel="Súper admin" showAdmin showWork={false} />
      <main className="container-app flex-1 pb-24 pt-8">
        <p className="eyebrow eyebrow--dark">Solo súper admin</p>
        <h1 className="mt-3 text-[32px] sm:text-[48px]">Administración</h1>
        <p className="muted-dark mt-3 max-w-xl text-sm">
          Entrar como soporte exige un motivo, dura 30 minutos como máximo y queda en el registro de auditoría del negocio.
        </p>

        <PlanEditor plans={plans} />

        <AdminBilling settings={billing} plans={priced} />

        <h2 className="mt-12 text-2xl">Negocios</h2>
        {r.rows.length === 0 ? (
          <p className="card-dark mt-10 muted-dark">Todavía no hay negocios registrados.</p>
        ) : (
          <ul className="mt-10 flex flex-col gap-4">
            {r.rows.map((t) => (
              <li key={t.t_id} className="card-dark grid gap-4 md:grid-cols-[1fr_auto] md:items-start">
                <div>
                  <h2 className="text-xl">{t.t_name}</h2>
                  <p className="muted-dark mt-1 text-sm">
                    {t.t_slug} · {Number(t.t_members)} {Number(t.t_members) === 1 ? "persona" : "personas"} · creado {fmt.format(t.t_created_at)}
                  </p>
                  <p className="mt-3">
                    <span className="badge">{STATUS_LABEL[t.t_status] ?? t.t_status}</span>
                  </p>
                </div>
                <TenantActions tenantId={t.t_id} status={t.t_status} planId={t.t_plan_id} plans={plans.map((p) => ({ id: p.id, name: p.name, active: p.active }))} />
              </li>
            ))}
          </ul>
        )}
      </main>
    </div>
  );
}
