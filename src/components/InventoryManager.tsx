"use client";

import { useCallback, useEffect, useId, useState, type FormEvent } from "react";

type Status = "agotado" | "bajo" | "ok" | "sin_control";
interface Row { id: string; name: string; unit: string | null; stock: number | null; minStock: number | null; status: Status }
interface Summary { tracked: number; low: number; out: number; untracked: number }
interface Data { rows: Row[]; summary: Summary; canManage: boolean }
interface Move { id: string; kind: string; delta: number; stockAfter: number; note: string | null; orderNumber: number | null; actor: "yo" | "equipo" | "sistema"; at: string }
type Filter = "all" | "low" | "out" | "untracked";

async function call(url: string, method = "GET", body?: unknown): Promise<{ ok: boolean; data: Record<string, unknown> }> {
  try {
    const res = await fetch(url, { method, headers: body !== undefined ? { "content-type": "application/json" } : undefined, body: body !== undefined ? JSON.stringify(body) : undefined, cache: "no-store" });
    return { ok: res.ok, data: (await res.json().catch(() => ({}))) as Record<string, unknown> };
  } catch {
    return { ok: false, data: { message: "No hay conexión con el servidor. Revisa tu internet e intenta de nuevo." } };
  }
}
const msg = (d: Record<string, unknown>, fallback: string) => (typeof d.message === "string" ? d.message : fallback);

const KIND: Record<string, string> = { inicial: "Stock inicial", entrada: "Entrada", salida: "Salida", merma: "Merma", ajuste: "Conteo", pedido: "Pedido", devolucion: "Devolución", edicion: "Edición" };
const ACTOR = { yo: "Tú", equipo: "Tu equipo", sistema: "Automático" } as const;
const FILTERS: Array<[Filter, string]> = [["all", "Todos"], ["low", "Poco stock"], ["out", "Agotados"], ["untracked", "Sin control"]];

function Badge({ s }: { s: Status }) {
  if (s === "agotado") return <span className="rounded-full px-3 py-1 text-[12px] font-medium" style={{ background: "var(--color-signal-yellow)", color: "var(--color-ink)" }}>Agotado</span>;
  if (s === "bajo") return <span className="rounded-full px-3 py-1 text-[12px] font-medium" style={{ background: "var(--color-mint-frost)", color: "var(--color-ink)", border: "1px solid var(--color-fog-border)" }}>Poco stock</span>;
  if (s === "sin_control") return <span className="muted text-[12px]">Sin control</span>;
  return <span className="muted text-[12px]">Normal</span>;
}

export function InventoryManager() {
  const uid = useId();
  const [data, setData] = useState<Data | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [filter, setFilter] = useState<Filter>("all");
  const [q, setQ] = useState("");
  const [open, setOpen] = useState<string | null>(null);

  const load = useCallback(async () => {
    const r = await call(`/api/inventory?filter=${filter}&q=${encodeURIComponent(q.trim())}`);
    if (r.ok) { setData(r.data as unknown as Data); setLoadError(false); } else setLoadError(true);
  }, [filter, q]);
  useEffect(() => {
    const t = setTimeout(() => void load(), q ? 250 : 0);
    return () => clearTimeout(t);
  }, [load, q]);

  if (loadError && !data) return <p className="alert-error" role="alert">No se pudo cargar el inventario. Recarga la página.</p>;
  if (!data) return <p className="muted-dark" role="status">Cargando…</p>;
  const s = data.summary;

  return (
    <div className="flex flex-col gap-8">
      <section className="grid gap-3 sm:grid-cols-4" aria-label="Resumen" style={{ maxWidth: 820 }}>
        <Tile label="Con control" value={s.tracked} />
        <Tile label="Poco stock" value={s.low} warn={s.low > 0} />
        <Tile label="Agotados" value={s.out} warn={s.out > 0} />
        <Tile label="Sin control" value={s.untracked} />
      </section>

      <section className="card-light" style={{ maxWidth: 820 }} aria-label="Productos">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div className="flex flex-wrap gap-2" role="group" aria-label="Filtrar">
            {FILTERS.map(([f, label]) => (
              <button key={f} type="button" className={filter === f ? "btn btn-primary btn-sm" : "btn btn-ghost-light btn-sm"} aria-pressed={filter === f} onClick={() => setFilter(f)}>{label}</button>
            ))}
          </div>
          <div className="field" style={{ minWidth: 200 }}>
            <label htmlFor={`${uid}-q`}>Buscar</label>
            <input id={`${uid}-q`} className="input" value={q} maxLength={100} onChange={(e) => setQ(e.target.value)} placeholder="Nombre del producto" />
          </div>
        </div>
        {data.canManage && (
          <p className="mt-4 text-[14px]">
            Descargar: <a className="link" href="/api/inventory/export?que=stock">existencias (CSV)</a> · <a className="link" href="/api/inventory/export?que=movimientos">movimientos (CSV)</a>
          </p>
        )}
        {data.rows.length === 0 && <p className="muted mt-4" role="status">{s.tracked + s.untracked === 0 ? "Todavía no tienes productos. Agrégalos en el Catálogo." : "Ningún producto coincide."}</p>}
        <ul className="mt-5 flex flex-col gap-3" aria-label="Lista de inventario">
          {data.rows.map((p) => (
            <Item key={p.id} p={p} canManage={data.canManage} open={open === p.id} onToggle={() => setOpen(open === p.id ? null : p.id)} onChanged={load} />
          ))}
        </ul>
      </section>
    </div>
  );
}

