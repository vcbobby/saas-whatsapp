import type { Metadata } from "next";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { Suspense } from "react";
import { AppHeader, ROLE_LABEL } from "@/components/AppHeader";
import { WhatsAppConnect } from "@/components/WhatsAppConnect";
import { withTenant } from "@/lib/db";
import { can } from "@/lib/auth/permissions";
import { effectiveTenant, getSessionFromHeaders } from "@/lib/auth/session";

export const metadata: Metadata = { title: "WhatsApp" };

export default function WhatsAppPage() {
  return (
    <Suspense fallback={<div className="container-app py-24 muted-dark" role="status">Cargando…</div>}>
      <WhatsAppContent />
    </Suspense>
  );
}

async function WhatsAppContent() {
  const auth = await getSessionFromHeaders(await headers());
  if (!auth) redirect("/entrar");
  const { session } = auth;
  if (session.needsMfaSetup) redirect("/seguridad");
  const ctx = effectiveTenant(session);
  if (!ctx) redirect("/panel");

  // Nunca se lee la columna del secreto.
  const connected = await withTenant(ctx.tenantId, async (db) => {
    const r = await db.query<{ external_id: string }>(
      "SELECT external_id FROM tenant_integrations WHERE provider = 'whatsapp'",
    );
    return r.rows[0]?.external_id ?? null;
  });

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
        <h1 className="mt-3 text-[32px] sm:text-[48px]">WhatsApp</h1>
        <div className="mt-10">
          <WhatsAppConnect connectedId={connected} canManage={can(ctx.role, "integrations:manage")} />
        </div>
      </main>
    </div>
  );
}
