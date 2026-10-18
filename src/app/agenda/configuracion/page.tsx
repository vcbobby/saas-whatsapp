import { ModuleLocked } from "@/components/ModuleLocked";
import { tenantHasModule } from "@/lib/plans/modules";
import type { Metadata } from "next";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import Link from "next/link";
import { Suspense } from "react";
import { AgendaConfig } from "@/components/AgendaConfig";
import { AppHeader, ROLE_LABEL } from "@/components/AppHeader";
import { can } from "@/lib/auth/permissions";
import { effectiveTenant, getSessionFromHeaders } from "@/lib/auth/session";

export const metadata: Metadata = { title: "Configurar agenda" };

export default function AgendaConfigPage() {
  return (
    <Suspense fallback={<div className="container-app py-24 muted-dark" role="status">Cargando…</div>}>
      <ConfigContent />
    </Suspense>
  );
}

async function ConfigContent() {
  const auth = await getSessionFromHeaders(await headers());
  if (!auth) redirect("/entrar");
  const { session } = auth;
  if (session.needsMfaSetup) redirect("/seguridad");
  const ctx = effectiveTenant(session);
  if (!ctx) redirect("/panel");
  const locked = !(await tenantHasModule(ctx.tenantId, "agenda"));

  return (
    <div className="flex min-h-screen flex-col">
      <AppHeader
        email={session.email}
        roleLabel={ctx.impersonating ? "Soporte" : ROLE_LABEL[ctx.role]}
        showAdmin={session.isSuperAdmin}
        showTeam={can(ctx.role, "team:manage")}
      />
      <main className="container-app flex-1 pb-24 pt-8">
        <p className="eyebrow eyebrow--dark">Tu negocio</p>
        <h1 className="mt-3 text-[32px] sm:text-[48px]">Configurar agenda</h1>
        {locked ? <ModuleLocked module="agenda" /> : (
          <>
        <p className="muted-dark mt-3 max-w-[640px]">Define tus servicios y horarios. Las citas se agendarán solo en los huecos libres.</p>
        <p className="mt-3"><Link href="/agenda" className="link">← Volver a las citas</Link></p>
        <div className="mt-10">
          <AgendaConfig />
        </div>
                </>
        )}
      </main>
    </div>
  );
}
