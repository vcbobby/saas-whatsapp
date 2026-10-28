import type { Metadata } from "next";
import { Suspense } from "react";
import { AuthShell } from "@/components/AuthShell";
import { VerifyEmailButton } from "@/components/VerifyEmailButton";

export const metadata: Metadata = { title: "Confirmar correo", referrer: "no-referrer", robots: { index: false } };

export default function VerificarPage({ params }: { params: Promise<{ token: string }> }) {
  return (
    <Suspense fallback={<div className="container-app py-24 muted-dark" role="status">Cargando…</div>}>
      <Content params={params} />
    </Suspense>
  );
}

async function Content({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  return (
    <AuthShell eyebrow="Tu cuenta" title="Confirmar correo" intro="Toca el botón para confirmar que este correo es tuyo.">
      <VerifyEmailButton token={token} />
    </AuthShell>
  );
}
