import type { Metadata } from "next";
import { headers } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { Suspense } from "react";
import { AppHeader, ROLE_LABEL } from "@/components/AppHeader";
import { SimulatorChat } from "@/components/SimulatorChat";
import { can } from "@/lib/auth/permissions";
import { effectiveTenant, getSessionFromHeaders } from "@/lib/auth/session";
import { devToolsEnabled } from "@/lib/env";

export const metadata: Metadata = { title: "Simulador" };

export default function SimulatorPage() {
  return (
    <Suspense fallback={<div className="container-app py-24 muted-dark" role="status">Cargando…</div>}>
      <SimulatorContent />
    </Suspense>
  );
}

async function SimulatorContent() {
  // Fuera de local/test esta página no existe.
  if (!devToolsEnabled()) notFound();
  const auth = await getSessionFromHeaders(await headers());
  if (!auth) redirect("/entrar");
  const { session } = auth;
  if (session.needsMfaSetup) redirect("/seguridad");
  const ctx = effectiveTenant(session);
  if (!ctx) redirect("/panel");

  return (
    <div className="flex min-h-screen flex-col">
      <AppHeader
        email={session.email}
        roleLabel={ctx.impersonating ? "Soporte" : ROLE_LABEL[ctx.role]}
        showAdmin={session.isSuperAdmin}
        showTeam={can(ctx.role, "team:manage")}
      />
      <main className="container-app flex-1 pb-24 pt-8">
        <p className="eyebrow eyebrow--dark">Herramientas de desarrollo</p>
        <h1 className="mt-3 text-[32px] sm:text-[48px]">Simulador</h1>
        <div className="mt-10">
          {can(ctx.role, "agent:manage") ? (
            <SimulatorChat />
          ) : (
            <p className="muted-dark">Solo dueños y administradores pueden usar el simulador.</p>
          )}
        </div>
      </main>
    </div>
  );
}
