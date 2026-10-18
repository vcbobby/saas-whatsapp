import { ModuleLocked } from "@/components/ModuleLocked";
import { tenantHasModule } from "@/lib/plans/modules";
import type { Metadata } from "next";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { Suspense } from "react";
import { AppHeader, ROLE_LABEL } from "@/components/AppHeader";
import { ConnectionsManager } from "@/components/ConnectionsManager";
import { can } from "@/lib/auth/permissions";
import { effectiveTenant, getSessionFromHeaders } from "@/lib/auth/session";

export const metadata: Metadata = { title: "Conexiones" };

export default function ConnectionsPage() {
  return (
    <Suspense fallback={<div className="container-app py-24 muted-dark" role="status">Cargando…</div>}>
      <ConnectionsContent />
    </Suspense>
  );
}

async function ConnectionsContent() {
  const auth = await getSessionFromHeaders(await headers());
  if (!auth) redirect("/entrar");
  const { session } = auth;
  if (session.needsMfaSetup) redirect("/seguridad");
  const ctx = effectiveTenant(session);
  if (!ctx) redirect("/panel");
  const locked = !(await tenantHasModule(ctx.tenantId, "automatizaciones"));
  if (!can(ctx.role, "integrations:manage")) redirect("/hoy");

  return (
    <div className="flex min-h-screen flex-col">
      <AppHeader email={session.email} roleLabel={ctx.impersonating ? "Soporte" : ROLE_LABEL[ctx.role]} showAdmin={session.isSuperAdmin} showTeam={can(ctx.role, "team:manage")} />
      <main className="container-app flex-1 pb-24 pt-8">
        <p className="eyebrow eyebrow--dark">Tu negocio</p>
        <h1 className="mt-3 text-[32px] sm:text-[48px]">Conexiones</h1>
        {locked ? <ModuleLocked module="automatizaciones" /> : (
          <>
        <div className="mt-6">
          <ConnectionsManager />
        </div>
                </>
        )}
      </main>
    </div>
  );
}
