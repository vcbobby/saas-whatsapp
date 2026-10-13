"use client";

import { useCallback, useEffect, useId, useMemo, useState, type FormEvent } from "react";
import { CURRENCIES, CURRENCY_INFO, MAX_STOCK, formatMoney, minorToInput, parseMoney, type Currency } from "@/lib/catalog/money";

interface Product { id: string; name: string; description: string | null; unit: string | null; priceMinor: number; stock: number | null; active: boolean }
interface Config { currency: Currency; products: Product[]; canManage: boolean }

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

const PRICE_HINT = "Escribe el precio solo con números, por ejemplo 10 o 10,50.";
/** Stock: vacío = no se controla; si no, un entero de 0 a 1.000.000. undefined = texto inválido. */
function parseStock(s: string): number | null | undefined {
  const t = s.trim();
  if (t === "") return null;
  if (!/^\d{1,7}$/.test(t)) return undefined;
  const n = Number(t);
  return n <= MAX_STOCK ? n : undefined;
}

function StockChip({ stock }: { stock: number | null }) {
  if (stock === null) return <span className="muted text-[12px]">Sin control de stock</span>;
  if (stock === 0) return <span className="rounded-full px-3 py-1 text-[12px] font-medium" style={{ background: "var(--color-signal-yellow)", color: "var(--color-ink)" }}>Agotado</span>;
  return <span className="muted text-[12px]">Quedan {stock}</span>;
}

export function CatalogManager() {
  const uid = useId();
  const [cfg, setCfg] = useState<Config | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [query, setQuery] = useState("");

  const load = useCallback(async () => {
    const r = await call("/api/catalog/config", "GET");
    if (r.ok) setCfg(r.data as unknown as Config);
    else setLoadError(true);
  }, []);
  useEffect(() => {
    const t = setTimeout(() => void load(), 0);
    return () => clearTimeout(t);
  }, [load]);

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (cfg?.products ?? []).filter((p) => !q || p.name.toLowerCase().includes(q));
  }, [cfg, query]);

  if (loadError) return <p className="alert-error" role="alert">No se pudo cargar el catálogo. Recarga la página.</p>;
  if (!cfg) return <p className="muted-dark" role="status">Cargando…</p>;
  const dis = !cfg.canManage;

  return (
    <div className="flex flex-col gap-8">
      {dis && <p className="alert-warn" style={{ maxWidth: 820 }} role="note">Solo dueños y administradores pueden cambiar el catálogo. Tú puedes consultarlo.</p>}
      {!dis && <Currencies uid={uid} currency={cfg.currency} onSaved={load} />}
      {!dis && <NewProduct uid={uid} currency={cfg.currency} onCreated={load} />}
      <section className="card-light" style={{ maxWidth: 820 }} aria-label="Productos">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <h2 className="text-[24px]">Productos</h2>
          {cfg.products.length > 6 && (
            <div className="field" style={{ minWidth: 220 }}>
              <label htmlFor={`${uid}-q`}>Buscar</label>
              <input id={`${uid}-q`} className="input" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Nombre del producto" />
            </div>
          )}
        </div>
        {cfg.products.length === 0 && <p className="muted mt-4">Todavía no tienes productos.{!dis && " Agrega el primero arriba."}</p>}
        {cfg.products.length > 0 && shown.length === 0 && <p className="muted mt-4" role="status">Ningún producto coincide con la búsqueda.</p>}
        <ul className="mt-5 flex flex-col gap-3" aria-label="Lista de productos">
          {shown.map((p) => <Row key={p.id} uid={uid} p={p} currency={cfg.currency} disabled={dis} onChanged={load} />)}
        </ul>
      </section>
    </div>
  );
}

