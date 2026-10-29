import type { Metadata } from "next";
import { headers } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { Suspense } from "react";
import { AppHeader, ROLE_LABEL } from "@/components/AppHeader";
import { DataTransfer } from "@/components/DataTransfer";
import { can } from "@/lib/auth/permissions";
import { effectiveTenant, getSessionFromHeaders } from "@/lib/auth/session";
import { tenantHasModule } from "@/lib/plans/modules";

export const metadata: Metadata = { title: "Importar y exportar" };

export default function DatosPage() {
  return (
    <Suspense fallback={<div className="container-app py-24 muted-dark" role="status">Cargando…</div>}>
      <DatosContent />
    </Suspense>
  );
}

async function DatosContent() {
  const auth = await getSessionFromHeaders(await headers());
  if (!auth) redirect("/entrar");
  const { session } = auth;
  if (session.needsMfaSetup) redirect("/seguridad");
  const ctx = effectiveTenant(session);
  if (!ctx || !can(ctx.role, "catalog:manage")) notFound();
  const [agenda, catalogo] = await Promise.all([tenantHasModule(ctx.tenantId, "agenda"), tenantHasModule(ctx.tenantId, "catalogo")]);

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
        <h1 className="mt-3 text-[32px] sm:text-[48px]">Importar y exportar</h1>
        <p className="muted-dark mt-3 max-w-[640px]">Sube tus productos desde Excel y descarga tus datos para trabajarlos en una hoja de cálculo.</p>
        <div className="mt-10">
          <DataTransfer agenda={agenda} catalogo={catalogo} />
        </div>
      </main>
    </div>
  );
}
