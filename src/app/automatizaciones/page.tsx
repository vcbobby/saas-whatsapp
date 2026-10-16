import type { Metadata } from "next";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { Suspense } from "react";
import { AppHeader, ROLE_LABEL } from "@/components/AppHeader";
import { AutomationsManager } from "@/components/AutomationsManager";
import { can } from "@/lib/auth/permissions";
import { effectiveTenant, getSessionFromHeaders } from "@/lib/auth/session";

export const metadata: Metadata = { title: "Automatizaciones" };

export default function AutomationsPage() {
  return (
    <Suspense fallback={<div className="container-app py-24 muted-dark" role="status">Cargando…</div>}>
      <AutomationsContent />
    </Suspense>
  );
}

async function AutomationsContent() {
  const auth = await getSessionFromHeaders(await headers());
  if (!auth) redirect("/entrar");
  const { session } = auth;
  if (session.needsMfaSetup) redirect("/seguridad");
  const ctx = effectiveTenant(session);
  if (!ctx) redirect("/panel");
  if (!can(ctx.role, "integrations:manage")) redirect("/hoy");

  return (
    <div className="flex min-h-screen flex-col">
      <AppHeader email={session.email} roleLabel={ctx.impersonating ? "Soporte" : ROLE_LABEL[ctx.role]} showAdmin={session.isSuperAdmin} showTeam={can(ctx.role, "team:manage")} />
      <main className="container-app flex-1 pb-24 pt-8">
        <p className="eyebrow eyebrow--dark">Tu negocio</p>
        <h1 className="mt-3 text-[32px] sm:text-[48px]">Automatizaciones</h1>
        <div className="mt-6">
          <AutomationsManager />
        </div>
      </main>
    </div>
  );
}
