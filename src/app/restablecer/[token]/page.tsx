import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { AuthShell } from "@/components/AuthShell";
import { ResetForm } from "@/components/ResetForm";
import { getPool } from "@/lib/db";
import { hashToken, isWellFormedToken } from "@/lib/auth/tokens";

// El enlace lleva un secreto: que no viaje en la cabecera Referer.
export const metadata: Metadata = { title: "Nueva contraseña", referrer: "no-referrer", robots: { index: false } };

export default function RestablecerPage({ params }: { params: Promise<{ token: string }> }) {
  return (
    <Suspense fallback={<div className="container-app py-24 muted-dark" role="status">Cargando…</div>}>
      <Content params={params} />
    </Suspense>
  );
}

async function Content({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const email = isWellFormedToken(token) ? (await getPool().query<{ email: string | null }>("SELECT auth_reset_peek($1) AS email", [hashToken(token)])).rows[0]?.email : null;
  if (!email) {
    return (
      <AuthShell eyebrow="Tu cuenta" title="Este enlace no sirve" intro="Venció (vale 1 hora) o ya se usó. Pide uno nuevo.">
        <Link href="/recuperar" className="btn btn-primary">Pedir otro enlace</Link>
      </AuthShell>
    );
  }
  return (
    <AuthShell eyebrow="Tu cuenta" title="Elige tu contraseña nueva">
      <ResetForm token={token} />
    </AuthShell>
  );
}
