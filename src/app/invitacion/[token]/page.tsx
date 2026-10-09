import type { Metadata } from "next";
import { headers } from "next/headers";
import Link from "next/link";
import { Suspense } from "react";
import { AuthShell } from "@/components/AuthShell";
import { InviteAccept } from "@/components/InviteAccept";
import { LogoutButton } from "@/components/LogoutButton";
import { getPool } from "@/lib/db";
import { getSessionFromHeaders } from "@/lib/auth/session";
import { hashToken } from "@/lib/auth/tokens";

// El enlace lleva un secreto: que no viaje en la cabecera Referer a otros sitios.
export const metadata: Metadata = { title: "Invitación", referrer: "no-referrer", robots: { index: false } };

const ROLE_LABEL: Record<string, string> = { admin: "administrador", agent: "agente" };

export default function InvitacionPage({ params }: { params: Promise<{ token: string }> }) {
  return (
    <Suspense fallback={<div className="container-app py-24 muted-dark" role="status">Cargando…</div>}>
      <InvitacionContent params={params} />
    </Suspense>
  );
}

async function InvitacionContent({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const valid = /^[A-Za-z0-9_-]{43}$/.test(token);
  const peek = valid
    ? (await getPool().query("SELECT * FROM invite_peek($1)", [hashToken(token)])).rows[0]
    : undefined;

  if (!peek) {
    return (
      <AuthShell eyebrow="Invitación" title="Este enlace no sirve" intro="La invitación venció, ya se usó o fue cancelada. Pídele a quien te invitó que cree una nueva.">
        <Link href="/entrar" className="btn btn-ghost-light">Ir a entrar</Link>
      </AuthShell>
    );
  }

  const auth = await getSessionFromHeaders(await headers());
  const intro = `Te invitaron a unirte a «${peek.v_tenant_name}» como ${ROLE_LABEL[peek.v_role] ?? peek.v_role}.`;

  if (auth && auth.session.email === peek.v_email) {
    return (
      <AuthShell eyebrow="Invitación" title="Unirte al equipo" intro={intro}>
        <InviteAccept token={token} mode="accept" email={peek.v_email} />
      </AuthShell>
    );
  }
  if (auth) {
    return (
      <AuthShell eyebrow="Invitación" title="Es para otro correo" intro={`${intro} Esta invitación es para ${peek.v_email}, pero ahora tienes abierta otra cuenta.`}>
        <LogoutButton />
      </AuthShell>
    );
  }
  if (peek.v_user_exists) {
    return (
      <AuthShell eyebrow="Invitación" title="Inicia sesión para aceptar" intro={`${intro} Entra con ${peek.v_email} y vuelve a abrir este enlace.`}>
        <Link href="/entrar" className="btn btn-primary">Entrar</Link>
      </AuthShell>
    );
  }
  return (
    <AuthShell eyebrow="Invitación" title="Crea tu cuenta" intro={intro}>
      <InviteAccept token={token} mode="signup" email={peek.v_email} />
    </AuthShell>
  );
}
