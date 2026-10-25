import { ModuleLocked } from "@/components/ModuleLocked";
import { tenantHasModule } from "@/lib/plans/modules";
import type { Metadata } from "next";
import { headers } from "next/headers";
import Link from "next/link";
import { redirect } from "next/navigation";
import { Suspense } from "react";
import { InventoryManager } from "@/components/InventoryManager";
import { AppHeader, ROLE_LABEL } from "@/components/AppHeader";
import { can } from "@/lib/auth/permissions";
import { effectiveTenant, getSessionFromHeaders } from "@/lib/auth/session";

export const metadata: Metadata = { title: "Inventario" };

export default function InventoryPage() {
  return (
    <Suspense fallback={<div className="container-app py-24 muted-dark" role="status">Cargando…</div>}>
      <InventoryContent />
    </Suspense>
  );
}

async function InventoryContent() {
  const auth = await getSessionFromHeaders(await headers());
  if (!auth) redirect("/entrar");
  const { session } = auth;
  if (session.needsMfaSetup) redirect("/seguridad");
  const ctx = effectiveTenant(session);
  if (!ctx) redirect("/panel");
  const locked = !(await tenantHasModule(ctx.tenantId, "catalogo"));

  return (
    <div className="flex min-h-screen flex-col">
      <AppHeader
        email={session.email}
        roleLabel={ctx.impersonating ? "Soporte" : ROLE_LABEL[ctx.role]}
        showAdmin={session.isSuperAdmin}
        showTeam={can(ctx.role, "team:manage")}
      />
      <main className="container-app flex-1 pb-24 pt-8">
        <p className="eyebrow eyebrow--dark">Tu negocio · <Link href="/catalogo" className="link">Catálogo</Link></p>
        <h1 className="mt-3 text-[32px] sm:text-[48px]">Inventario</h1>
        {locked ? <ModuleLocked module="catalogo" /> : (
          <>
            <p className="muted-dark mt-3 max-w-[640px]">
              Cuánto tienes de cada producto. Los pedidos confirmados descuentan solos; aquí registras compras, mermas y conteos. Todo queda en el historial.
            </p>
            <div className="mt-10">
              <InventoryManager />
            </div>
          </>
        )}
      </main>
    </div>
  );
}
