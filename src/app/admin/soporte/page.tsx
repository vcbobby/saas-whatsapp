import type { Metadata } from "next";
import { Suspense } from "react";
import { AppHeader } from "@/components/AppHeader";
import { SupportDesk } from "@/components/SupportDesk";
import { requireAdminPage } from "@/lib/admin/page";

export const metadata: Metadata = { title: "Soporte" };

export default function AdminSupportPage() {
  return (
    <Suspense fallback={<div className="container-app py-24 muted-dark" role="status">Cargando…</div>}>
      <Content />
    </Suspense>
  );
}

async function Content() {
  const auth = await requireAdminPage();
  return (
    <div className="flex min-h-screen flex-col">
      <AppHeader email={auth.session.email} roleLabel="Súper admin" showAdmin adminMode />
      <main className="container-app flex-1 pb-24 pt-8">
        <p className="eyebrow eyebrow--dark">Solo súper admin</p>
        <h1 className="mt-3 text-[32px] sm:text-[48px]">Soporte</h1>
        <p className="muted-dark mt-3 max-w-xl text-sm">Las consultas que te escriben los negocios. Tus respuestas las ve el negocio como «Soporte» (sin tu correo) y quedan en su registro de auditoría.</p>
        <SupportDesk mode="admin" />
      </main>
    </div>
  );
}
