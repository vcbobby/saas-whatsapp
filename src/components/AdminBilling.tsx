"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useId, useState, type FormEvent } from "react";
import { amountMatches, formatBs, formatUsd } from "@/lib/billing/money";

export interface BillingSettings { rate: number | null; rateAgeHours: number | null; pmBank: string; pmPhone: string; pmHolderId: string; pmHolderName: string; paypal: string; binance: string; notes: string }
export interface PricedPlan { id: string; name: string; priceCents: number | null }
interface AdminPayment {
  id: string; tenantName: string; planName: string; months: number; method: "pago_movil" | "paypal" | "binance"; amountUsdCents: number;
  rate: number | null; amountBsCents: number | null; status: string; reference: string | null; payerBank: string | null; payerPhone: string | null;
  paidOn: string | null; declaredCents: number | null; hasProof: boolean; submittedAt: string | null; decidedAt: string | null; rejectReason: string | null;
}
const lab = { color: "var(--color-pure-white)" } as const;
const white = { background: "#fff" } as const;
const METHOD: Record<string, string> = { pago_movil: "Pago Móvil", paypal: "PayPal", binance: "Binance" };
const fmtDt = (iso: string | null) => (iso ? new Intl.DateTimeFormat("es-VE", { dateStyle: "short", timeStyle: "short" }).format(new Date(iso)) : "—");

async function post(url: string, body: unknown): Promise<{ ok: boolean; message?: string }> {
  try {
    const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const d = (await res.json().catch(() => ({}))) as { message?: string };
    return { ok: res.ok, message: d.message };
  } catch { return { ok: false, message: "Sin conexión." }; }
}

function Settings({ s }: { s: BillingSettings }) {
  const router = useRouter();
  const uid = useId();
  const [f, setF] = useState({ rate: s.rate === null ? "" : String(s.rate), pmBank: s.pmBank, pmPhone: s.pmPhone, pmHolderId: s.pmHolderId, pmHolderName: s.pmHolderName, paypal: s.paypal, binance: s.binance, notes: s.notes });
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const hours = s.rateAgeHours;
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF((v) => ({ ...v, [k]: e.target.value }));

  async function save(e: FormEvent) {
    e.preventDefault();
    setBusy(true); setMsg(null);
    const rate = f.rate.trim() === "" ? null : Number(f.rate.replace(",", "."));
    const r = await post("/api/admin/billing-settings", { ...f, rate });
    setMsg(r.ok ? { ok: true, text: "Guardado. La tasa quedó como actualizada ahora." } : { ok: false, text: r.message ?? "No se pudo guardar." });
    setBusy(false);
    if (r.ok) router.refresh();
  }
  const field = (k: keyof typeof f, label: string, extra: Record<string, unknown> = {}) => (
    <div className="field">
      <label htmlFor={`${uid}-${k}`} style={lab}>{label}</label>
      <input id={`${uid}-${k}`} className="input" style={white} value={f[k]} onChange={set(k)} {...extra} />
    </div>
  );
  return (
    <form onSubmit={save} className="card-dark mt-4 grid gap-4" aria-label="Datos de cobro">
      <div>
        <h3 className="text-lg">Tasa BCV y datos para cobrar</h3>
        <p className={hours !== null && hours <= 36 ? "muted-dark mt-1 text-sm" : "alert-warn mt-2"} role="status">
          {s.rate === null ? "No hay tasa: no se puede cobrar en bolívares." : hours !== null && hours <= 36 ? `Tasa actual: Bs. ${s.rate} (actualizada hace ${Math.floor(hours)} h).` : `La tasa tiene más de 36 h: los clientes NO pueden pagar en bolívares hasta que la actualices.`}
          {" "}Actualízala cada día: al guardar se vuelve a marcar como vigente.
        </p>
      </div>
      <div className="grid gap-4 md:grid-cols-3">
        {field("rate", "Bs. por 1 USD (tasa BCV)", { inputMode: "decimal", placeholder: "ej. 40,50" })}
        {field("pmBank", "Banco (Pago Móvil)", { maxLength: 60, placeholder: "0102 Banco de Venezuela" })}
        {field("pmPhone", "Teléfono (Pago Móvil)", { maxLength: 30 })}
        {field("pmHolderId", "Cédula / RIF", { maxLength: 30 })}
        {field("pmHolderName", "Titular", { maxLength: 80 })}
        {field("paypal", "Correo de PayPal", { maxLength: 120, type: "email" })}
        {field("binance", "Binance Pay ID", { maxLength: 80 })}
      </div>
      <div className="field">
        <label htmlFor={`${uid}-notes`} style={lab}>Nota para el cliente (opcional)</label>
        <textarea id={`${uid}-notes`} className="input" style={white} rows={2} maxLength={500} value={f.notes} onChange={set("notes")} />
      </div>
      {msg && <p className={msg.ok ? "badge" : "alert-error"} role={msg.ok ? "status" : "alert"}>{msg.text}</p>}
      <div><button type="submit" className="btn btn-primary btn-sm" disabled={busy}>{busy ? "Guardando…" : "Guardar datos de cobro"}</button></div>
    </form>
  );
}

