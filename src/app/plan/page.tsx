import type { Metadata } from "next";
import { headers } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { Suspense } from "react";
import { AppHeader, ROLE_LABEL } from "@/components/AppHeader";
import { BillingPanel } from "@/components/BillingPanel";
import { can } from "@/lib/auth/permissions";
import { effectiveTenant, getSessionFromHeaders } from "@/lib/auth/session";

export const metadata: Metadata = { title: "Plan y pagos" };

export default function PlanPage() {
  return (
    <Suspense fallback={<div className="container-app py-24 muted-dark" role="status">Cargando…</div>}>
      <PlanContent />
    </Suspense>
  );
}

async function PlanContent() {
  const auth = await getSessionFromHeaders(await headers());
  if (!auth) redirect("/entrar");
  const { session } = auth;
  if (session.needsMfaSetup) redirect("/seguridad");
  const ctx = effectiveTenant(session);
  if (!ctx || ctx.impersonating || !can(ctx.role, "billing:manage")) notFound();
  return (
    <div className="flex min-h-screen flex-col">
      <AppHeader email={session.email} roleLabel={ROLE_LABEL[ctx.role]} showAdmin={session.isSuperAdmin} showTeam />
      <main className="container-app flex-1 pb-24 pt-8">
        <p className="eyebrow eyebrow--dark">Tu negocio</p>
        <h1 className="mt-3 text-[32px] sm:text-[48px]">Plan y pagos</h1>
        <BillingPanel />
      </main>
    </div>
  );
}
