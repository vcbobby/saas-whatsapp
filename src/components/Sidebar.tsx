"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useId, useState, type ReactNode } from "react";
import { topicForPath } from "@/lib/help";
import { isActive, type NavGroup, type NavIcon } from "@/lib/nav";

const PATHS: Record<NavIcon, string> = {
  home: "M3 11l9-8 9 8M5 10v10h5v-6h4v6h5V10",
  chat: "M4 5h16v11H9l-5 4z",
  today: "M5 4h14v16H5zM9 9l2 2 4-4M9 15h6",
  calendar: "M4 6h16v14H4zM4 10h16M8 3v4M16 3v4",
  box: "M3 8l9-5 9 5v8l-9 5-9-5zM3 8l9 5 9-5M12 13v8",
  receipt: "M6 3h12v18l-3-2-3 2-3-2-3 2zM9 8h6M9 12h6",
  bot: "M5 8h14v10H5zM12 4v4M9 13h.01M15 13h.01M3 12v3M21 12v3",
  book: "M5 4h10a3 3 0 013 3v13H8a3 3 0 01-3-3zM5 17a3 3 0 013-3h10",
  flask: "M9 3h6M10 3v6l-5 9a2 2 0 002 3h10a2 2 0 002-3l-5-9V3",
  wand: "M4 20L15 9M14 4v3M12.5 5.5h3M19 11v3M17.5 12.5h3M7 4v2M6 5h2",
  phone: "M7 3h10v18H7zM11 18h2",
  bolt: "M13 3L5 13h6l-1 8 8-10h-6z",
  plug: "M9 3v5M15 3v5M6 8h12v3a6 6 0 01-12 0zM12 17v4",
  users: "M9 11a3 3 0 100-6 3 3 0 000 6zM3 20c0-3 3-5 6-5s6 2 6 5M17 8a2.5 2.5 0 110 5M17 15c2.5 0 4 1.5 4 4",
  chart: "M4 20V10m6 10V4m6 16v-7m4 7H2",
  store: "M4 9l1.5-5h13L20 9M4 9v11h16V9M4 9a2.7 2.7 0 005.3 0 2.7 2.7 0 005.4 0A2.7 2.7 0 0020 9M9.5 20v-5h5v5",
  tag: "M3 12V4h8l10 10-8 8L3 12zm5-4h.01",
  help: "M12 21a9 9 0 100-18 9 9 0 000 18zM9.6 9.3a2.4 2.4 0 114 1.5c-.8.6-1.6 1-1.6 2.2M12 16.6h.01",
  user: "M12 12a4 4 0 100-8 4 4 0 000 8zM4 21c0-4 3.6-6 8-6s8 2 8 6",
  card: "M3 6h18v12H3zM3 10h18M7 15h3",
  shield: "M12 3l8 3v6c0 4.5-3.2 8-8 9-4.8-1-8-4.5-8-9V6z",
  gear: "M12 9a3 3 0 100 6 3 3 0 000-6zM19 12l2-1-1-3-2 .5-1.5-1.5.5-2-3-1-1 2h-2l-1-2-3 1 .5 2L6 8.5 4 8l-1 3 2 1v1l-2 1 1 3 2-.5L7.5 18l-.5 2 3 1 1-2h2l1 2 3-1-.5-2 1.5-1.5 2 .5 1-3-2-1z",
};

function Icon({ name }: { name: NavIcon }) {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="side-icon">
      <path d={PATHS[name]} />
    </svg>
  );
}

/** Menú lateral (escritorio) y cajón (celular). */
export function Sidebar({ brandName, groups, footer }: { brandName: string; groups: NavGroup[]; footer: ReactNode }) {
  const pathname = usePathname();
  const help = topicForPath(pathname);
  const navId = useId();
  // El cajón se cierra solo al cambiar de página: se guarda en qué página se abrió.
  const [openAt, setOpenAt] = useState<string | null>(null);
  const open = openAt === pathname;

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpenAt(null); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);

  return (
    <>
      <div className="app-topbar">
        <Link href="/panel" className="app-brand">{brandName}</Link>
        <button type="button" className="btn btn-ghost-dark btn-sm" aria-expanded={open} aria-controls={navId} onClick={() => setOpenAt(open ? null : pathname)}>
          {open ? "Cerrar" : "Menú"}
        </button>
      </div>
      {open && <button type="button" className="app-scrim" aria-label="Cerrar el menú" onClick={() => setOpenAt(null)} />}
      <aside id={navId} className="app-sidebar" data-open={open ? "true" : "false"} aria-label="Menú principal">
        <Link href="/panel" className="app-brand app-brand--side">{brandName}</Link>
        <nav className="app-nav">
          {groups.map((g, gi) => (
            <div key={g.title ?? `g${gi}`} className="app-group">
              {g.title && <p className="app-group-title">{g.title}</p>}
              <ul>
                {g.items.map((it) => {
                  const active = isActive(it.href, pathname, it.exact);
                  return (
                    <li key={it.href}>
                      <Link href={it.href} className="app-item" aria-current={active ? "page" : undefined}>
                        <Icon name={it.icon} />
                        <span className="app-item-text">
                          <span className="app-item-label">{it.label}</span>
                          <span className="app-item-hint">{it.hint}</span>
                        </span>
                      </Link>
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
        </nav>
        {help && (
          <a href={`/ayuda#${help.id}`} style={{ display: "block", margin: "0 8px 10px", padding: "8px 12px", borderRadius: 12, border: "1px dashed rgba(255,255,255,0.28)", fontSize: 13, color: "rgba(255,255,255,0.86)" }}>
            ¿Cómo funciona «{help.title}»?
          </a>
        )}
        <div className="app-footer">{footer}</div>
      </aside>
    </>
  );
}
