import type { Metadata } from "next";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { Suspense } from "react";
import { AppHeader, ROLE_LABEL } from "@/components/AppHeader";
import { Inbox } from "@/components/Inbox";
import { can } from "@/lib/auth/permissions";
import { effectiveTenant, getSessionFromHeaders } from "@/lib/auth/session";

export const metadata: Metadata = { title: "Conversaciones" };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export default function ConversationsPage({ searchParams }: { searchParams: Promise<{ c?: string | string[] }> }) {
  return (
    <Suspense fallback={<div className="container-app py-24 muted-dark" role="status">Cargando…</div>}>
      <ConversationsContent searchParams={searchParams} />
    </Suspense>
  );
}

async function ConversationsContent({ searchParams }: { searchParams: Promise<{ c?: string | string[] }> }) {
  const auth = await getSessionFromHeaders(await headers());
  if (!auth) redirect("/entrar");
  const { session } = auth;
  if (session.needsMfaSetup) redirect("/seguridad");
  const ctx = effectiveTenant(session);
  if (!ctx) redirect("/panel");
  const c = (await searchParams).c;
  const initialId = typeof c === "string" && UUID.test(c) ? c : null;

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
        <h1 className="mt-3 text-[32px] sm:text-[48px]">Conversaciones</h1>
        <div className="mt-10">
          <Inbox initialId={initialId} />
        </div>
      </main>
    </div>
  );
}
