import type { Metadata } from "next";
import { Suspense } from "react";
import { AppHeader } from "@/components/AppHeader";
import { PlanEditor } from "@/components/PlanEditor";
import { requireAdminPage } from "@/lib/admin/page";
import { getPool } from "@/lib/db";
import { rowToPlan } from "@/lib/plans/usage";

export const metadata: Metadata = { title: "Planes" };

export default function PlansPage() {
  return (
    <Suspense fallback={<div className="container-app py-24 muted-dark" role="status">Cargando…</div>}>
      <Content />
    </Suspense>
  );
}

async function Content() {
  const auth = await requireAdminPage();
  const planRows = (await getPool().query("SELECT * FROM plans ORDER BY position, name")).rows;
  const plans = planRows.map((r) => ({ ...rowToPlan(r), active: Boolean(r.active), isDefault: Boolean(r.is_default) }));
  return (
    <div className="flex min-h-screen flex-col">
      <AppHeader email={auth.session.email} roleLabel="Súper admin" showAdmin adminMode />
      <main className="container-app flex-1 pb-24 pt-8">
        <p className="eyebrow eyebrow--dark">Solo súper admin</p>
        <h1 className="mt-3 text-[32px] sm:text-[48px]">Planes</h1>
        <PlanEditor plans={plans} />
      </main>
    </div>
  );
}
