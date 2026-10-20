import type { Metadata } from "next";
import { Suspense } from "react";
import { AppHeader } from "@/components/AppHeader";
import { TenantActions } from "@/components/TenantActions";
import { TENANT_STATUS_LABEL } from "@/lib/admin/overview";
import { requireAdminPage } from "@/lib/admin/page";
import { getPool } from "@/lib/db";

export const metadata: Metadata = { title: "Negocios" };

export default function BusinessesPage() {
  return (
    <Suspense fallback={<div className="container-app py-24 muted-dark" role="status">Cargando…</div>}>
      <Content />
    </Suspense>
  );
}

async function Content() {
  const auth = await requireAdminPage();
  const r = await getPool().query("SELECT * FROM admin_list_tenants($1)", [auth.tokenHash]);
  const plans = (await getPool().query("SELECT id, name, active FROM plans ORDER BY position, name")).rows.map((p) => ({ id: String(p.id), name: String(p.name), active: Boolean(p.active) }));
  const fmt = new Intl.DateTimeFormat("es-VE", { dateStyle: "medium" });
  return (
    <div className="flex min-h-screen flex-col">
      <AppHeader email={auth.session.email} roleLabel="Súper admin" showAdmin adminMode />
      <main className="container-app flex-1 pb-24 pt-8">
        <p className="eyebrow eyebrow--dark">Solo súper admin</p>
        <h1 className="mt-3 text-[32px] sm:text-[48px]">Negocios</h1>
        <p className="muted-dark mt-3 max-w-xl text-sm">
          Entrar como soporte exige un motivo, dura 30 minutos como máximo y queda en el registro de auditoría del negocio.
        </p>
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
                  <p className="mt-3"><span className="badge">{TENANT_STATUS_LABEL[t.t_status] ?? t.t_status}</span></p>
                </div>
                <TenantActions tenantId={t.t_id} status={t.t_status} planId={t.t_plan_id} plans={plans} />
              </li>
            ))}
          </ul>
        )}
      </main>
    </div>
  );
}
