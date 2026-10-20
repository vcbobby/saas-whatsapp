"use client";

import { useCallback, useEffect, useId, useMemo, useState, type FormEvent } from "react";
import { formatMoney, type Currency } from "@/lib/catalog/money";
import { EmptyState } from "@/components/EmptyState";

type Status = "pendiente" | "confirmado" | "entregado" | "cancelado";
interface Item { name: string; unit: string | null; unitPriceMinor: number; quantity: number; lineTotalMinor: number }
interface Order { id: string; number: number; status: Status; source: "manual" | "agente"; customerName: string; customerPhone: string | null; notes: string | null; deliveryNote: string | null; currency: Currency; totalMinor: number; createdAt: string; items: Item[] }
interface Product { id: string; name: string; unit: string | null; priceMinor: number; stock: number | null; active: boolean }
type Counts = Record<Status, number>;

const STATUS_LABEL: Record<Status, string> = { pendiente: "Por confirmar", confirmado: "Confirmado", entregado: "Entregado", cancelado: "Cancelado" };
const FILTER_LABEL: Record<Status, string> = { pendiente: "Por confirmar", confirmado: "Confirmados", entregado: "Entregados", cancelado: "Cancelados" };
const ORDER: Status[] = ["pendiente", "confirmado", "entregado", "cancelado"];

