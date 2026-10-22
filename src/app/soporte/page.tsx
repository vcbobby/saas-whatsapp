import type { Metadata } from "next";
import Link from "next/link";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { Suspense } from "react";
import { AppHeader, ROLE_LABEL } from "@/components/AppHeader";
import { SupportDesk } from "@/components/SupportDesk";
import { can } from "@/lib/auth/permissions";
import { effectiveTenant, getSessionFromHeaders } from "@/lib/auth/session";

export const metadata: Metadata = { title: "Soporte" };

export default function SupportPage() {
  return (
    <Suspense fallback={<div className="container-app py-24 muted-dark" role="status">Cargando…</div>}>
      <SupportContent />
    </Suspense>
  );
}

async function SupportContent() {
  const auth = await getSessionFromHeaders(await headers());
  if (!auth) redirect("/entrar");
  const { session } = auth;
  if (session.needsMfaSetup) redirect("/seguridad");
  const ctx = effectiveTenant(session);
  if (!ctx) redirect("/seguridad");
  const allowed = can(ctx.role, "support:use");
  return (
    <div className="flex min-h-screen flex-col">
      <AppHeader email={session.email} roleLabel={ctx.impersonating ? "Soporte" : ROLE_LABEL[ctx.role]} showAdmin={session.isSuperAdmin} showTeam={can(ctx.role, "team:manage")} showWork />
      <main className="container-app flex-1 pb-24 pt-8">
        <p className="eyebrow eyebrow--dark">Ayuda personal</p>
        <h1 className="mt-3 text-[32px] sm:text-[48px]">Soporte</h1>
        <p className="muted-dark mt-3 max-w-xl text-sm">Escríbenos y te respondemos aquí. Antes de abrir una consulta, mira si la <Link href="/ayuda" className="link">Ayuda</Link> ya lo explica.</p>
        {allowed ? <SupportDesk mode="customer" /> : <p className="card-dark mt-8 muted-dark" style={{ maxWidth: 640 }}>Las consultas a soporte las abre el dueño o un administrador de tu negocio. Pídele que escriba por aquí.</p>}
      </main>
    </div>
  );
}
