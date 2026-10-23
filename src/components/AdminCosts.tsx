"use client";

import { useId, useState } from "react";
import { useRouter } from "next/navigation";
import { formatTokens, formatUsd } from "@/lib/admin/format";
import type { AdminBudget } from "@/lib/admin/costs";

const pct = (v: number) => `${Math.min(v, 999).toLocaleString("es", { maximumFractionDigits: 1 })} %`;

function Meter({ label, value, note }: { label: string; value: number; note: string }) {
  const clamped = Math.max(0, Math.min(100, value));
  const color = value >= 100 ? "var(--color-signal-red, #ff6b6b)" : value >= 80 ? "var(--color-signal-yellow)" : "var(--color-neon-pulse)";
  return (
    <div className="card-dark" style={{ minWidth: 0 }}>
      <p className="muted-dark text-[13px]">{label}</p>
      <p className="mt-1 text-[30px] font-semibold leading-none">{pct(value)}</p>
      <div role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(clamped)} className="mt-3" style={{ height: 8, borderRadius: 8, background: "rgba(255,255,255,0.15)" }}>
        <div style={{ width: `${clamped}%`, height: 8, borderRadius: 8, background: color }} />
      </div>
      <p className="muted-dark mt-2 text-[13px]">{note}</p>
    </div>
  );
}

const toNum = (s: string): number | null => {
  const t = s.trim().replace(",", ".");
  if (t === "") return null;
  const v = Number(t);
  return Number.isFinite(v) ? v : NaN;
};

