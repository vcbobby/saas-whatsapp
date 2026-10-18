"use client";

import { useCallback, useEffect, useId, useState, type FormEvent } from "react";
import { compressProof } from "@/lib/billing/image";
import { formatBs, formatUsd } from "@/lib/billing/money";
import type { PaymentRow, PlanOffer, Subscription } from "@/lib/billing/data";
import { PLAN_MODULE_LABEL, type PlanModule } from "@/lib/plans/usage";

type Method = "pago_movil" | "paypal" | "binance";
interface Payee {
  pagoMovil: { banco: string; telefono: string; documento: string; titular: string | null } | null;
  paypal: string | null; binance: string | null; notas: string | null; rate: number | null; rateAt: string | null; rateFresh: boolean;
}
interface Data { offers: PlanOffer[]; payments: PaymentRow[]; subscription: Subscription | null; payee: Payee }

const METHOD_LABEL: Record<Method, string> = { pago_movil: "Pago Móvil (Bs.)", paypal: "PayPal (USD)", binance: "Binance Pay (USD)" };
const STATUS_LABEL: Record<PaymentRow["status"], string> = { pendiente: "Esperando tu pago", por_revisar: "En revisión", confirmado: "Confirmado", rechazado: "Rechazado", vencido: "Vencido" };
const SUB_LABEL: Record<string, string> = { trial: "Prueba gratis", active: "Activa", past_due: "Pago pendiente", suspended: "Suspendida" };
const fmtDate = (iso: string) => new Intl.DateTimeFormat("es-VE", { dateStyle: "medium" }).format(new Date(iso));

function Countdown({ until }: { until: string }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(t); }, []);
  const left = Math.max(0, Math.floor((new Date(until).getTime() - now) / 1000));
  if (left === 0) return <span>La cotización venció. Si ya pagaste, sube el comprobante (hay 6 horas de margen).</span>;
  const m = Math.floor(left / 60), s = left % 60;
  return <span>Paga dentro de <strong>{m}:{String(s).padStart(2, "0")}</strong> para mantener esta tasa.</span>;
}

function SubmitForm({ p, onDone }: { p: PaymentRow; onDone: () => void }) {
  const uid = useId();
  const today = new Date().toLocaleDateString("en-CA");
  const [reference, setReference] = useState("");
  const [paidOn, setPaidOn] = useState(today);
  const [bank, setBank] = useState("");
  const [phone, setPhone] = useState("");
  const [declared, setDeclared] = useState(p.method === "pago_movil" && p.amountBsCents ? (p.amountBsCents / 100).toFixed(2).replace(".", ",") : (p.amountUsdCents / 100).toFixed(2).replace(".", ","));
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function send(e: FormEvent) {
    e.preventDefault();
    if (!file) { setErr("Sube la captura o foto del comprobante."); return; }
    setBusy(true); setErr(null);
    try {
      const proof = await compressProof(file);
      const res = await fetch("/api/billing/submit", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ paymentId: p.id, reference, bank, phone, paidOn, declared, proof }) });
      const d = (await res.json().catch(() => ({}))) as { message?: string };
      if (!res.ok) { setErr(d.message ?? "No se pudo enviar."); return; }
      onDone();
    } catch (x) {
      setErr(x instanceof Error ? x.message : "Sin conexión.");
    } finally { setBusy(false); }
  }
  const pm = p.method === "pago_movil";
  return (
    <form onSubmit={send} className="mt-4 grid gap-4 md:grid-cols-2" aria-label="Enviar comprobante">
      <div className="field">
        <label htmlFor={`${uid}-ref`}>Número de referencia</label>
        <input id={`${uid}-ref`} className="input" value={reference} onChange={(e) => setReference(e.target.value)} required minLength={4} maxLength={60} autoComplete="off" />
        <span className="hint">Es el número que aparece en el comprobante de tu banco o app.</span>
      </div>
      <div className="field">
        <label htmlFor={`${uid}-date`}>Fecha del pago</label>
        <input id={`${uid}-date`} className="input" type="date" value={paidOn} max={today} onChange={(e) => setPaidOn(e.target.value)} required />
      </div>
      {pm && (
        <>
          <div className="field">
            <label htmlFor={`${uid}-bank`}>Banco desde el que pagaste</label>
            <input id={`${uid}-bank`} className="input" value={bank} onChange={(e) => setBank(e.target.value)} required maxLength={60} />
          </div>
          <div className="field">
            <label htmlFor={`${uid}-phone`}>Teléfono desde el que pagaste</label>
            <input id={`${uid}-phone`} className="input" inputMode="tel" value={phone} onChange={(e) => setPhone(e.target.value)} required maxLength={30} />
          </div>
        </>
      )}
      <div className="field">
        <label htmlFor={`${uid}-amt`}>Monto que pagaste ({pm ? "Bs." : "USD"})</label>
        <input id={`${uid}-amt`} className="input" inputMode="decimal" value={declared} onChange={(e) => setDeclared(e.target.value)} required />
      </div>
      <div className="field">
        <label htmlFor={`${uid}-file`}>Comprobante (imagen)</label>
        <input id={`${uid}-file`} className="input" type="file" accept="image/*" onChange={(e) => setFile(e.target.files?.[0] ?? null)} required />
        <span className="hint">Captura de pantalla o foto. Se reduce sola antes de enviarse.</span>
      </div>
      <div className="md:col-span-2">
        {err && <p className="alert-error mb-3" role="alert">{err}</p>}
        <button type="submit" className="btn btn-primary" disabled={busy}>{busy ? "Enviando…" : "Enviar comprobante"}</button>
      </div>
    </form>
  );
}

