import Link from "next/link";
import type { ReactNode } from "react";
import { brand } from "@/config/brand";

export function AuthShell({ eyebrow, title, intro, children }: { eyebrow: string; title: string; intro?: string; children: ReactNode }) {
  return (
    <div className="flex min-h-screen flex-col">
      <header className="container-app flex h-20 items-center">
        <Link href="/" className="text-lg font-medium" style={{ letterSpacing: "-0.01em" }}>
          {brand.name}
        </Link>
      </header>
      <main className="container-app flex flex-1 items-start justify-center pb-24 pt-8 sm:items-center sm:pt-0">
        <section className="card-light w-full" style={{ maxWidth: 480 }} aria-labelledby="auth-title">
          <p className="eyebrow">{eyebrow}</p>
          <h1 id="auth-title" className="mt-3 text-[32px]">
            {title}
          </h1>
          {intro && <p className="muted mt-3">{intro}</p>}
          <div className="mt-8">{children}</div>
        </section>
      </main>
    </div>
  );
}
