import type { Metadata } from "next";
import { headers } from "next/headers";
import Link from "next/link";
import { redirect } from "next/navigation";
import { Suspense } from "react";
import { AppHeader, ROLE_LABEL } from "@/components/AppHeader";
import { TemplatesManager } from "@/components/TemplatesManager";
import { can } from "@/lib/auth/permissions";
import { effectiveTenant, getSessionFromHeaders } from "@/lib/auth/session";

export const metadata: Metadata = { title: "Plantillas de WhatsApp" };

export default function PlantillasPage() {
  return (
    <Suspense fallback={<div className="container-app py-24 muted-dark" role="status">Cargando…</div>}>
      <Content />
    </Suspense>
  );
}

async function Content() {
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
        <p className="eyebrow eyebrow--dark"><Link href="/whatsapp" className="link">← WhatsApp</Link></p>
        <h1 className="mt-3 text-[32px] sm:text-[48px]">Plantillas</h1>
        <p className="muted-dark mt-3" style={{ maxWidth: 680 }}>
          WhatsApp solo deja escribirle a un cliente con texto libre durante las 24 horas siguientes a su último mensaje. Pasado ese tiempo, solo se puede con una <strong>plantilla aprobada por Meta</strong>.
        </p>
        <div className="mt-10">
          <TemplatesManager canManage={can(ctx.role, "integrations:manage")} />
        </div>
      </main>
    </div>
  );
}