export function AdminCosts({ b }: { b: AdminBudget }) {
  const uid = useId();
  const router = useRouter();
  const s = b.state;
  const [budget, setBudget] = useState(b.settings.monthlyBudgetUsd?.toString() ?? "");
  const [pin, setPin] = useState(b.settings.priceInUsdPerMtok.toString());
  const [pout, setPout] = useState(b.settings.priceOutUsdPerMtok.toString());
  const [daily, setDaily] = useState(b.settings.dailyTokenLimit?.toString() ?? "");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    const payload = { monthlyBudgetUsd: toNum(budget), priceInUsdPerMtok: toNum(pin) ?? 0, priceOutUsdPerMtok: toNum(pout) ?? 0, dailyTokenLimit: toNum(daily) };
    if (Object.values(payload).some((v) => typeof v === "number" && Number.isNaN(v))) { setMsg({ ok: false, text: "Revisa los números: solo dígitos y punto decimal." }); return; }
    if (payload.monthlyBudgetUsd !== null && payload.priceInUsdPerMtok === 0 && payload.priceOutUsdPerMtok === 0) { setMsg({ ok: false, text: "Con un presupuesto hacen falta los precios por millón de tokens; sin ellos no se puede estimar el gasto." }); return; }
    setBusy(true);
    setMsg(null);
    try {
      const res = await fetch("/api/admin/costos", { method: "PUT", cache: "no-store", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
      const data = (await res.json().catch(() => ({}))) as { message?: string };
      if (res.ok) { setMsg({ ok: true, text: "Guardado." }); router.refresh(); }
      else setMsg({ ok: false, text: data.message ?? "No se pudo guardar. Revisa los valores." });
    } catch {
      setMsg({ ok: false, text: "No hay conexión con el servidor. Intenta de nuevo." });
    } finally { setBusy(false); }
  }

  return (
    <div className="mt-8 grid gap-6">
      {s.blocked && (
        <p className="alert-error" role="alert">
          La IA está en pausa: {s.reason === "presupuesto" ? "se llegó al presupuesto del mes." : "se llegó al tope de tokens de hoy."} El asistente pasa las conversaciones a una persona y el copiloto no responde. Sube el tope aquí abajo para reanudarla.
        </p>
      )}
      <section aria-label="Gasto" className="grid gap-4 sm:grid-cols-2">
        <Meter label="Presupuesto del mes" value={s.budgetSet ? s.budgetPct : 0}
          note={s.budgetSet ? `Gasto estimado ${formatUsd(s.spendUsd)} de ${formatUsd(s.budgetUsd ?? 0)}` : `Sin presupuesto fijado. Gasto estimado ${formatUsd(s.spendUsd)}`} />
        <Meter label="Tokens de hoy (todos los negocios)" value={s.dayPct} note={`${formatTokens(s.dayTokens)} de ${formatTokens(s.dayLimit)}`} />
      </section>
      <p className="muted-dark text-[13px]">El gasto es una ESTIMACIÓN: tokens del mes × los precios que escribas abajo. La cifra real y el límite duro están en el panel de tu proveedor de IA; fija allí un límite mensual también.</p>

      <form onSubmit={save} className="card-light grid gap-4" aria-label="Ajustes de presupuesto">
        <h2 className="text-[22px]">Ajustes</h2>
        <div className="field">
          <label htmlFor={`${uid}-b`}>Presupuesto mensual de IA (US$)</label>
          <input id={`${uid}-b`} className="input" inputMode="decimal" value={budget} onChange={(e) => setBudget(e.target.value)} placeholder="Vacío = sin presupuesto" />
          <p className="hint">Al llegar al 100 % la IA se pausa sola. Se avisa al 50 % y al 80 % aquí y en el Resumen.</p>
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="field">
            <label htmlFor={`${uid}-i`}>Precio de entrada (US$ por millón de tokens)</label>
            <input id={`${uid}-i`} className="input" inputMode="decimal" value={pin} onChange={(e) => setPin(e.target.value)} />
          </div>
          <div className="field">
            <label htmlFor={`${uid}-o`}>Precio de salida (US$ por millón de tokens)</label>
            <input id={`${uid}-o`} className="input" inputMode="decimal" value={pout} onChange={(e) => setPout(e.target.value)} />
          </div>
        </div>
        <p className="hint">Cópialos de la página de precios de tu proveedor y modelo. Sin precios no se puede estimar el gasto.</p>
        <div className="field">
          <label htmlFor={`${uid}-d`}>Tope de tokens por día, toda la plataforma</label>
          <input id={`${uid}-d`} className="input" inputMode="numeric" value={daily} onChange={(e) => setDaily(e.target.value)} placeholder={`Vacío = ${b.defaultDayLimit.toLocaleString("es")} (valor del servidor)`} />
          <p className="hint">Es un freno de emergencia que siempre está activo, aunque no pongas presupuesto.</p>
        </div>
        {msg && <p className={msg.ok ? "alert-ok" : "alert-error"} role={msg.ok ? "status" : "alert"}>{msg.text}</p>}
        <div><button type="submit" className="btn btn-primary" disabled={busy}>{busy ? "Guardando…" : "Guardar"}</button></div>
      </form>

      <section className="card-dark" aria-label="Avisos" style={{ minWidth: 0 }}>
        <p className="eyebrow eyebrow--dark">Avisos recientes</p>
        {b.alerts.length === 0 ? <p className="muted-dark mt-2">Todavía no se ha llegado al 50 % de ningún tope.</p> : (
          <ul className="mt-3 grid gap-2" style={{ listStyle: "none", padding: 0 }}>
            {b.alerts.map((a) => (
              <li key={`${a.kind}${a.period}${a.level}`} className="flex flex-wrap items-baseline gap-2">
                <span className={a.level >= 100 ? "badge" : "badge badge-neutral"}>{a.level} %</span>
                <span>{a.kind === "presupuesto_mes" ? `Presupuesto del mes (${a.period.slice(0, 7)})` : `Tokens del día ${a.period}`}</span>
                <span className="muted-dark text-[13px]">{a.kind === "presupuesto_mes" ? formatUsd(a.value) : `${formatTokens(a.value)} tokens`}</span>
              </li>
            ))}
          </ul>
        )}
        <p className="muted-dark mt-3 text-[13px]">Por ahora los avisos solo se ven aquí y en el Resumen; el envío por correo llega con los correos automáticos.</p>
      </section>

      <section className="card-dark" aria-label="Consumo por negocio" style={{ minWidth: 0 }}>
        <p className="eyebrow eyebrow--dark">Quién gastó más este mes</p>
        {b.top.length === 0 ? <p className="muted-dark mt-2">Todavía no hay consumo este mes.</p> : (
          <div className="mt-3" style={{ overflowX: "auto" }}>
            <table className="w-full text-left text-[14px]">
              <thead><tr><th className="py-1 pr-4 font-medium">Negocio</th><th className="py-1 pr-4 font-medium">Tokens</th><th className="py-1 font-medium">Gasto estimado</th></tr></thead>
              <tbody>
                {b.top.map((r, i) => (
                  <tr key={r.name + i} style={{ borderTop: "1px solid rgba(255,255,255,0.08)" }}>
                    <td className="py-2 pr-4">{r.name}</td><td className="py-2 pr-4">{formatTokens(r.tokens)}</td><td className="py-2">{formatUsd(r.spendUsd)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
