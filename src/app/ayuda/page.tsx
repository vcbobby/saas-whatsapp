import type { Metadata } from "next";
import Link from "next/link";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { Suspense } from "react";
import { AppHeader, ROLE_LABEL } from "@/components/AppHeader";
import { ScrollToHash } from "@/components/ScrollToHash";
import { brand } from "@/config/brand";
import { can } from "@/lib/auth/permissions";
import { effectiveTenant, getSessionFromHeaders } from "@/lib/auth/session";
import { HELP_FAQ, HELP_TOPICS } from "@/lib/help";

export const metadata: Metadata = { title: "Ayuda" };

export default function HelpPage() {
  return (
    <Suspense fallback={<div className="container-app py-24 muted-dark" role="status">Cargando…</div>}>
      <HelpContent />
    </Suspense>
  );
}

async function HelpContent() {
  const auth = await getSessionFromHeaders(await headers());
  if (!auth) redirect("/entrar");
  const { session } = auth;
  const ctx = effectiveTenant(session);
  return (
    <div className="flex min-h-screen flex-col">
      <AppHeader email={session.email} roleLabel={ctx ? (ctx.impersonating ? "Soporte" : ROLE_LABEL[ctx.role]) : session.isSuperAdmin ? "Súper admin" : undefined} showAdmin={session.isSuperAdmin} showTeam={!!ctx && can(ctx.role, "team:manage")} showWork={!!ctx} />
      <ScrollToHash />
      <main className="container-app flex-1 pb-24 pt-8">
        <p className="eyebrow eyebrow--dark">Centro de ayuda</p>
        <h1 className="mt-3 text-[32px] sm:text-[48px]">Ayuda</h1>
        <p className="muted-dark mt-3 max-w-[640px]">Una guía corta por cada pantalla. ¿No encuentras lo que buscas? Escríbenos desde <Link href="/soporte" className="link">Soporte</Link> o a <a className="link" href={`mailto:${brand.supportEmail}`}>{brand.supportEmail}</a>.</p>

        <nav aria-label="Temas de ayuda" className="mt-8 flex flex-wrap gap-2">
          {HELP_TOPICS.map((t) => <a key={t.id} href={`#${t.id}`} className="badge badge-neutral" style={{ textDecoration: "none" }}>{t.title}</a>)}
        </nav>

        <div className="mt-10 grid max-w-[820px] gap-6">
          {HELP_TOPICS.map((t) => (
            <section key={t.id} id={t.id} className="card-dark" style={{ scrollMarginTop: 24 }} aria-labelledby={`${t.id}-t`}>
              <h2 id={`${t.id}-t`} className="text-[24px]">{t.title}</h2>
              <p className="muted-dark mt-1">{t.summary}</p>
              <ol className="mt-4 grid gap-2" style={{ paddingLeft: 24, listStyle: "decimal" }}>{t.steps.map((s) => <li key={s}>{s}</li>)}</ol>
              <p className="mt-4 flex flex-wrap gap-4">{t.links.map((l) => <Link key={l.href + l.label} href={l.href} className="link">{l.label}</Link>)}</p>
            </section>
          ))}

          <section id="preguntas" className="card-dark" style={{ scrollMarginTop: 24 }} aria-labelledby="faq-t">
            <h2 id="faq-t" className="text-[24px]">Preguntas frecuentes</h2>
            <div className="mt-4 grid gap-3">
              {HELP_FAQ.map((f) => (
                <details key={f.q} style={{ borderTop: "1px solid rgba(255,255,255,0.12)", paddingTop: 12 }}>
                  <summary style={{ cursor: "pointer", fontWeight: 500 }}>{f.q}</summary>
                  <p className="muted-dark mt-2">{f.a}</p>
                </details>
              ))}
            </div>
          </section>
        </div>
      </main>
    </div>
  );
}
