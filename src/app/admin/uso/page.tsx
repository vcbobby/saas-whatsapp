import type { Metadata } from "next";
import { Suspense } from "react";
import { AdminUsageView } from "@/components/AdminUsageView";
import { AppHeader } from "@/components/AppHeader";
import { requireAdminPage } from "@/lib/admin/page";
import { getAdminUsage } from "@/lib/admin/usage";

export const metadata: Metadata = { title: "Uso y salud" };

export default function UsagePage() {
  return (
    <Suspense fallback={<div className="container-app py-24 muted-dark" role="status">Cargando…</div>}>
      <Content />
    </Suspense>
  );
}

async function Content() {
  const auth = await requireAdminPage();
  const usage = await getAdminUsage(auth.tokenHash);
  return (
    <div className="flex min-h-screen flex-col">
      <AppHeader email={auth.session.email} roleLabel="Súper admin" showAdmin adminMode />
      <main className="container-app flex-1 pb-24 pt-8">
        <p className="eyebrow eyebrow--dark">Solo súper admin</p>
        <h1 className="mt-3 text-[32px] sm:text-[48px]">Uso y salud</h1>
        <p className="muted-dark mt-3 max-w-xl text-sm">Qué usan los negocios, cuánta IA consumen y si algo está fallando. Solo cifras: aquí no se ven mensajes ni datos de los clientes.</p>
        <AdminUsageView u={usage} />
      </main>
    </div>
  );
}
