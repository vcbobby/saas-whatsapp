import Link from "next/link";

export interface EmptyAction { href: string; label: string }

/** «Todavía no hay nada aquí»: explica para qué sirve la pantalla y qué hacer primero. */
export function EmptyState({ title, text, actions = [], help, tone = "light" }: { title: string; text: string; actions?: EmptyAction[]; help?: string; tone?: "light" | "dark" }) {
  return (
    <div className={tone === "light" ? "card-light" : "card-dark"} style={{ maxWidth: 820, padding: 24 }} data-empty-state="">
      <h2 className="text-[22px]">{title}</h2>
      <p className={`${tone === "light" ? "muted" : "muted-dark"} mt-2`}>{text}</p>
      {(actions.length > 0 || help) && (
        <p className="mt-4 flex flex-wrap items-center gap-3">
          {actions.map((a, i) => <Link key={a.href} href={a.href} className={i === 0 ? "btn btn-primary btn-sm" : tone === "light" ? "btn btn-ghost-light btn-sm" : "btn btn-ghost-dark btn-sm"}>{a.label}</Link>)}
          {/* Enlace normal (no <Link>): el salto al apartado funciona al cargar la página completa. */}
          {help && <a href={`/ayuda#${help}`} className="link text-[14px]">¿Cómo funciona?</a>}
        </p>
      )}
    </div>
  );
}