function Prices({ plans }: { plans: PricedPlan[] }) {
  const router = useRouter();
  const uid = useId();
  const [vals, setVals] = useState<Record<string, string>>(() => Object.fromEntries(plans.map((p) => [p.id, p.priceCents === null ? "" : (p.priceCents / 100).toFixed(2)])));
  const [msg, setMsg] = useState<Record<string, string>>({});
  async function save(id: string) {
    const raw = (vals[id] ?? "").trim().replace(",", ".");
    const cents = raw === "" ? null : Math.round(Number(raw) * 100);
    if (cents !== null && (!Number.isFinite(cents) || cents < 1)) { setMsg((m) => ({ ...m, [id]: "Precio inválido." })); return; }
    const r = await post("/api/admin/plan-price", { planId: id, priceCents: cents });
    setMsg((m) => ({ ...m, [id]: r.ok ? "Guardado." : r.message ?? "No se pudo guardar." }));
    if (r.ok) router.refresh();
  }
  return (
    <div className="card-dark mt-4 grid gap-3" aria-label="Precios de los planes">
      <h3 className="text-lg">Precio mensual de cada plan (USD)</h3>
      <p className="muted-dark text-sm">Déjalo vacío para que el plan no se pueda comprar en línea (por ejemplo, planes a medida).</p>
      {plans.map((p) => (
        <div key={p.id} className="flex flex-wrap items-end gap-3">
          <div className="field" style={{ minWidth: 220 }}>
            <label htmlFor={`${uid}-${p.id}`} style={lab}>{p.name}</label>
            <input id={`${uid}-${p.id}`} className="input" style={white} inputMode="decimal" value={vals[p.id] ?? ""} onChange={(e) => setVals((v) => ({ ...v, [p.id]: e.target.value }))} placeholder="Sin venta en línea" />
          </div>
          <button type="button" className="btn btn-ghost-dark btn-sm" onClick={() => void save(p.id)}>Guardar</button>
          {msg[p.id] && <span className="text-sm" role="status">{msg[p.id]}</span>}
        </div>
      ))}
    </div>
  );
}

