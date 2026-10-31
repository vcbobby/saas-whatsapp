import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { StoreCart } from "@/components/StoreCart";
import { loadStore } from "@/lib/storefront/load";

type Props = { params: Promise<{ slug: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params;
  const store = await loadStore(slug).catch(() => null);
  return store ? { title: `${store.business} · Catálogo`, description: store.intro ?? `Mira los productos de ${store.business} y pídelos por WhatsApp.` } : { title: "Catálogo" };
}

export default function StorePage({ params }: Props) {
  return (
    <Suspense fallback={<div className="container-app py-24 muted-dark" role="status">Cargando…</div>}>
      <StoreContent params={params} />
    </Suspense>
  );
}

async function StoreContent({ params }: Props) {
  const { slug } = await params;
  const store = await loadStore(slug);
  if (!store) notFound();
  return (
    <main className="container-app pb-16 pt-10" style={{ maxWidth: 880 }}>
      <h1 className="text-[32px] sm:text-[44px]">{store.business}</h1>
      {store.intro && <p className="muted-dark mt-3 max-w-[640px] whitespace-pre-line">{store.intro}</p>}
      <div className="mt-8">
        <StoreCart business={store.business} phone={store.phone} currency={store.currency} products={store.products} />
      </div>
    </main>
  );
}