async function call(url: string, method: string, body?: unknown): Promise<{ ok: boolean; data: Record<string, unknown> }> {
  try {
    const res = await fetch(url, { method, headers: body !== undefined ? { "content-type": "application/json" } : undefined, body: body !== undefined ? JSON.stringify(body) : undefined, cache: "no-store" });
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    return { ok: res.ok, data };
  } catch {
    return { ok: false, data: { message: "No hay conexión con el servidor. Revisa tu internet e intenta de nuevo." } };
  }
}
const msg = (d: Record<string, unknown>, fallback: string) => (typeof d.message === "string" ? d.message : fallback);
const when = (iso: string) => new Intl.DateTimeFormat("es-VE", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit", hour12: true }).format(new Date(iso));

export function OrdersManager() {
  const uid = useId();
  const [filter, setFilter] = useState<Status | null>(null);
  const [orders, setOrders] = useState<Order[] | null>(null);
  const [counts, setCounts] = useState<Counts | null>(null);
  const [more, setMore] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [cancelId, setCancelId] = useState<string | null>(null);
  const [showNew, setShowNew] = useState(false);
  const [catalog, setCatalog] = useState<{ currency: Currency; products: Product[] } | null>(null);

  const load = useCallback(async (f: Status | null, append = false, before?: number) => {
    const qs = new URLSearchParams();
    if (f) qs.set("status", f);
    if (before) qs.set("before", String(before));
    const r = await call(`/api/orders${qs.size ? `?${qs}` : ""}`, "GET");
    if (!r.ok) return setLoadError(true);
    const d = r.data as unknown as { orders: Order[]; counts: Counts; more: boolean };
    setLoadError(false);
    setCounts(d.counts);
    setMore(d.more);
    setOrders((prev) => (append && prev ? [...prev, ...d.orders] : d.orders));
  }, []);

  // Primera carga: se muestra «Por confirmar» si hay algo, y si no «Confirmados».
  useEffect(() => {
    const t = setTimeout(async () => {
      const r = await call("/api/orders?status=pendiente", "GET");
      if (!r.ok) return setLoadError(true);
      const d = r.data as unknown as { orders: Order[]; counts: Counts; more: boolean };
      if (d.counts.pendiente > 0) { setFilter("pendiente"); setOrders(d.orders); setCounts(d.counts); setMore(d.more); }
      else { setFilter("confirmado"); await load("confirmado"); }
    }, 0);
    return () => clearTimeout(t);
  }, [load]);

  useEffect(() => {
    if (!filter) return;
    const t = setInterval(() => { if (document.visibilityState === "visible") void load(filter); }, 15_000);
    return () => clearInterval(t);
  }, [filter, load]);

  async function pick(f: Status) {
    setFilter(f); setOrders(null); setCancelId(null); setError(null);
    await load(f);
  }
  async function act(id: string, action: "confirm" | "deliver" | "cancel") {
    if (busy) return;
    setBusy(true); setError(null);
    const r = await call("/api/orders/update", "POST", { id, action });
    if (!r.ok) setError(msg(r.data, "No se pudo completar la acción."));
    else setCancelId(null);
    await load(filter);
    setBusy(false);
  }
  async function openNew() {
    setShowNew((v) => !v);
    if (!catalog) {
      const r = await call("/api/catalog/config", "GET");
      if (r.ok) setCatalog({ currency: r.data.currency as Currency, products: (r.data.products as Product[]).filter((p) => p.active) });
    }
  }

  if (loadError && !orders) return <p className="alert-error" role="alert">No se pudieron cargar los pedidos. Recarga la página.</p>;
  if (!counts || !filter) return <p className="muted-dark" role="status">Cargando…</p>;

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center gap-3">
        <button type="button" className="btn btn-sm btn-primary" onClick={() => void openNew()}>{showNew ? "Cerrar" : "Nuevo pedido"}</button>
      </div>
      {counts.pendiente > 0 && filter !== "pendiente" && <p className="alert-warn" style={{ maxWidth: 820 }} role="status">Tienes {counts.pendiente} pedido(s) por confirmar.</p>}
      {showNew && (
        <NewOrder uid={uid} catalog={catalog} onCreated={async () => { setShowNew(false); await pick("confirmado"); }} />
      )}
      <div role="group" aria-label="Filtrar pedidos" className="flex flex-wrap gap-2">
        {ORDER.map((s) => (
          <button key={s} type="button" aria-pressed={filter === s} className={`btn btn-sm ${filter === s ? "btn-primary" : "btn-ghost-dark"}`} onClick={() => void pick(s)}>{FILTER_LABEL[s]} · {counts[s]}</button>
        ))}
      </div>
      <div role="alert" aria-live="assertive">{error && <p className="alert-error" style={{ maxWidth: 820 }}>{error}</p>}</div>
      {!orders ? (
        <p className="muted-dark" role="status">Cargando pedidos…</p>
      ) : orders.length === 0 ? (
        <EmptyState title="Aún no hay pedidos en esta lista" text="Los pedidos llegan cuando un cliente pide por WhatsApp o cuando tú los creas. Para que el asistente pueda tomarlos, primero carga tus productos con su precio." actions={[{ href: "/catalogo", label: "Cargar productos" }, { href: "/simulador", label: "Probar el asistente" }]} help="pedidos" />
      ) : (
        <ul className="flex flex-col gap-4" style={{ maxWidth: 820 }} aria-label="Pedidos">
          {orders.map((o) => (
            <li key={o.id} className="card-light" style={{ opacity: o.status === "cancelado" ? 0.75 : 1 }}>
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <p className="text-[20px] font-medium">Pedido #{o.number} · {o.customerName}</p>
                  <p className="muted text-[14px]">{o.customerPhone ? `${o.customerPhone} · ` : ""}{when(o.createdAt)}</p>
                </div>
                <div className="flex flex-col items-end gap-1">
                  <span className="rounded-full px-3 py-1 text-[12px] font-medium" style={o.status === "pendiente" ? { background: "var(--color-signal-yellow)", color: "var(--color-ink)" } : { background: "var(--color-pure-white)", color: "var(--color-ink)", border: "1px solid var(--color-field-border)" }}>{STATUS_LABEL[o.status]}</span>
                  {o.source === "agente" && <span className="muted text-[12px]">Pedido por el asistente</span>}
                </div>
              </div>
              <ul className="mt-4 flex flex-col gap-1" aria-label={`Productos del pedido ${o.number}`}>
                {o.items.map((i, k) => (
                  <li key={k} className="flex flex-wrap justify-between gap-2 text-[14px]">
                    <span>{i.quantity} × {i.name}{i.unit ? ` (${i.unit})` : ""}</span>
                    <span>{formatMoney(i.lineTotalMinor, o.currency)}</span>
                  </li>
                ))}
              </ul>
              <p className="mt-3 text-right font-medium">Total {formatMoney(o.totalMinor, o.currency)}</p>
              {o.deliveryNote && <p className="muted mt-2 text-[14px]">Entrega: {o.deliveryNote}</p>}
              {o.notes && <p className="muted mt-1 text-[14px]">Notas: {o.notes}</p>}
              {(o.status === "pendiente" || o.status === "confirmado") && (
                <div className="mt-4 flex flex-wrap items-center gap-2">
                  {o.status === "pendiente" && <button type="button" className="btn btn-sm btn-primary" disabled={busy} onClick={() => void act(o.id, "confirm")}>Confirmar</button>}
                  {o.status === "confirmado" && <button type="button" className="btn btn-sm btn-primary" disabled={busy} onClick={() => void act(o.id, "deliver")}>Marcar entregado</button>}
                  {cancelId === o.id ? (
                    <span className="flex flex-wrap items-center gap-2" role="group" aria-label="Confirmar cancelación">
                      <span className="text-[14px]">¿Cancelar este pedido?{o.status === "confirmado" ? " Se devuelve el stock." : ""}</span>
                      <button type="button" className="btn btn-sm btn-ghost-light" disabled={busy} onClick={() => void act(o.id, "cancel")}>Sí, cancelar</button>
                      <button type="button" className="btn btn-sm btn-text" style={{ color: "var(--color-ink)", textDecoration: "underline" }} onClick={() => setCancelId(null)}>No</button>
                    </span>
                  ) : (
                    <button type="button" className="btn btn-sm btn-text" style={{ color: "var(--color-ink)", textDecoration: "underline" }} disabled={busy} onClick={() => setCancelId(o.id)}>Cancelar pedido</button>
                  )}
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
      {more && orders && orders.length > 0 && (
        <button type="button" className="btn btn-sm btn-ghost-dark" style={{ alignSelf: "flex-start" }} onClick={() => void load(filter, true, orders[orders.length - 1]!.number)}>Cargar más</button>
      )}
    </div>
  );
}

function NewOrder({ uid, catalog, onCreated }: { uid: string; catalog: { currency: Currency; products: Product[] } | null; onCreated: () => Promise<void> }) {
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [lines, setLines] = useState<{ productId: string; quantity: string }[]>([{ productId: "", quantity: "1" }]);
  const [delivery, setDelivery] = useState("");
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const byId = useMemo(() => new Map((catalog?.products ?? []).map((p) => [p.id, p])), [catalog]);
  const total = lines.reduce((s, l) => {
    const p = byId.get(l.productId); const q = Number(l.quantity);
    return p && Number.isInteger(q) && q > 0 ? s + p.priceMinor * q : s;
  }, 0);

  if (!catalog) return <p className="muted-dark" role="status">Cargando productos…</p>;
  if (catalog.products.length === 0) return <section className="card-light" style={{ maxWidth: 820 }}><p className="muted">Primero agrega productos en el <a className="link" href="/catalogo">Catálogo</a>.</p></section>;

  const setLine = (i: number, patch: Partial<{ productId: string; quantity: string }>) => setLines((ls) => ls.map((l, k) => (k === i ? { ...l, ...patch } : l)));

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    const items = lines.filter((l) => l.productId).map((l) => ({ productId: l.productId, quantity: Number(l.quantity) }));
    if (items.length === 0) return setError("Agrega al menos un producto.");
    if (items.some((i) => !Number.isInteger(i.quantity) || i.quantity < 1)) return setError("Las cantidades deben ser números enteros desde 1.");
    setBusy(true); setError(null);
    const r = await call("/api/orders", "POST", { customerName: name, items, ...(phone.trim() ? { customerPhone: phone } : {}), ...(delivery.trim() ? { deliveryNote: delivery } : {}), ...(notes.trim() ? { notes } : {}) });
    if (r.ok) await onCreated();
    else setError(msg(r.data, "No se pudo crear el pedido."));
    setBusy(false);
  }

  return (
    <section className="card-light" style={{ maxWidth: 820 }} aria-label="Nuevo pedido">
      <h2 className="text-[22px]">Nuevo pedido</h2>
      <p className="muted mt-2 text-[14px]">Se crea confirmado y descuenta el stock de los productos que lo controlan.</p>
      <form onSubmit={submit} className="mt-5 flex flex-col gap-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="field"><label htmlFor={`${uid}-cn`}>Nombre del cliente</label><input id={`${uid}-cn`} className="input" value={name} maxLength={120} required onChange={(e) => setName(e.target.value)} /></div>
          <div className="field"><label htmlFor={`${uid}-cp`}>Teléfono (opcional)</label><input id={`${uid}-cp`} className="input" inputMode="tel" value={phone} maxLength={32} onChange={(e) => setPhone(e.target.value)} placeholder="0414-1234567" /></div>
        </div>
        <fieldset className="flex flex-col gap-3">
          <legend className="mb-2 text-[14px] font-medium">Productos</legend>
          {lines.map((l, i) => {
            const p = byId.get(l.productId);
            return (
              <div key={i} className="grid items-end gap-3 sm:grid-cols-[3fr_1fr_auto]">
                <div className="field">
                  <label htmlFor={`${uid}-lp-${i}`}>Producto</label>
                  <select id={`${uid}-lp-${i}`} className="input" value={l.productId} onChange={(e) => setLine(i, { productId: e.target.value })}>
                    <option value="">Elige un producto</option>
                    {catalog.products.map((x) => <option key={x.id} value={x.id} disabled={x.stock === 0}>{x.name} — {formatMoney(x.priceMinor, catalog.currency)}{x.stock === 0 ? " (agotado)" : ""}</option>)}
                  </select>
                </div>
                <div className="field">
                  <label htmlFor={`${uid}-lq-${i}`}>Cantidad</label>
                  <input id={`${uid}-lq-${i}`} className="input" inputMode="numeric" value={l.quantity} onChange={(e) => setLine(i, { quantity: e.target.value })} />
                </div>
                {lines.length > 1 ? <button type="button" className="btn btn-sm btn-ghost-light" onClick={() => setLines((ls) => ls.filter((_, k) => k !== i))}>Quitar</button> : <span />}
                {p && p.stock !== null && <p className="muted text-[12px] sm:col-span-3">Quedan {p.stock} de {p.name}.</p>}
              </div>
            );
          })}
          <button type="button" className="btn btn-sm btn-ghost-light" style={{ alignSelf: "flex-start" }} onClick={() => setLines((ls) => [...ls, { productId: "", quantity: "1" }])} disabled={lines.length >= 50}>Agregar otro producto</button>
        </fieldset>
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="field"><label htmlFor={`${uid}-cd`}>Entrega (opcional)</label><input id={`${uid}-cd`} className="input" value={delivery} maxLength={300} onChange={(e) => setDelivery(e.target.value)} placeholder="Retira en tienda / dirección" /></div>
          <div className="field"><label htmlFor={`${uid}-cx`}>Notas (opcional)</label><input id={`${uid}-cx`} className="input" value={notes} maxLength={1000} onChange={(e) => setNotes(e.target.value)} /></div>
        </div>
        <p className="font-medium" aria-live="polite">Total: {formatMoney(total, catalog.currency)}</p>
        <div role="alert" aria-live="assertive">{error && <p className="alert-error">{error}</p>}</div>
        <button type="submit" className="btn btn-primary btn-sm" style={{ alignSelf: "flex-start" }} disabled={busy}>{busy ? "Guardando…" : "Crear pedido"}</button>
      </form>
    </section>
  );
}
