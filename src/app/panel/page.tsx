import type { Metadata } from "next";
import { headers } from "next/headers";
import Link from "next/link";
import { redirect } from "next/navigation";
import { Suspense } from "react";
import { AppHeader, ROLE_LABEL } from "@/components/AppHeader";
import { StopImpersonationButton } from "@/components/StopImpersonationButton";
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
        const r = await db.query<{ name: string; status: string; days_left: number | null }>(
          `SELECT name, status,
                  GREATEST(0, CEIL(EXTRACT(EPOCH FROM (trial_ends_at - now())) / 86400))::int AS days_left
           FROM tenants`,
        );
        return r.rows[0] ?? null;
      })
    : null;

  const daysLeft = tenant?.status === "trial" ? tenant.days_left : null;

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
      />

      <main className="container-app flex-1 pb-24 pt-8">
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

            <section className="mt-12 grid gap-6 md:grid-cols-3" aria-label="Próximos pasos">
              <article className="card-dark">
                <p className="eyebrow eyebrow--dark">Paso 1</p>
                <h2 className="mt-2 text-xl">Conecta tu WhatsApp</h2>
                <p className="muted-dark mt-2 text-sm">
                  <Link href="/whatsapp" className="link">Conectar mi número</Link>
                </p>
              </article>
              <article className="card-dark">
                <p className="eyebrow eyebrow--dark">Paso 2</p>
                <h2 className="mt-2 text-xl">Cuéntale a tu agente cómo atiendes</h2>
                <p className="muted-dark mt-2 text-sm">
                  Horarios, servicios y preguntas frecuentes. <Link href="/agente" className="link">Configurar el asistente</Link>
                </p>
              </article>
              <article className="card-dark">
                <p className="eyebrow eyebrow--dark">Paso 3</p>
                <h2 className="mt-2 text-xl">Invita a tu equipo</h2>
                <p className="muted-dark mt-2 text-sm">
                  {can(ctx.role, "team:manage") ? "Podrás añadir agentes y administradores." : "Solo administradores y dueños pueden invitar personas."}
                </p>
              </article>
            </section>
          </>
        )}
      </main>
    </div>
  );
}
