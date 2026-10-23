import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { DraftBanner, LegalShell, Marked } from "@/components/LegalShell";
import { buildLegalDocs, LEGAL_SLUGS, LEGAL_UPDATED_LABEL, LEGAL_VERSION } from "@/lib/legal/docs";

export function generateStaticParams() {
  return LEGAL_SLUGS.map((slug) => ({ slug }));
}

export async function generateMetadata({ params }: PageProps<"/legal/[slug]">): Promise<Metadata> {
  const { slug } = await params;
  const doc = buildLegalDocs().find((d) => d.slug === slug);
  return { title: doc?.title ?? "Documento legal" };
}

export default function LegalDocPage(props: PageProps<"/legal/[slug]">) {
  return (
    <Suspense fallback={<div className="container-app py-24 muted-dark" role="status">Cargando…</div>}>
      <LegalDocContent params={props.params} />
    </Suspense>
  );
}

async function LegalDocContent({ params }: { params: PageProps<"/legal/[slug]">["params"] }) {
  const { slug } = await params;
  const doc = buildLegalDocs().find((d) => d.slug === slug);
  if (!doc) notFound();
  return (
    <LegalShell active={doc.slug}>
      <article>
        <h1 className="text-[32px] sm:text-[44px]">{doc.title}</h1>
        <p className="muted-dark mt-2 text-[14px]">Versión {LEGAL_VERSION} · actualizado el {LEGAL_UPDATED_LABEL}</p>
        <div className="mt-6"><DraftBanner /></div>
        <nav aria-label="En este documento" className="card-dark mt-6">
          <p className="eyebrow eyebrow--dark">En este documento</p>
          <ol className="mt-3 grid gap-1" style={{ paddingLeft: 18 }}>
            {doc.sections.map((s) => <li key={s.id}><a href={`#${s.id}`} className="link">{s.heading.replace(/^\d+\.\s*/, "")}</a></li>)}
          </ol>
        </nav>
        {doc.sections.map((s) => (
          <section key={s.id} id={s.id} className="mt-10" style={{ scrollMarginTop: 24 }}>
            <h2 className="text-[24px]">{s.heading}</h2>
            <div className="mt-3 grid gap-3" style={{ lineHeight: 1.65 }}>
              {s.body.map((b, i) =>
                typeof b === "string" ? (
                  <p key={i}><Marked text={b} /></p>
                ) : (
                  <ul key={i} className="grid gap-2" style={{ paddingLeft: 22, listStyle: "disc" }}>
                    {b.list.map((l, j) => <li key={j}><Marked text={l} /></li>)}
                  </ul>
                ),
              )}
            </div>
          </section>
        ))}
      </article>
    </LegalShell>
  );
}
