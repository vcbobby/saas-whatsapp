import type { Metadata } from "next";
import Link from "next/link";
import { DraftBanner, LegalShell } from "@/components/LegalShell";
import { buildLegalDocs } from "@/lib/legal/docs";

export const metadata: Metadata = { title: "Documentos legales" };

export default function LegalIndexPage() {
  const docs = buildLegalDocs();
  return (
    <LegalShell>
      <h1 className="text-[32px] sm:text-[44px]">Documentos legales</h1>
      <p className="muted-dark mt-3 max-w-xl">Lo que aceptas al usar el servicio y cómo cuidamos tus datos. Están escritos en lenguaje claro.</p>
      <div className="mt-6"><DraftBanner /></div>
      <ul className="mt-8 grid gap-4" style={{ listStyle: "none", padding: 0 }}>
        {docs.map((d) => (
          <li key={d.slug} className="card-dark">
            <h2 className="text-[22px]"><Link href={`/legal/${d.slug}`} className="link">{d.title}</Link></h2>
            <p className="muted-dark mt-1 text-[15px]">{d.summary}</p>
          </li>
        ))}
      </ul>
    </LegalShell>
  );
}
