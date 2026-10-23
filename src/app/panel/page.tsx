import { SubscriptionNotice } from "@/components/SubscriptionNotice";
import { PlanCard } from "@/components/PlanCard";
import { Dashboard } from "@/components/Dashboard";
import type { Metadata } from "next";
import { headers } from "next/headers";
import Link from "next/link";
import { redirect } from "next/navigation";
import { Suspense } from "react";
import { AppHeader, ROLE_LABEL } from "@/components/AppHeader";
import { LegalReaccept } from "@/components/LegalReaccept";
import { StopImpersonationButton } from "@/components/StopImpersonationButton";
import { getLegalStatus } from "@/lib/legal/consent";
import { effectiveTenant, getSessionFromHeaders } from "@/lib/auth/session";
import { can } from "@/lib/auth/permissions";
import { withTenant } from "@/lib/db";

export const metadata: Metadata = { title: "Panel" };

const STATUS_LABEL: Record<string, string> = {
  trial: "Prueba gratis",
  active: "Activa",
  past_due: "Pago pendiente",
  suspended: "Suspendida",
};

export default function PanelPage() {
  return (
    <Suspense fallback={<div className="container-app py-24 muted-dark" role="status">Cargando…</div>}>
      <PanelContent />
    </Suspense>
  );
}

async function PanelContent() {
  const auth = await getSessionFromHeaders(await headers());
  if (!auth) redirect("/entrar");
  const { session } = auth;
  if (session.needsMfaSetup) redirect("/seguridad");
  const ctx = effectiveTenant(session);

  const tenant = ctx
    ? await withTenant(ctx.tenantId, async (db) => {
        const r = await db.query<{ name: string; status: string; onboarding_state: string; days_left: number | null }>(
          `SELECT name, status, onboarding_state,
                  GREATEST(0, CEIL(EXTRACT(EPOCH FROM (trial_ends_at - now())) / 86400))::int AS days_left
           FROM tenants`,
        );
        return r.rows[0] ?? null;
      })
    : null;

  // Negocio nuevo: primero el asistente de bienvenida (quien solo atiende chats no lo ve).
  if (ctx && !ctx.impersonating && tenant?.onboarding_state === "pending" && can(ctx.role, "agent:manage")) redirect("/bienvenida");

  const daysLeft = tenant?.status === "trial" ? tenant.days_left : null;
  // Si falla la consulta, la pantalla sigue funcionando (el aviso solo se omite).
  const legal = ctx?.impersonating ? null : await getLegalStatus(session.userId).catch(() => null);

  return (
    <div className="flex min-h-screen flex-col">
      {ctx?.impersonating && tenant && (
        <div className="alert-warn flex flex-wrap items-center justify-between gap-3" style={{ borderRadius: 0 }} role="status">
          <span>
            Estás viendo <strong>{tenant.name}</strong> como soporte (máximo 30 minutos). Todo queda registrado y el dueño puede verlo.
          </span>
          <StopImpersonationButton />
        </div>
      )}

      <AppHeader
        email={session.email}
        roleLabel={ctx ? (ctx.impersonating ? "Soporte" : ROLE_LABEL[ctx.role]) : "Súper admin"}
        showAdmin={session.isSuperAdmin}
        showTeam={!!ctx && can(ctx.role, "team:manage")}
        showWork={!!ctx}
      />

      <main className="container-app flex-1 pb-24 pt-8">
        {legal && !legal.upToDate && <LegalReaccept version={legal.current} first={legal.accepted === null} />}
        {!ctx || !tenant ? (
          <section className="card-light" style={{ maxWidth: 640 }}>
            <p className="eyebrow">Sin negocio</p>
            <h1 className="mt-3 text-[32px]">No tienes un negocio activo</h1>
            <p className="muted mt-3">
              {session.isSuperAdmin ? (
                <>
                  Entra desde <Link href="/admin" className="link">Administración</Link> para ver un negocio como soporte.
                </>
              ) : (
                "Pide acceso a quien administra tu negocio."
              )}
            </p>
          </section>
        ) : (
          <>
            <p className="eyebrow eyebrow--dark">Tu negocio</p>
            <h1 className="mt-3 text-[32px] sm:text-[48px]" style={{ lineHeight: 1.12 }}>
              {tenant.name}
            </h1>
            <div className="mt-4 flex flex-wrap items-center gap-3">
              <span className="badge">{STATUS_LABEL[tenant.status] ?? tenant.status}</span>
              {daysLeft !== null && (
                <span className="muted-dark text-sm">
                  {daysLeft === 1 ? "Queda 1 día de prueba" : `Quedan ${daysLeft} días de prueba`}
                </span>
              )}
            </div>

            {tenant.status === "suspended" && !ctx.impersonating && (
              <p className="alert-warn mt-8" role="alert">
                Esta cuenta está suspendida. Escríbenos para reactivarla.
              </p>
            )}

            <SubscriptionNotice tenantId={ctx.tenantId} canPay={can(ctx.role, "billing:manage") && !ctx.impersonating} />

            <Dashboard />

            <PlanCard />
          </>
        )}
      </main>
    </div>
  );
}
