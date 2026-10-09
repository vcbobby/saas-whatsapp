import type { Metadata } from "next";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { Suspense } from "react";
import { AppHeader, ROLE_LABEL } from "@/components/AppHeader";
import { SecurityPanel } from "@/components/SecurityPanel";
import { getPool } from "@/lib/db";
import { can } from "@/lib/auth/permissions";
import { effectiveTenant, getSessionFromHeaders } from "@/lib/auth/session";

export const metadata: Metadata = { title: "Seguridad" };

export default function SeguridadPage() {
  return (
    <Suspense fallback={<div className="container-app py-24 muted-dark" role="status">Cargando…</div>}>
      <SeguridadContent />
    </Suspense>
  );
}

async function SeguridadContent() {
  const auth = await getSessionFromHeaders(await headers());
  if (!auth) redirect("/entrar");
  const { session, tokenHash } = auth;
  const ctx = effectiveTenant(session);
  const st = await getPool().query("SELECT * FROM mfa_status($1)", [tokenHash]);
  const row = st.rows[0] ?? { st_enabled: false, st_codes_left: 0 };
  const isSuper = session.isSuperAdmin || session.needsMfaSetup;

  return (
    <div className="flex min-h-screen flex-col">
      <AppHeader
        email={session.email}
        roleLabel={ctx ? ROLE_LABEL[ctx.role] : isSuper ? "Súper admin" : undefined}
        showAdmin={session.isSuperAdmin}
        showTeam={!!ctx && can(ctx.role, "team:manage")}
      />
      <main className="container-app flex-1 pb-24 pt-8">
        <p className="eyebrow eyebrow--dark">Tu cuenta</p>
        <h1 className="mt-3 text-[32px] sm:text-[48px]">Seguridad</h1>
        <div className="mt-10">
          <SecurityPanel
            enabled={row.st_enabled}
            codesLeft={row.st_codes_left}
            isSuperAdmin={isSuper}
            mustEnable={session.needsMfaSetup}
          />
        </div>
      </main>
    </div>
  );
}
