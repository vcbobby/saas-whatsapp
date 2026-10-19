import type { Metadata } from "next";
import Link from "next/link";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { Suspense } from "react";
import { Welcome } from "@/components/Welcome";
import { brand } from "@/config/brand";
import { can } from "@/lib/auth/permissions";
import { effectiveTenant, getSessionFromHeaders } from "@/lib/auth/session";
import { withTenant } from "@/lib/db";
import { loadPlan } from "@/lib/plans/usage";

export const metadata: Metadata = { title: "Bienvenida" };

export default function WelcomePage() {
  return (
    <Suspense fallback={<div className="container-app py-24 muted-dark" role="status">Cargando…</div>}>
      <WelcomeContent />
    </Suspense>
  );
}

async function WelcomeContent() {
  const auth = await getSessionFromHeaders(await headers());
  if (!auth) redirect("/entrar");
  const { session } = auth;
  if (session.needsMfaSetup) redirect("/seguridad");
  const ctx = effectiveTenant(session);
  if (!ctx || ctx.impersonating || !can(ctx.role, "agent:manage")) redirect("/panel");

  const info = await withTenant(ctx.tenantId, async (db) => {
    const t = await db.query("SELECT name, onboarding_state FROM tenants WHERE id = $1", [ctx.tenantId]);
    const plan = await loadPlan(db, ctx.tenantId);
    return { name: String(t.rows[0]?.name ?? ""), state: String(t.rows[0]?.onboarding_state ?? "done"), modules: plan?.modules ?? [] };
  });
  if (info.state === "done") redirect("/panel");

  return (
    <div className="flex min-h-screen flex-col">
      <header className="container-app flex h-20 items-center">
        <Link href="/panel" className="text-lg font-medium" style={{ letterSpacing: "-0.01em" }}>{brand.name}</Link>
      </header>
      <main className="container-app flex flex-1 items-start justify-center pb-24 pt-4">
        <Welcome businessName={info.name} modules={info.modules} />
      </main>
    </div>
  );
}
