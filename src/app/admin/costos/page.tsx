import type { Metadata } from "next";
import { Suspense } from "react";
import { AdminCosts } from "@/components/AdminCosts";
import { AppHeader } from "@/components/AppHeader";
import { requireAdminPage } from "@/lib/admin/page";
import { getAdminBudget } from "@/lib/admin/costs";

export const metadata: Metadata = { title: "Costos de IA" };

export default function CostsPage() {
  return (
    <Suspense fallback={<div className="container-app py-24 muted-dark" role="status">Cargando…</div>}>
      <Content />
    </Suspense>
  );
}

async function Content() {
  const auth = await requireAdminPage();
  const budget = await getAdminBudget(auth.tokenHash);
  return (
    <div className="flex min-h-screen flex-col">
      <AppHeader email={auth.session.email} roleLabel="Súper admin" showAdmin adminMode />
      <main className="container-app flex-1 pb-24 pt-8">
        <p className="eyebrow eyebrow--dark">Solo súper admin</p>
        <h1 className="mt-3 text-[32px] sm:text-[48px]">Costos de IA</h1>
        <p className="muted-dark mt-3 max-w-xl text-sm">Cuánto se está gastando en IA, el presupuesto del mes y el corte automático. Solo cifras: aquí no se ven mensajes de los clientes.</p>
        <AdminCosts b={budget} />
      </main>
    </div>
  );
}
