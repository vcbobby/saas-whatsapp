import type { Metadata } from "next";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { Suspense } from "react";
import { LegalReaccept } from "@/components/LegalReaccept";
import { LogoutButton } from "@/components/LogoutButton";
import { getSessionFromHeaders } from "@/lib/auth/session";
import { getLegalStatus } from "@/lib/legal/consent";

export const metadata: Metadata = { title: "Aceptar los términos", robots: { index: false } };

export default function TerminosNuevosPage() {
  return (
    <Suspense fallback={<div className="container-app py-24 muted-dark" role="status">Cargando…</div>}>
      <TerminosContent />
    </Suspense>
  );
}

async function TerminosContent() {
  const auth = await getSessionFromHeaders(await headers(), { allowLegalPending: true });
  if (!auth) redirect("/entrar");
  // Quien ya está al día no tiene nada que hacer aquí.
  if (!auth.session.legalPending) redirect("/panel");
  const legal = await getLegalStatus(auth.session.userId);

  return (
    <div className="flex min-h-screen flex-col">
      <main className="container-app flex-1 pb-24 pt-16">
        <p className="eyebrow eyebrow--dark">Tu cuenta</p>
        <h1 className="mt-3 text-[32px] sm:text-[48px]">Antes de continuar</h1>
        <p className="muted-dark mt-3 max-w-[640px]">Mientras no aceptes los documentos legales vigentes no puedes usar el servicio. Si no estás de acuerdo con los cambios, puedes salir y escribirnos para cerrar tu cuenta y llevarte tus datos.</p>
        <div className="mt-8">
          <LegalReaccept version={legal.current} first={legal.accepted === null} />
        </div>
        <LogoutButton />
      </main>
    </div>
  );
}
