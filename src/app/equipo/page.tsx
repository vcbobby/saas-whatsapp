import type { Metadata } from "next";
import { headers } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { Suspense } from "react";
import { AppHeader, ROLE_LABEL } from "@/components/AppHeader";
import { TeamPanel } from "@/components/TeamPanel";
import { getPool } from "@/lib/db";
import { can } from "@/lib/auth/permissions";
import { effectiveTenant, getSessionFromHeaders } from "@/lib/auth/session";

export const metadata: Metadata = { title: "Equipo" };

export default function EquipoPage() {
  return (
    <Suspense fallback={<div className="container-app py-24 muted-dark" role="status">Cargando…</div>}>
      <EquipoContent />
    </Suspense>
  );
}

async function EquipoContent() {
  const auth = await getSessionFromHeaders(await headers());
  if (!auth) redirect("/entrar");
  const { session, tokenHash } = auth;
  if (session.needsMfaSetup) redirect("/seguridad");
  const ctx = effectiveTenant(session);
  if (!ctx || !can(ctx.role, "team:manage")) notFound();

  const pool = getPool();
  const [m, i] = await Promise.all([
    pool.query("SELECT * FROM team_members($1, $2)", [tokenHash, ctx.tenantId]),
    pool.query("SELECT * FROM team_invitations($1, $2)", [tokenHash, ctx.tenantId]),
  ]);

  return (
    <div className="flex min-h-screen flex-col">
      <AppHeader
        email={session.email}
        roleLabel={ctx.impersonating ? "Soporte" : ROLE_LABEL[ctx.role]}
        showAdmin={session.isSuperAdmin}
        showTeam
      />
      <main className="container-app flex-1 pb-24 pt-8">
        <p className="eyebrow eyebrow--dark">Tu negocio</p>
        <h1 className="mt-3 text-[32px] sm:text-[48px]">Equipo</h1>
        <div className="mt-10">
          <TeamPanel
            myRole={ctx.role}
            myUserId={session.userId}
            members={m.rows.map((r) => ({
              userId: r.m_user_id, email: r.m_email, role: r.m_role,
              since: new Date(r.m_since).toISOString(), mfa: r.m_mfa,
            }))}
            invitations={i.rows.map((r) => ({
              id: r.i_id, email: r.i_email, role: r.i_role, expiresAt: new Date(r.i_expires).toISOString(),
            }))}
          />
        </div>
      </main>
    </div>
  );
}
