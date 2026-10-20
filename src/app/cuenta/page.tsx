import type { Metadata } from "next";
import Link from "next/link";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { Suspense } from "react";
import { AppHeader, ROLE_LABEL } from "@/components/AppHeader";
import { BusinessNameForm } from "@/components/BusinessNameForm";
import { can } from "@/lib/auth/permissions";
import { effectiveTenant, getSessionFromHeaders } from "@/lib/auth/session";
import { withTenant } from "@/lib/db";
import { loadPlan } from "@/lib/plans/usage";

export const metadata: Metadata = { title: "Mi cuenta" };

const STATUS_LABEL: Record<string, string> = { trial: "Prueba gratis", active: "Activa", past_due: "Pago pendiente", suspended: "Suspendida" };

export default function AccountPage() {
  return (
    <Suspense fallback={<div className="container-app py-24 muted-dark" role="status">Cargando…</div>}>
      <AccountContent />
    </Suspense>
  );
}

async function AccountContent() {
  const auth = await getSessionFromHeaders(await headers());
  if (!auth) redirect("/entrar");
  const { session } = auth;
  if (session.needsMfaSetup) redirect("/seguridad");
  const ctx = effectiveTenant(session);
  if (!ctx) redirect("/seguridad");

  const info = await withTenant(ctx.tenantId, async (db) => {
    const t = await db.query("SELECT name, status, to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS since FROM tenants WHERE id = $1", [ctx.tenantId]);
    const plan = await loadPlan(db, ctx.tenantId);
    return { name: String(t.rows[0]?.name ?? ""), status: String(t.rows[0]?.status ?? ""), since: String(t.rows[0]?.since ?? ""), plan: plan?.name ?? "—" };
  });
  const canEdit = can(ctx.role, "settings:edit") && !ctx.impersonating;
  const since = info.since ? new Intl.DateTimeFormat("es", { timeZone: "UTC", day: "numeric", month: "long", year: "numeric" }).format(new Date(`${info.since}T00:00:00Z`)) : "—";

  return (
    <div className="flex min-h-screen flex-col">
      <AppHeader email={session.email} roleLabel={ctx.impersonating ? "Soporte" : ROLE_LABEL[ctx.role]} showAdmin={session.isSuperAdmin} showTeam={can(ctx.role, "team:manage")} showWork />
      <main className="container-app flex-1 pb-24 pt-8">
        <p className="eyebrow eyebrow--dark">Tu cuenta</p>
        <h1 className="mt-3 text-[32px] sm:text-[48px]">Mi cuenta</h1>

        <div className="mt-10 grid gap-8">
          <section className="card-light" style={{ maxWidth: 640 }} aria-labelledby="acc-biz">
            <p className="eyebrow">Mi negocio</p>
            <h2 id="acc-biz" className="mt-3 text-[28px]">{info.name}</h2>
            <dl className="mt-4 grid gap-3 text-[15px] sm:grid-cols-3">
              <div><dt className="muted text-[13px]">Estado</dt><dd><span className="badge">{STATUS_LABEL[info.status] ?? info.status}</span></dd></div>
              <div><dt className="muted text-[13px]">Plan</dt><dd>{info.plan}{can(ctx.role, "billing:manage") && <> · <Link href="/plan" className="link">Ver plan</Link></>}</dd></div>
              <div><dt className="muted text-[13px]">Cliente desde</dt><dd>{since}</dd></div>
            </dl>
            <div className="mt-6"><BusinessNameForm initialName={info.name} canEdit={canEdit} /></div>
          </section>

          <section className="card-light" style={{ maxWidth: 640 }} aria-labelledby="acc-user">
            <p className="eyebrow">Mi usuario</p>
            <h2 id="acc-user" className="mt-3 text-[28px]">{session.email}</h2>
            <dl className="mt-4 grid gap-3 text-[15px] sm:grid-cols-2">
              <div><dt className="muted text-[13px]">Rol en este negocio</dt><dd>{ctx.impersonating ? "Soporte" : ROLE_LABEL[ctx.role]}</dd></div>
              <div><dt className="muted text-[13px]">Verificación en dos pasos</dt><dd>{session.mfaEnabled ? "Activada" : "Sin activar"}</dd></div>
            </dl>
            <p className="mt-6"><Link href="/seguridad" className="btn btn-ghost-light">Contraseña y seguridad</Link></p>
          </section>
        </div>
      </main>
    </div>
  );
}