function Row({ p, onDone }: { p: AdminPayment; onDone: () => void }) {
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const pm = p.method === "pago_movil";
  const expected = pm ? p.amountBsCents : p.amountUsdCents;
  const matches = p.declaredCents !== null && expected !== null ? amountMatches(p.declaredCents, expected) : null;
  const fmt = (c: number) => (pm ? formatBs(c) : formatUsd(c));
  async function decide(approve: boolean) {
    if (!approve && !reason.trim()) { setErr("Escribe el motivo del rechazo."); return; }
    if (approve && !window.confirm(`¿Confirmar el pago de ${p.tenantName}? Se activa ${p.planName} por ${p.months} ${p.months === 1 ? "mes" : "meses"}.`)) return;
    setBusy(true); setErr(null);
    const r = await post("/api/admin/payments/decide", { paymentId: p.id, approve, reason: approve ? undefined : reason });
    setBusy(false);
    if (r.ok) onDone(); else setErr(r.message ?? "No se pudo.");
  }
  return (
    <li className="card-dark grid gap-4 md:grid-cols-[1fr_260px]" aria-label={`Pago de ${p.tenantName}`}>
      <div>
        <h3 className="text-lg">{p.tenantName}</h3>
        <p className="muted-dark mt-1 text-sm">{p.planName} · {p.months} {p.months === 1 ? "mes" : "meses"} · {METHOD[p.method]} · enviado {fmtDt(p.submittedAt)}</p>
        <dl className="mt-3 grid gap-1 text-sm">
          <div>Esperado: <strong>{expected !== null ? fmt(expected) : "—"}</strong>{pm && p.rate !== null && <span className="muted-dark"> ({formatUsd(p.amountUsdCents)} × {p.rate})</span>}</div>
          <div>
            Declarado: <strong>{p.declaredCents !== null ? fmt(p.declaredCents) : "—"}</strong>{" "}
            {matches === true && <span className="badge">Coincide</span>}
            {matches === false && <span className="alert-warn" style={{ padding: "2px 8px" }}>No coincide</span>}
          </div>
          <div>Referencia: <strong>{p.reference ?? "—"}</strong> · Fecha: {p.paidOn ?? "—"}</div>
          {pm && <div>Pagó desde: {p.payerBank ?? "—"} · {p.payerPhone ?? "—"}</div>}
        </dl>
        <p className="muted-dark mt-3 text-sm">Compara con tu banco: referencia, monto y fecha. El comprobante lo sube el cliente y puede ser falso; solo tu banco lo confirma.</p>
        {p.status === "por_revisar" && (
          <div className="mt-4 grid gap-2">
            <div className="flex flex-wrap gap-2">
              <button type="button" className="btn btn-primary btn-sm" disabled={busy} onClick={() => void decide(true)}>Confirmar pago</button>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <input className="input" style={{ ...white, width: 260 }} placeholder="Motivo si lo rechazas" aria-label="Motivo del rechazo" value={reason} maxLength={300} onChange={(e) => setReason(e.target.value)} />
              <button type="button" className="btn btn-ghost-dark btn-sm" disabled={busy} onClick={() => void decide(false)}>Rechazar</button>
            </div>
            {err && <p className="alert-error" role="alert">{err}</p>}
          </div>
        )}
        {p.status === "rechazado" && <p className="muted-dark mt-3 text-sm">Rechazado: {p.rejectReason}</p>}
      </div>
      {p.hasProof && (
        <a href={`/api/admin/payments/proof?id=${p.id}`} target="_blank" rel="noreferrer" aria-label="Abrir el comprobante en grande">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={`/api/admin/payments/proof?id=${p.id}`} alt={`Comprobante de ${p.tenantName}`} style={{ width: "100%", maxHeight: 320, objectFit: "contain", background: "#fff", borderRadius: 8 }} />
        </a>
      )}
    </li>
  );
}

function Queue() {
  const [status, setStatus] = useState("por_revisar");
  const [rows, setRows] = useState<AdminPayment[] | null>(null);
  const load = useCallback(async (st: string) => {
    try {
      const r = await fetch(`/api/admin/payments?status=${st}`, { cache: "no-store" });
      setRows(r.ok ? ((await r.json()) as { payments: AdminPayment[] }).payments : []);
    } catch { setRows([]); }
  }, []);
  useEffect(() => {
    let off = false;
    fetch(`/api/admin/payments?status=${status}`, { cache: "no-store" })
      .then((r) => (r.ok ? (r.json() as Promise<{ payments: AdminPayment[] }>) : { payments: [] }))
      .then((j) => { if (!off) setRows(j.payments); })
      .catch(() => { if (!off) setRows([]); });
    return () => { off = true; };
  }, [status]);
  return (
    <div className="mt-4">
      <div className="flex flex-wrap items-center gap-3">
        <label htmlFor="pay-status" className="text-sm">Ver</label>
        <select id="pay-status" className="input" style={{ ...white, width: "auto" }} value={status} onChange={(e) => { setRows(null); setStatus(e.target.value); }}>
          <option value="por_revisar">Por revisar</option>
          <option value="confirmado">Confirmados</option>
          <option value="rechazado">Rechazados</option>
          <option value="pendiente">Esperando pago</option>
          <option value="vencido">Vencidos</option>
        </select>
      </div>
      {rows === null ? <p className="muted-dark mt-4" role="status">Cargando…</p> : rows.length === 0 ? (
        <p className="card-dark muted-dark mt-4">No hay pagos en esta lista.</p>
      ) : (
        <ul className="mt-4 flex flex-col gap-4">{rows.map((p) => <Row key={p.id} p={p} onDone={() => void load(status)} />)}</ul>
      )}
    </div>
  );
}

/** Cobros del súper admin: datos y tasa, precios y cola de comprobantes. */
export function AdminBilling({ settings, plans }: { settings: BillingSettings; plans: PricedPlan[] }) {
  return (
    <section className="mt-12" aria-label="Cobros">
      <h2 className="text-2xl">Cobros</h2>
      <h3 className="mt-6 text-lg">Pagos por revisar</h3>
      <Queue />
      <Settings s={settings} />
      <Prices plans={plans} />
    </section>
  );
}
