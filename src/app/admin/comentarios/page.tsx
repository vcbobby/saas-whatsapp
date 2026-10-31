import type { Metadata } from "next";
import { Suspense } from "react";
import { AppHeader } from "@/components/AppHeader";
import { requireAdminPage } from "@/lib/admin/page";
import { getAdminFeedback } from "@/lib/admin/feedback";

export const metadata: Metadata = { title: "Comentarios" };
const KIND: Record<string, string> = { idea: "Idea", problema: "Problema", otro: "Otro" };

export default function FeedbackPage() {
  return (
    <Suspense fallback={<div className="container-app py-24 muted-dark" role="status">Cargando…</div>}>
      <Content />
    </Suspense>
  );
}

async function Content() {
  const auth = await requireAdminPage();
  const items = await getAdminFeedback(auth.tokenHash);
  return (
    <div className="flex min-h-screen flex-col">
      <AppHeader email={auth.session.email} roleLabel="Súper admin" showAdmin adminMode />
      <main className="container-app flex-1 pb-24 pt-8">
        <p className="eyebrow eyebrow--dark">Solo súper admin</p>
        <h1 className="mt-3 text-[32px] sm:text-[48px]">Comentarios</h1>
        <p className="muted-dark mt-3 max-w-xl text-sm">Lo que escriben los testers desde «Enviar comentario». Lo más reciente primero (hasta 200).</p>
        {items.length === 0 ? <p className="muted-dark mt-8">Todavía no hay comentarios.</p> : (
          <ul className="mt-8 flex flex-col gap-4">
            {items.map((f) => (
              <li key={f.id} className="card p-4">
                <p className="text-[13px] muted-dark">
                  <span className="badge badge-neutral">{KIND[f.kind] ?? f.kind}</span>{" "}
                  {f.business} · {f.email ?? "—"} · {new Date(f.created_at).toLocaleString("es-VE")}{f.page ? ` · ${f.page}` : ""}
                </p>
                <p className="mt-2 whitespace-pre-wrap text-[15px]">{f.message}</p>
              </li>
            ))}
          </ul>
        )}
      </main>
    </div>
  );
}
