import type { Metadata } from "next";
import { headers } from "next/headers";
import Link from "next/link";
import { redirect } from "next/navigation";
import { Suspense } from "react";
import { AppHeader, ROLE_LABEL } from "@/components/AppHeader";
import { CustomerFile } from "@/components/CustomerFile";
import { can } from "@/lib/auth/permissions";
import { effectiveTenant, getSessionFromHeaders } from "@/lib/auth/session";

export const metadata: Metadata = { title: "Ficha de cliente" };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export default function CustomerPage({ params }: { params: Promise<{ id: string }> }) {
  return (
    <Suspense fallback={<div className="container-app py-24 muted-dark" role="status">Cargando…</div>}>
      <CustomerContent params={params} />
    </Suspense>
  );
}

async function CustomerContent({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const auth = await getSessionFromHeaders(await headers());
  if (!auth) redirect("/entrar");
  const { session } = auth;
  if (session.needsMfaSetup) redirect("/seguridad");
  const ctx = effectiveTenant(session);
  if (!ctx) redirect("/panel");

  return (
    <div className="flex min-h-screen flex-col">
      <AppHeader email={session.email} roleLabel={ctx.impersonating ? "Soporte" : ROLE_LABEL[ctx.role]} showAdmin={session.isSuperAdmin} showTeam={can(ctx.role, "team:manage")} />
      <main className="container-app flex-1 pb-24 pt-8">
        <Link href="/clientes" className="link text-[14px]" style={{ color: "#fff" }}>← Todos los clientes</Link>
        <h1 className="mt-3 text-[32px] sm:text-[40px]">Ficha de cliente</h1>
        <div className="mt-8 max-w-[820px]">
          {UUID.test(id) ? <CustomerFile id={id} canEdit={can(ctx.role, "contacts:edit")} /> : (
            <div className="card-light" style={{ padding: 24 }}>
              <h2 className="text-[22px]">No encontramos a ese cliente</h2>
              <Link href="/clientes" className="btn btn-sm btn-ghost-light mt-4">Volver a clientes</Link>
            </div>
          )}
        </div>
      </main>
    </div>
  );
}
