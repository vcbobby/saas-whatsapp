import type { Metadata } from "next";
import { headers } from "next/headers";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { Suspense } from "react";
import { AppHeader, ROLE_LABEL } from "@/components/AppHeader";
import { BroadcastDetail } from "@/components/BroadcastDetail";
import { can } from "@/lib/auth/permissions";
import { effectiveTenant, getSessionFromHeaders } from "@/lib/auth/session";

export const metadata: Metadata = { title: "Difusión" };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export default function BroadcastPage({ params }: { params: Promise<{ id: string }> }) {
  return (
    <Suspense fallback={<div className="container-app py-24 muted-dark" role="status">Cargando…</div>}>
      <BroadcastContent params={params} />
    </Suspense>
  );
}

async function BroadcastContent({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const auth = await getSessionFromHeaders(await headers());
  if (!auth) redirect("/entrar");
  const { session } = auth;
  if (session.needsMfaSetup) redirect("/seguridad");
  const ctx = effectiveTenant(session);
  if (!ctx) redirect("/panel");
  if (!can(ctx.role, "broadcasts:manage")) notFound();

  return (
    <div className="flex min-h-screen flex-col">
      <AppHeader email={session.email} roleLabel={ctx.impersonating ? "Soporte" : ROLE_LABEL[ctx.role]} showAdmin={session.isSuperAdmin} showTeam={can(ctx.role, "team:manage")} />
      <main className="container-app flex-1 pb-24 pt-8">
        <Link href="/difusiones" className="link text-[14px]" style={{ color: "#fff" }}>← Todas las difusiones</Link>
        <h1 className="mt-3 text-[32px] sm:text-[40px]">Difusión</h1>
        <div className="mt-8 max-w-[860px]">
          {UUID.test(id) ? <BroadcastDetail id={id} /> : <p className="alert-error">No encontramos esa difusión.</p>}
        </div>
      </main>
    </div>
  );
}
