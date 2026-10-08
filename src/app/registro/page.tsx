import type { Metadata } from "next";
import { AuthForm } from "@/components/AuthForm";
import { AuthShell } from "@/components/AuthShell";

export const metadata: Metadata = { title: "Crear cuenta" };

export default function RegistroPage() {
  return (
    <AuthShell
      eyebrow="7 días de prueba"
      title="Crea tu cuenta"
      intro="Sin tarjeta. Configura tu negocio y prueba el agente durante una semana."
    >
      <AuthForm mode="signup" />
    </AuthShell>
  );
}