function Currencies({ uid, currency, onSaved }: { uid: string; currency: Currency; onSaved: () => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function change(c: Currency) {
    if (busy || c === currency) return;
    setBusy(true); setError(null);
    const r = await call("/api/catalog/settings", "PUT", { currency: c });
    if (!r.ok) setError(msg(r.data, "No se pudo guardar la moneda."));
    await onSaved();
    setBusy(false);
  }
  return (
    <section className="card-light" style={{ maxWidth: 820 }}>
      <h2 className="text-[24px]">Moneda</h2>
      <p className="muted mt-2 text-[14px]">Es la moneda de todos tus precios. Cambiarla no convierte los montos: solo cambia el símbolo.</p>
      <div className="field mt-4" style={{ maxWidth: 320 }}>
        <label htmlFor={`${uid}-cur`}>Moneda de los precios</label>
        <select id={`${uid}-cur`} className="input" value={currency} disabled={busy} onChange={(e) => void change(e.target.value as Currency)}>
          {CURRENCIES.map((c) => <option key={c} value={c}>{CURRENCY_INFO[c].label}</option>)}
        </select>
      </div>
      <div role="alert" aria-live="assertive">{error && <p className="alert-error mt-3">{error}</p>}</div>
    </section>
  );
}

function NewProduct({ uid, currency, onCreated }: { uid: string; currency: Currency; onCreated: () => Promise<void> }) {
  const [name, setName] = useState("");
  const [price, setPrice] = useState("");
  const [unit, setUnit] = useState("");
  const [stock, setStock] = useState("");
  const [desc, setDesc] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function add(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    const priceMinor = parseMoney(price);
    if (priceMinor === null) return setError(PRICE_HINT);
    const st = parseStock(stock);
    if (st === undefined) return setError("El stock debe ser un número entero, o déjalo vacío si no lo controlas.");
    setBusy(true); setError(null);
    const r = await call("/api/catalog/products", "POST", { name, priceMinor, ...(unit.trim() ? { unit } : {}), ...(desc.trim() ? { description: desc } : {}), stock: st });
    if (r.ok) { setName(""); setPrice(""); setUnit(""); setStock(""); setDesc(""); await onCreated(); }
    else setError(msg(r.data, "No se pudo agregar el producto."));
    setBusy(false);
  }

  return (
    <section className="card-light" style={{ maxWidth: 820 }} aria-label="Nuevo producto">
      <h2 className="text-[24px]">Nuevo producto</h2>
      <form onSubmit={add} className="mt-5 flex flex-col gap-4">
        <div className="grid gap-4 sm:grid-cols-[2fr_1fr]">
          <div className="field">
            <label htmlFor={`${uid}-pn`}>Nombre</label>
            <input id={`${uid}-pn`} className="input" value={name} maxLength={120} required onChange={(e) => setName(e.target.value)} placeholder="Harina de maíz" />
          </div>
          <div className="field">
            <label htmlFor={`${uid}-pp`}>Precio ({CURRENCY_INFO[currency].prefix.trim()})</label>
            <input id={`${uid}-pp`} className="input" inputMode="decimal" value={price} required onChange={(e) => setPrice(e.target.value)} placeholder="10,50" />
          </div>
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="field">
            <label htmlFor={`${uid}-pu`}>Presentación (opcional)</label>
            <input id={`${uid}-pu`} className="input" value={unit} maxLength={40} onChange={(e) => setUnit(e.target.value)} placeholder="paquete de 1 kg" />
          </div>
          <div className="field">
            <label htmlFor={`${uid}-ps`}>Stock (vacío = sin control)</label>
            <input id={`${uid}-ps`} className="input" inputMode="numeric" value={stock} onChange={(e) => setStock(e.target.value)} placeholder="20" />
          </div>
        </div>
        <div className="field">
          <label htmlFor={`${uid}-pd`}>Descripción (opcional)</label>
          <textarea id={`${uid}-pd`} className="input" rows={2} maxLength={500} value={desc} onChange={(e) => setDesc(e.target.value)} />
        </div>
        <div role="alert" aria-live="assertive">{error && <p className="alert-error">{error}</p>}</div>
        <button type="submit" className="btn btn-primary btn-sm" style={{ alignSelf: "flex-start" }} disabled={busy}>{busy ? "Guardando…" : "Agregar producto"}</button>
      </form>
    </section>
  );
}

function Row({ uid, p, currency, disabled, onChanged }: { uid: string; p: Product; currency: Currency; disabled: boolean; onChanged: () => Promise<void> }) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(p.name);
  const [price, setPrice] = useState(minorToInput(p.priceMinor));
  const [unit, setUnit] = useState(p.unit ?? "");
  const [stock, setStock] = useState(p.stock === null ? "" : String(p.stock));
  const [desc, setDesc] = useState(p.description ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function open() {
    setName(p.name); setPrice(minorToInput(p.priceMinor)); setUnit(p.unit ?? ""); setStock(p.stock === null ? "" : String(p.stock)); setDesc(p.description ?? "");
    setError(null); setEditing(true);
  }
  async function patch(body: Record<string, unknown>): Promise<boolean> {
    setBusy(true); setError(null);
    const r = await call("/api/catalog/products/update", "POST", { id: p.id, ...body });
    if (!r.ok) setError(msg(r.data, "No se pudo guardar."));
    await onChanged();
    setBusy(false);
    return r.ok;
  }
  async function save(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    const priceMinor = parseMoney(price);
    if (priceMinor === null) return setError(PRICE_HINT);
    const st = parseStock(stock);
    if (st === undefined) return setError("El stock debe ser un número entero, o déjalo vacío si no lo controlas.");
    if (await patch({ name, priceMinor, unit: unit.trim() || null, description: desc.trim() || null, stock: st })) setEditing(false);
  }

  return (
    <li className="rounded-[16px] p-4" style={{ background: "var(--color-pure-white)", border: "1px solid var(--color-field-border)", opacity: p.active ? 1 : 0.7 }}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="font-medium">{p.name}{!p.active && " (desactivado)"}</p>
          <p className="muted text-[14px]">{formatMoney(p.priceMinor, currency)}{p.unit ? ` · ${p.unit}` : ""}</p>
          {p.description && <p className="muted mt-1 text-[14px]">{p.description}</p>}
          <p className="mt-1"><StockChip stock={p.stock} /></p>
        </div>
        {!disabled && !editing && (
          <div className="flex flex-wrap items-center gap-2">
            <button type="button" className="btn btn-sm btn-ghost-light" disabled={busy} onClick={open}>Editar</button>
            <button type="button" className="btn btn-sm btn-ghost-light" disabled={busy} onClick={() => void patch({ active: !p.active })}>{p.active ? "Desactivar" : "Activar"}</button>
          </div>
        )}
      </div>
      <div role="alert" aria-live="assertive">{!editing && error && <p className="alert-error mt-3">{error}</p>}</div>
      {editing && (
        <form onSubmit={save} className="mt-4 flex flex-col gap-4">
          <div className="grid gap-4 sm:grid-cols-[2fr_1fr]">
            <div className="field"><label htmlFor={`${uid}-en-${p.id}`}>Nombre</label><input id={`${uid}-en-${p.id}`} className="input" value={name} maxLength={120} required onChange={(e) => setName(e.target.value)} /></div>
            <div className="field"><label htmlFor={`${uid}-ep-${p.id}`}>Precio</label><input id={`${uid}-ep-${p.id}`} className="input" inputMode="decimal" value={price} required onChange={(e) => setPrice(e.target.value)} /></div>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="field"><label htmlFor={`${uid}-eu-${p.id}`}>Presentación</label><input id={`${uid}-eu-${p.id}`} className="input" value={unit} maxLength={40} onChange={(e) => setUnit(e.target.value)} /></div>
            <div className="field"><label htmlFor={`${uid}-es-${p.id}`}>Stock (vacío = sin control)</label><input id={`${uid}-es-${p.id}`} className="input" inputMode="numeric" value={stock} onChange={(e) => setStock(e.target.value)} /></div>
          </div>
          <div className="field"><label htmlFor={`${uid}-ed-${p.id}`}>Descripción</label><textarea id={`${uid}-ed-${p.id}`} className="input" rows={2} maxLength={500} value={desc} onChange={(e) => setDesc(e.target.value)} /></div>
          <div role="alert" aria-live="assertive">{error && <p className="alert-error">{error}</p>}</div>
          <div className="flex flex-wrap gap-2">
            <button type="submit" className="btn btn-primary btn-sm" disabled={busy}>{busy ? "Guardando…" : "Guardar"}</button>
            <button type="button" className="btn btn-sm btn-ghost-light" disabled={busy} onClick={() => setEditing(false)}>Cancelar</button>
          </div>
        </form>
      )}
    </li>
  );
}