function Tile({ label, value, warn }: { label: string; value: number; warn?: boolean }) {
  return (
    <div className="card-light" style={warn ? { borderColor: "var(--color-signal-yellow)" } : undefined}>
      <p className="muted text-[12px]">{label}</p>
      <p className="text-[28px]">{value}</p>
    </div>
  );
}

function Item({ p, canManage, open, onToggle, onChanged }: { p: Row; canManage: boolean; open: boolean; onToggle: () => void; onChanged: () => Promise<void> }) {
  const uid = useId();
  const [mode, setMode] = useState<"entrada" | "salida" | "merma" | "conteo">(p.stock === null ? "conteo" : "entrada");
  const [qty, setQty] = useState("");
  const [note, setNote] = useState("");
  const [minTxt, setMinTxt] = useState(p.minStock === null ? "" : String(p.minStock));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);
  const [moves, setMoves] = useState<Move[] | null>(null);

  const loadMoves = useCallback(async () => {
    const r = await call(`/api/inventory/movements?productId=${p.id}`);
    setMoves(r.ok ? ((r.data.movements as Move[]) ?? []) : []);
  }, [p.id]);
  useEffect(() => {
    if (!open) return;
    const t = setTimeout(() => void loadMoves(), 0);
    return () => clearTimeout(t);
  }, [open, loadMoves]);

  async function adjust(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    setError(null); setOk(null);
    const t = qty.trim();
    if (!/^\d{1,7}$/.test(t)) return setError("Escribe un número entero, sin decimales.");
    setBusy(true);
    const r = await call("/api/inventory/adjust", "POST", { productId: p.id, mode, quantity: Number(t), note: note.trim() || undefined });
    setBusy(false);
    if (!r.ok) return setError(msg(r.data, "No se pudo guardar el ajuste."));
    setOk(r.data.changed === false ? "Sin cambios: ya había esa cantidad." : `Listo. Ahora hay ${String(r.data.stock)}.`);
    setQty(""); setNote("");
    await Promise.all([onChanged(), loadMoves()]);
  }
  async function saveMin() {
    if (busy) return;
    setError(null); setOk(null);
    const t = minTxt.trim();
    if (t !== "" && !/^\d{1,7}$/.test(t)) return setError("El aviso debe ser un número entero (o vacío para usar el general).");
    setBusy(true);
    const r = await call("/api/inventory/min", "POST", { productId: p.id, minStock: t === "" ? null : Number(t) });
    setBusy(false);
    if (!r.ok) return setError(msg(r.data, "No se pudo guardar."));
    setOk("Aviso guardado.");
    await onChanged();
  }

  return (
    <li className="rounded-2xl border p-4" style={{ borderColor: "var(--color-fog-border)" }}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="font-medium">{p.name}{p.unit ? <span className="muted"> · {p.unit}</span> : null}</p>
          <p className="muted text-[13px]">{p.stock === null ? "No se controla el stock" : `Hay ${p.stock}${p.minStock !== null ? ` · avisar cuando queden ${p.minStock}` : ""}`}</p>
        </div>
        <div className="flex items-center gap-3">
          <Badge s={p.status} />
          <button type="button" className="btn btn-ghost-light btn-sm" aria-expanded={open} onClick={onToggle}>{open ? "Cerrar" : canManage ? "Ajustar / historial" : "Historial"}</button>
        </div>
      </div>
      {open && (
        <div className="mt-4 flex flex-col gap-4">
          {canManage && (
            <form onSubmit={adjust} className="flex flex-wrap items-end gap-3" aria-label={`Ajustar ${p.name}`}>
              <div className="field">
                <label htmlFor={`${uid}-m`}>Qué pasó</label>
                <select id={`${uid}-m`} className="input" value={mode} onChange={(e) => setMode(e.target.value as typeof mode)}>
                  {p.stock !== null && <option value="entrada">Entró mercancía (suma)</option>}
                  {p.stock !== null && <option value="salida">Salió (resta)</option>}
                  {p.stock !== null && <option value="merma">Merma o pérdida (resta)</option>}
                  <option value="conteo">{p.stock === null ? "Empezar a controlar: hay…" : "Conteo: en el estante hay…"}</option>
                </select>
              </div>
              <div className="field" style={{ width: 120 }}>
                <label htmlFor={`${uid}-q`}>Cantidad</label>
                <input id={`${uid}-q`} className="input" inputMode="numeric" value={qty} onChange={(e) => setQty(e.target.value)} />
              </div>
              <div className="field" style={{ flex: 1, minWidth: 160 }}>
                <label htmlFor={`${uid}-n`}>Nota (opcional)</label>
                <input id={`${uid}-n`} className="input" maxLength={200} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Ej.: compra a proveedor" />
              </div>
              <button type="submit" className="btn btn-primary btn-sm" disabled={busy}>{busy ? "Guardando…" : "Guardar"}</button>
            </form>
          )}
          {canManage && p.stock !== null && (
            <div className="flex flex-wrap items-end gap-3">
              <div className="field" style={{ width: 200 }}>
                <label htmlFor={`${uid}-min`}>Avisar cuando queden</label>
                <input id={`${uid}-min`} className="input" inputMode="numeric" value={minTxt} onChange={(e) => setMinTxt(e.target.value)} placeholder="10 (general)" />
              </div>
              <button type="button" className="btn btn-ghost-light btn-sm" disabled={busy} onClick={() => void saveMin()}>Guardar aviso</button>
            </div>
          )}
          <div role="alert" aria-live="assertive">{error && <p className="alert-error">{error}</p>}</div>
          <div role="status">{ok && <p className="alert-ok">{ok}</p>}</div>
          <div>
            <p className="text-[14px] font-medium">Historial</p>
            {moves === null && <p className="muted text-[13px]">Cargando…</p>}
            {moves !== null && moves.length === 0 && <p className="muted text-[13px]">Todavía no hay movimientos.</p>}
            {moves !== null && moves.length > 0 && (
              <ul className="mt-2 flex flex-col gap-1 text-[13px]" aria-label="Movimientos">
                {moves.map((m) => (
                  <li key={m.id} className="flex flex-wrap justify-between gap-2">
                    <span>
                      {new Intl.DateTimeFormat("es", { dateStyle: "short", timeStyle: "short" }).format(new Date(m.at))} · {KIND[m.kind] ?? m.kind}
                      {m.orderNumber !== null ? ` #${m.orderNumber}` : ""} · {ACTOR[m.actor]}{m.note ? ` · ${m.note}` : ""}
                    </span>
                    <span><strong>{m.delta > 0 ? `+${m.delta}` : m.delta}</strong> → {m.stockAfter}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}
    </li>
  );
}