function PaymentCard({ p, planName, payee, onChange }: { p: PaymentRow; planName: string; payee: Payee; onChange: () => void }) {
  const pm = p.method === "pago_movil";
  return (
    <li className="card-light" aria-label={`Pago ${planName}`}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-lg">{planName} · {p.months} {p.months === 1 ? "mes" : "meses"}</h3>
        <span className="badge">{STATUS_LABEL[p.status]}</span>
      </div>
      <p className="muted mt-1 text-sm">{METHOD_LABEL[p.method]} · creado {fmtDate(p.createdAt)}</p>
      {p.status === "pendiente" && (
        <div className="mt-4">
          <p className="text-lg">
            Total a pagar: <strong>{pm && p.amountBsCents ? formatBs(p.amountBsCents) : formatUsd(p.amountUsdCents)}</strong>
            {pm && p.rate && <span className="muted text-sm"> ({formatUsd(p.amountUsdCents)} a Bs. {p.rate.toLocaleString("es-VE")} por dólar, tasa BCV)</span>}
          </p>
          <p className="muted mt-1 text-sm" role="status"><Countdown until={p.quoteExpiresAt} /></p>
          <dl className="mt-3 grid gap-1 text-sm">
            {pm && payee.pagoMovil && (
              <>
                <div><dt className="inline muted">Banco: </dt><dd className="inline"><strong>{payee.pagoMovil.banco}</strong></dd></div>
                <div><dt className="inline muted">Teléfono: </dt><dd className="inline"><strong>{payee.pagoMovil.telefono}</strong></dd></div>
                <div><dt className="inline muted">Cédula / RIF: </dt><dd className="inline"><strong>{payee.pagoMovil.documento}</strong></dd></div>
                {payee.pagoMovil.titular && <div><dt className="inline muted">Titular: </dt><dd className="inline">{payee.pagoMovil.titular}</dd></div>}
              </>
            )}
            {p.method === "paypal" && <div><dt className="inline muted">Enviar a (PayPal): </dt><dd className="inline"><strong>{payee.paypal}</strong></dd></div>}
            {p.method === "binance" && <div><dt className="inline muted">Binance Pay ID: </dt><dd className="inline"><strong>{payee.binance}</strong></dd></div>}
          </dl>
          {payee.notas && <p className="muted mt-2 text-sm">{payee.notas}</p>}
          <SubmitForm p={p} onDone={onChange} />
        </div>
      )}
      {p.status === "por_revisar" && (
        <p className="mt-3 text-sm">Recibimos tu comprobante (ref. <strong>{p.reference}</strong>). Una persona lo revisa y activa tu plan; verás el cambio aquí mismo.</p>
      )}
      {p.status === "confirmado" && <p className="mt-3 text-sm">Pago confirmado. Gracias.</p>}
      {p.status === "rechazado" && <p className="alert-warn mt-3" role="status">No pudimos confirmar este pago: {p.rejectReason}. Si ya pagaste, escríbenos con tu comprobante.</p>}
      {p.status === "vencido" && <p className="muted mt-3 text-sm">Esta cotización venció sin comprobante. Crea una nueva si quieres pagar.</p>}
    </li>
  );
}

