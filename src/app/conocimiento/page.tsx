import type { Metadata } from "next";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { Suspense } from "react";
import { AppHeader, ROLE_LABEL } from "@/components/AppHeader";
import { KnowledgeBase } from "@/components/KnowledgeBase";
import { can } from "@/lib/auth/permissions";
import { effectiveTenant, getSessionFromHeaders } from "@/lib/auth/session";
import { getEmbeddingsEnv } from "@/lib/env";

export const metadata: Metadata = { title: "Conocimiento" };

export default function KnowledgePage() {
  return (
    <Suspense fallback={<div className="container-app py-24 muted-dark" role="status">Cargando…</div>}>
      <KnowledgeContent />
    </Suspense>
  );
}

async function KnowledgeContent() {
  const auth = await getSessionFromHeaders(await headers());
  if (!auth) redirect("/entrar");
  const { session } = auth;
  if (session.needsMfaSetup) redirect("/seguridad");
  const ctx = effectiveTenant(session);
  if (!ctx) redirect("/panel");

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
        <h1 className="mt-3 text-[32px] sm:text-[48px]">Conocimiento</h1>
        <div className="mt-10">
          <KnowledgeBase canManage={can(ctx.role, "agent:manage")} fakeEmbeddings={getEmbeddingsEnv().EMBEDDINGS_PROVIDER === "fake"} />
        </div>
      </main>
    </div>
  );
}
