import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { AuthShell } from "@/components/AuthShell";
import { DevInbox } from "@/components/DevInbox";
import { devToolsEnabled } from "@/lib/env";

export const metadata: Metadata = { title: "Correos de desarrollo", robots: { index: false } };

export default function DevCorreosPage() {
  if (!devToolsEnabled()) notFound();
  return (
    <AuthShell eyebrow="Solo desarrollo" title="Correos de prueba" intro="Aquí ves los correos que la app enviaría (recuperar contraseña, confirmar correo, invitaciones, avisos).">
      <DevInbox />
    </AuthShell>
  );
}
