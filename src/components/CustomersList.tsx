"use client";

import Link from "next/link";
import { useCallback, useEffect, useId, useState } from "react";
import { EmptyState } from "@/components/EmptyState";
import { CONTACT_LABEL_TEXT, CONTACT_LABELS, type ContactLabel } from "@/lib/work/labels";

interface Customer { id: string; name: string | null; waId: string; label: ContactLabel; tags: string[]; optedOut: boolean; consent: boolean; createdAt: string; lastMessageAt: string | null; orders: number; appointments: number }
interface Page { total: number; more: boolean; tags: { tag: string; count: number }[]; customers: Customer[] }

const chip = { background: "var(--color-pure-white)", color: "var(--color-ink)", border: "1px solid var(--color-field-border)" } as const;
const when = (iso: string) => new Intl.DateTimeFormat("es-VE", { day: "numeric", month: "short", year: "numeric" }).format(new Date(iso));
const short = (l: ContactLabel) => CONTACT_LABEL_TEXT[l].replace(" (el asistente no responde)", "");

export function CustomersList({ canExport }: { canExport: boolean }) {
  const uid = useId();
  const [text, setText] = useState("");
  const [q, setQ] = useState("");
  const [tag, setTag] = useState("");
  const [label, setLabel] = useState<ContactLabel | "">("");
  const [baja, setBaja] = useState(false);
  const [permiso, setPermiso] = useState<"" | "si" | "no">("");
  const [page, setPage] = useState(1);
  const [data, setData] = useState<Page | null>(null);
  const [error, setError] = useState(false);

  // La búsqueda espera un instante a que termines de escribir.
  useEffect(() => {
    const t = setTimeout(() => { setQ(text.trim()); setPage(1); }, 300);
    return () => clearTimeout(t);
  }, [text]);

  const load = useCallback(async () => {
    const p = new URLSearchParams();
    if (q) p.set("q", q);
    if (tag) p.set("tag", tag);
    if (label) p.set("label", label);
    if (baja) p.set("baja", "1");
    if (permiso) p.set("permiso", permiso);
    if (page > 1) p.set("page", String(page));
    try {
      const res = await fetch(`/api/customers${p.size ? `?${p}` : ""}`, { cache: "no-store" });
      if (!res.ok) return setError(true);
      setError(false);
      setData((await res.json()) as Page);
    } catch { setError(true); }
  }, [q, tag, label, baja, permiso, page]);

  useEffect(() => {
    const t = setTimeout(() => void load(), 0);
    return () => clearTimeout(t);
  }, [load]);

  const filtered = Boolean(q || tag || label || baja || permiso);
  const reset = () => { setText(""); setQ(""); setTag(""); setLabel(""); setBaja(false); setPermiso(""); setPage(1); };

  return (
    <div>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4" role="search">
        <div className="field sm:col-span-2">
          <label htmlFor={`${uid}-q`} style={{ color: "rgba(255,255,255,0.78)" }}>Buscar por nombre o teléfono</label>
          <input id={`${uid}-q`} className="input" type="search" value={text} maxLength={60} onChange={(e) => setText(e.target.value)} placeholder="Ej. María o 58412" autoComplete="off" />
        </div>
        <div className="field">
          <label htmlFor={`${uid}-tag`} style={{ color: "rgba(255,255,255,0.78)" }}>Etiqueta</label>
          <select id={`${uid}-tag`} className="input" value={tag} onChange={(e) => { setTag(e.target.value); setPage(1); }}>
            <option value="">Todas</option>
            {data?.tags.map((t) => <option key={t.tag} value={t.tag}>{t.tag} ({t.count})</option>)}
          </select>
        </div>
        <div className="field">
          <label htmlFor={`${uid}-lab`} style={{ color: "rgba(255,255,255,0.78)" }}>Tipo de contacto</label>
          <select id={`${uid}-lab`} className="input" value={label} onChange={(e) => { setLabel(e.target.value as ContactLabel | ""); setPage(1); }}>
            <option value="">Todos</option>
            {CONTACT_LABELS.map((l) => <option key={l} value={l}>{short(l)}</option>)}
          </select>
        </div>
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-4">
        <label className="flex items-center gap-2 text-[14px]" style={{ color: "rgba(255,255,255,0.78)" }}>
          Permiso para promociones
          <select className="input" style={{ width: "auto" }} value={permiso} onChange={(e) => { setPermiso(e.target.value as "" | "si" | "no"); setPage(1); }}>
            <option value="">Todos</option><option value="si">Con permiso</option><option value="no">Sin permiso</option>
          </select>
        </label>
        <label className="flex items-center gap-2 text-[14px]" style={{ color: "rgba(255,255,255,0.78)" }}>
          <input type="checkbox" checked={baja} onChange={(e) => { setBaja(e.target.checked); setPage(1); }} />
          Solo quienes pidieron no recibir avisos
        </label>
        {filtered && <button type="button" className="btn btn-text btn-sm" style={{ color: "#fff", textDecoration: "underline" }} onClick={reset}>Quitar filtros</button>}
        {canExport && <a href="/api/export?que=clientes&formato=excel" className="link text-[14px]" style={{ color: "#fff" }}>Descargar en Excel</a>}
      </div>

      <div className="mt-6" aria-live="polite">
        {error ? (
          <p className="alert-error" role="alert">No pudimos cargar los clientes. <button type="button" className="link" onClick={() => void load()}>Reintentar</button></p>
        ) : !data ? (
          <p className="muted-dark" role="status">Cargando…</p>
        ) : data.customers.length === 0 ? (
          filtered
            ? <EmptyState tone="dark" title="Nadie coincide con esa búsqueda" text="Prueba con otro nombre o quita los filtros." />
            : <EmptyState tone="dark" title="Aún no tienes clientes" text="Cada persona que te escribe por WhatsApp aparece aquí con su historial. También se crean al importar o al probar el asistente." actions={[{ href: "/whatsapp", label: "Conectar WhatsApp" }, { href: "/simulador", label: "Probar el asistente" }]} help="clientes" />
        ) : (
          <>
            <p className="muted-dark text-[14px]">{data.total} {data.total === 1 ? "cliente" : "clientes"}</p>
            <ul className="mt-3 grid gap-3">
              {data.customers.map((c) => (
                <li key={c.id}>
                  <Link href={`/clientes/${c.id}`} className="card-light block" style={{ padding: 16 }}>
                    <div className="flex flex-wrap items-baseline justify-between gap-2">
                      <strong className="text-[18px]">{c.name ?? `+${c.waId}`}</strong>
                      <span className="muted text-[13px]">{c.lastMessageAt ? `Último mensaje: ${when(c.lastMessageAt)}` : `Desde ${when(c.createdAt)}`}</span>
                    </div>
                    <p className="muted mt-1 text-[14px]">
                      {c.name ? `+${c.waId} · ` : ""}{c.orders} {c.orders === 1 ? "pedido" : "pedidos"} · {c.appointments} {c.appointments === 1 ? "cita" : "citas"}
                    </p>
                    {(c.tags.length > 0 || c.label !== "sin_clasificar" || c.optedOut || c.consent) && (
                      <p className="mt-2 flex flex-wrap gap-2">
                        {c.label !== "sin_clasificar" && <span className="badge" style={chip}>{short(c.label)}</span>}
                        {c.tags.map((t) => <span key={t} className="badge" style={chip}>#{t}</span>)}
                        {c.consent && <span className="badge" style={chip}>Acepta promociones</span>}
                        {c.optedOut && <span className="badge" style={chip}>No recibir avisos</span>}
                      </p>
                    )}
                  </Link>
                </li>
              ))}
            </ul>
            {(page > 1 || data.more) && (
              <p className="mt-5 flex items-center gap-3">
                <button type="button" className="btn btn-sm btn-ghost-dark" disabled={page <= 1} onClick={() => setPage(page - 1)}>← Anterior</button>
                <span className="muted-dark text-[14px]">Página {page}</span>
                <button type="button" className="btn btn-sm btn-ghost-dark" disabled={!data.more} onClick={() => setPage(page + 1)}>Siguiente →</button>
              </p>
            )}
          </>
        )}
      </div>
    </div>
  );
}
