import type { Metadata } from "next";
import { Suspense } from "react";
import { AdminOverviewView } from "@/components/AdminOverview";
import { AppHeader } from "@/components/AppHeader";
import { getAdminOverview } from "@/lib/admin/overview";
import { requireAdminPage } from "@/lib/admin/page";
import { budgetAttention, getAdminBudget } from "@/lib/admin/costs";

export const metadata: Metadata = { title: "Resumen de la plataforma" };

export default function AdminPage() {
  return (
    <Suspense fallback={<div className="container-app py-24 muted-dark" role="status">Cargando…</div>}>
      <AdminContent />
    </Suspense>
  );
}

async function AdminContent() {
  const auth = await requireAdminPage();
  const overview = await getAdminOverview(auth.tokenHash);
  // El aviso de costos no debe tumbar el Resumen si falla.
  const ai = await getAdminBudget(auth.tokenHash).then((b) => budgetAttention(b.state)).catch(() => null);
  return (
    <div className="flex min-h-screen flex-col">
      <AppHeader email={auth.session.email} roleLabel="Súper admin" showAdmin adminMode />
      <main className="container-app flex-1 pb-24 pt-8">
        <p className="eyebrow eyebrow--dark">Solo súper admin</p>
        <h1 className="mt-3 text-[32px] sm:text-[48px]">Resumen</h1>
        <p className="muted-dark mt-3 max-w-xl text-sm">Cómo va la plataforma: registros nuevos, negocios en prueba, con plan activo y lo que está por vencer.</p>
        <AdminOverviewView o={overview} ai={ai} />
      </main>
    </div>
  );
}
