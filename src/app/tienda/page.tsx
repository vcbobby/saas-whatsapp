import type { Metadata } from "next";
import { headers } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { Suspense } from "react";
import { AppHeader, ROLE_LABEL } from "@/components/AppHeader";
import { StorefrontSettings } from "@/components/StorefrontSettings";
import { can } from "@/lib/auth/permissions";
import { tenantHasModule } from "@/lib/plans/modules";
import { effectiveTenant, getSessionFromHeaders } from "@/lib/auth/session";

export const metadata: Metadata = { title: "Catálogo público" };

export default function StorePage() {
  return (
    <Suspense fallback={<div className="container-app py-24 muted-dark" role="status">Cargando…</div>}>
      <StoreContent />
    </Suspense>
  );
}

async function StoreContent() {
  const auth = await getSessionFromHeaders(await headers());
  if (!auth) redirect("/entrar");
  const { session } = auth;
  if (session.needsMfaSetup) redirect("/seguridad");
  const ctx = effectiveTenant(session);
  if (!ctx) redirect("/panel");
  if (!can(ctx.role, "catalog:manage") || !(await tenantHasModule(ctx.tenantId, "catalogo"))) notFound();

  return (
    <div className="flex min-h-screen flex-col">
      <AppHeader email={session.email} roleLabel={ctx.impersonating ? "Soporte" : ROLE_LABEL[ctx.role]} showAdmin={session.isSuperAdmin} showTeam={can(ctx.role, "team:manage")} />
      <main className="container-app flex-1 pb-24 pt-8">
        <p className="eyebrow eyebrow--dark">Tu negocio</p>
        <h1 className="mt-3 text-[32px] sm:text-[48px]">Catálogo público</h1>
        <p className="muted-dark mt-3 max-w-[640px]">Una página con tus productos que puedes compartir por enlace o código QR. Tus clientes eligen y te piden por WhatsApp con un clic.</p>
        <div className="mt-10">
          <StorefrontSettings />
        </div>
      </main>
    </div>
  );
}