/** Pantalla del dueño: suscripción, elegir plan, pagar y enviar comprobante. */
export function BillingPanel() {
  const uid = useId();
  const [data, setData] = useState<Data | null | undefined>(undefined);
  const [planId, setPlanId] = useState("");
  const [months, setMonths] = useState(1);
  const [method, setMethod] = useState<Method>("pago_movil");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await fetch("/api/billing", { cache: "no-store" });
      setData(r.ok ? ((await r.json()) as Data) : null);
    } catch { setData(null); }
  }, []);
  useEffect(() => {
    let off = false;
    fetch("/api/billing", { cache: "no-store" })
      .then((r) => (r.ok ? (r.json() as Promise<Data>) : null))
      .then((j) => { if (!off) setData(j); })
      .catch(() => { if (!off) setData(null); });
    return () => { off = true; };
  }, []);

  if (data === undefined) return <p className="muted-dark mt-10" role="status">Cargando…</p>;
  if (data === null) return <p className="alert-error mt-10" role="alert">No se pudo cargar. Solo el dueño del negocio puede ver esta pantalla.</p>;

  const { offers, payments, subscription, payee } = data;
  const available: Record<Method, boolean> = { pago_movil: !!payee.pagoMovil && payee.rateFresh, paypal: !!payee.paypal, binance: !!payee.binance };
  const chosenMethod: Method = available[method] ? method : (["pago_movil", "paypal", "binance"] as Method[]).find((m) => available[m]) ?? method;
  const offer = offers.find((o) => o.id === planId) ?? offers[0];
  const planNames = new Map(offers.map((o) => [o.id, o.name]));
  const usd = offer ? offer.priceUsdCents * months : 0;
  const bsPreview = payee.rate && offer ? Math.round(usd * payee.rate) : null;

  async function create(e: FormEvent) {
    e.preventDefault();
    if (!offer) return;
    setBusy(true); setErr(null);
    try {
      const res = await fetch("/api/billing/pay", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ planId: offer.id, months, method: chosenMethod }) });
      const d = (await res.json().catch(() => ({}))) as { message?: string };
      if (!res.ok) setErr(d.message ?? "No se pudo crear el pago."); else await load();
    } catch { setErr("Sin conexión."); } finally { setBusy(false); }
  }

  return (
    <div className="mt-8 grid gap-8" style={{ maxWidth: 820 }}>
      {subscription && (
        <section className="card-dark" aria-label="Tu suscripción">
          <p className="eyebrow eyebrow--dark">Tu suscripción</p>
          <h2 className="mt-2 text-xl">{subscription.planName}</h2>
          <p className="mt-2"><span className="badge">{SUB_LABEL[subscription.status] ?? subscription.status}</span></p>
          <p className="muted-dark mt-3 text-sm">
            {subscription.expiresAt
              ? subscription.daysLeft !== null && subscription.daysLeft > 0
                ? `Vence el ${fmtDate(subscription.expiresAt)} (quedan ${subscription.daysLeft} ${subscription.daysLeft === 1 ? "día" : "días"}).`
                : `Venció el ${fmtDate(subscription.expiresAt)}. Renueva para que el asistente vuelva a responder.`
              : "Sin fecha de vencimiento."}
          </p>
        </section>
      )}

      <section aria-label="Elegir plan">
        <h2 className="text-2xl">Pagar o cambiar de plan</h2>
        {offers.length === 0 ? (
          <p className="card-dark muted-dark mt-4">Todavía no hay planes a la venta. Escríbenos y lo resolvemos.</p>
        ) : (
          <form onSubmit={create} className="card-light mt-4 grid gap-5" aria-label="Nueva cotización">
            <fieldset>
              <legend className="text-sm">Plan</legend>
              <div className="mt-2 grid gap-3 md:grid-cols-2">
                {offers.map((o) => (
                  <label key={o.id} className="flex cursor-pointer gap-3 rounded-xl border p-4" style={{ borderColor: offer?.id === o.id ? "var(--color-ink)" : "rgba(19,35,34,0.2)" }}>
                    <input type="radio" name={`${uid}-plan`} checked={offer?.id === o.id} onChange={() => setPlanId(o.id)} />
                    <span>
                      <strong>{o.name}</strong> · {formatUsd(o.priceUsdCents)}/mes<br />
                      <span className="muted text-sm">
                        {o.maxRepliesMonth === null ? "Respuestas sin tope" : `${o.maxRepliesMonth.toLocaleString("es")} respuestas al mes`} · {o.maxMembers} {o.maxMembers === 1 ? "persona" : "personas"}
                        {o.modules.length > 0 && <> · {o.modules.map((m) => PLAN_MODULE_LABEL[m as PlanModule] ?? m).join(", ")}</>}
                      </span>
                    </span>
                  </label>
                ))}
              </div>
            </fieldset>
            <div className="grid gap-5 md:grid-cols-2">
              <div className="field">
                <label htmlFor={`${uid}-m`}>Meses a pagar</label>
                <select id={`${uid}-m`} className="input" value={months} onChange={(e) => setMonths(Number(e.target.value))}>
                  {[1, 2, 3, 6, 12].map((m) => <option key={m} value={m}>{m} {m === 1 ? "mes" : "meses"}</option>)}
                </select>
              </div>
              <fieldset>
                <legend className="text-sm">Método de pago</legend>
                <div className="mt-2 flex flex-col gap-2">
                  {(Object.keys(METHOD_LABEL) as Method[]).map((m) => (
                    <label key={m} className="flex items-center gap-2 text-sm" style={{ opacity: available[m] ? 1 : 0.5 }}>
                      <input type="radio" name={`${uid}-meth`} checked={chosenMethod === m} disabled={!available[m]} onChange={() => setMethod(m)} />
                      {METHOD_LABEL[m]}{!available[m] && (m === "pago_movil" && !!payee.pagoMovil ? " (tasa del día pendiente)" : " (no disponible)")}
                    </label>
                  ))}
                </div>
              </fieldset>
            </div>
            {offer && (
              <p className="text-lg">
                Total: <strong>{chosenMethod === "pago_movil" && bsPreview ? formatBs(bsPreview) : formatUsd(usd)}</strong>
                {chosenMethod === "pago_movil" && bsPreview && <span className="muted text-sm"> ({formatUsd(usd)} a la tasa BCV de hoy; se congela 30 minutos al continuar)</span>}
              </p>
            )}
            {err && <p className="alert-error" role="alert">{err}</p>}
            <div><button type="submit" className="btn btn-primary" disabled={busy || !offer || !available[chosenMethod]}>{busy ? "Creando…" : "Continuar al pago"}</button></div>
          </form>
        )}
      </section>

      {payments.length > 0 && (
        <section aria-label="Tus pagos">
          <h2 className="text-2xl">Tus pagos</h2>
          <ul className="mt-4 flex flex-col gap-4">
            {payments.map((p) => <PaymentCard key={p.id} p={p} planName={planNames.get(p.planId) ?? "Plan"} payee={payee} onChange={load} />)}
          </ul>
        </section>
      )}
    </div>
  );
}
