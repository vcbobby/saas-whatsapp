import type { Metadata } from "next";
import { AuthShell } from "@/components/AuthShell";
import { ForgotForm } from "@/components/ForgotForm";

export const metadata: Metadata = { title: "Recuperar contraseña" };

export default function RecuperarPage() {
  return (
    <AuthShell eyebrow="Tu cuenta" title="Recuperar contraseña" intro="Escribe tu correo y te enviamos un enlace para elegir una contraseña nueva. Vale 1 hora.">
      <ForgotForm />
    </AuthShell>
  );
}
