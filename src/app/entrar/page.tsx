import type { Metadata } from "next";
import { AuthForm } from "@/components/AuthForm";
import { AuthShell } from "@/components/AuthShell";

export const metadata: Metadata = { title: "Entrar" };

export default function EntrarPage() {
  return (
    <AuthShell eyebrow="Tu cuenta" title="Entrar">
      <AuthForm mode="login" />
    </AuthShell>
  );
}
