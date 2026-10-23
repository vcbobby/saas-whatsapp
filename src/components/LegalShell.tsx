import Link from "next/link";
import type { ReactNode } from "react";
import { brand } from "@/config/brand";
import { buildLegalDocs, LEGAL_UPDATED_LABEL, LEGAL_VERSION } from "@/lib/legal/docs";

/** Enlaces cortos a los documentos legales (pie de página de las pantallas públicas). */
export function LegalLinks({ className = "" }: { className?: string }) {
  return (
    <nav aria-label="Documentos legales" className={`flex flex-wrap gap-x-5 gap-y-2 text-sm ${className}`}>
      <Link href="/legal/terminos" className="link">Términos</Link>
      <Link href="/legal/privacidad" className="link">Privacidad</Link>
      <Link href="/legal/cookies" className="link">Cookies</Link>
      <Link href="/legal" className="link">Todos los documentos</Link>
    </nav>
  );
}

/** Texto con los «[PENDIENTE: …]» resaltados para que no pasen desapercibidos. */
export function Marked({ text }: { text: string }) {
  const parts = text.split(/(\[PENDIENTE:[^\]]*\])/g);
  return <>{parts.map((p, i) => (p.startsWith("[PENDIENTE:") ? <mark key={i} style={{ background: "#ffe38a", color: "#3b2f00", padding: "0 4px", borderRadius: 4 }}>{p}</mark> : <span key={i}>{p}</span>))}</>;
}

export function DraftBanner() {
  if (brand.legalReviewed) return null;
  return (
    <p className="alert-warn" role="note">
      <strong>BORRADOR.</strong> Estos documentos son un punto de partida y todavía no los revisó un abogado. Lo marcado como [PENDIENTE] debe completarse antes de usarlos con clientes reales.
    </p>
  );
}

export function LegalShell({ children, active }: { children: ReactNode; active?: string }) {
  const docs = buildLegalDocs();
  return (
    <div className="flex min-h-screen flex-col">
      <header className="container-app flex h-20 items-center justify-between">
        <Link href="/" className="text-lg font-medium" style={{ letterSpacing: "-0.01em" }}>{brand.name}</Link>
        <Link href="/entrar" className="btn btn-text">Entrar</Link>
      </header>
      <main className="container-app flex-1 pb-20 pt-6">
        <div className="grid gap-10 lg:grid-cols-[260px_minmax(0,1fr)]">
          <nav aria-label="Documentos" className="lg:sticky lg:top-6 lg:self-start">
            <p className="eyebrow eyebrow--dark">Documentos legales</p>
            <ul className="mt-3 grid gap-1" style={{ listStyle: "none", padding: 0 }}>
              {docs.map((d) => (
                <li key={d.slug}>
                  <Link href={`/legal/${d.slug}`} className="link" aria-current={active === d.slug ? "page" : undefined} style={active === d.slug ? { fontWeight: 600 } : undefined}>{d.title}</Link>
                </li>
              ))}
            </ul>
            <p className="muted-dark mt-4 text-[13px]">Versión {LEGAL_VERSION} · {LEGAL_UPDATED_LABEL}</p>
          </nav>
          <div style={{ minWidth: 0 }}>{children}</div>
        </div>
      </main>
    </div>
  );
}
