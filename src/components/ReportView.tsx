"use client";

import { useEffect, useId, useState } from "react";
import { postJson } from "@/lib/client";
import { formatMoney } from "@/lib/catalog/money";
import { fmtDuration, hourLabel, pct, periodText, type Delta, type Report } from "@/lib/reports/pure";

function Stat({ label, value, d }: { label: string; value: string; d?: Delta }) {
  const p = d ? pct(d) : null;
  return (
    <div className="card p-4">
      <p className="text-[13px] muted-dark">{label}</p>
      <p className="mt-1 text-[28px] font-semibold">{value}</p>
      {p !== null && <p className="text-[13px] muted-dark">{p === 0 ? "Igual que antes" : `${p > 0 ? "▲ +" : "▼ "}${p} % frente al período anterior`}</p>}
    </div>
  );
}

export function ReportView() {
  const uid = useId();
  const [days, setDays] = useState<7 | 30>(7);
  const [data, setData] = useState<{ report: Report; weekly: boolean } | null>(null);
  const [failed, setFailed] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const t = setTimeout(async () => {
      try {
        const res = await fetch(`/api/reports?dias=${days}`, { cache: "no-store" });
        if (!res.ok) return setFailed(true);
        setFailed(false);
        setData((await res.json()) as { report: Report; weekly: boolean });
      } catch { setFailed(true); }
    }, 0);
    return () => clearTimeout(t);
  }, [days]);

  async function toggle(weekly: boolean) {
    setBusy(true); setMsg(null);
    const r = await postJson("/api/reports/settings", { weekly });
    setBusy(false);
    if (r.ok) setData((d) => (d ? { ...d, weekly } : d)); else setMsg("No se pudo guardar. Intenta de nuevo.");
  }
  async function sendNow() {
    setBusy(true); setMsg(null);
    const r = await postJson("/api/reports/send", {});
    setBusy(false);
    setMsg(r.ok ? "Listo: te lo enviamos a tu correo." : "No se pudo enviar (puedes pedirlo una vez por hora).");
  }

  if (failed) return <p role="alert" className="text-[14px]">No se pudo cargar el reporte. Recarga la página.</p>;
  if (!data) return <p className="muted-dark" role="status">Cargando…</p>;
  const r = data.report;
  const max = Math.max(1, ...r.hours);
  const top = r.hours.map((v, h) => ({ v, h })).filter((x) => x.v > 0);
  const sales = r.sales.map((s) => formatMoney(s.totalMinor, s.currency)).join(" + ") || "–";
  return (
    <div className="space-y-8">
      <div className="flex flex-wrap items-center gap-3">
        <div role="group" aria-label="Período" className="flex gap-2">
          {([7, 30] as const).map((d) => (
            <button key={d} type="button" aria-pressed={days === d} onClick={() => setDays(d)} className={days === d ? "btn btn-primary" : "btn btn-secondary"}>Últimos {d} días</button>
          ))}
        </div>
        <p className="muted-dark text-[14px]">{periodText(r)} · hora de {r.timezone}</p>
      </div>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Conversaciones" value={String(r.conversations)} />
        <Stat label="Mensajes recibidos" value={String(r.inbound.current)} d={r.inbound} />
        <Stat label="Clientes nuevos" value={String(r.newCustomers.current)} d={r.newCustomers} />
        <Stat label="Pasaron a una persona" value={String(r.handoffs)} />
        <Stat label="Resueltas solo con el asistente" value={String(r.resolvedByAssistant)} />
        <Stat label="Primera respuesta (asistente)" value={fmtDuration(r.replyAssistantSecs)} />
        <Stat label="Primera respuesta (equipo)" value={fmtDuration(r.replyPersonSecs)} />
        <Stat label="Respuestas del asistente / equipo" value={`${r.byAssistant} / ${r.byPerson}`} />
        <Stat label="Pedidos" value={String(r.orders.current)} d={r.orders} />
        <Stat label="Vendido (confirmado o entregado)" value={sales} />
        <Stat label="Citas" value={String(r.appointments.current)} d={r.appointments} />
        <Stat label="Citas sin asistir" value={String(r.appointments.noShow)} />
      </div>
      <section aria-labelledby={`${uid}-h`}>
        <h2 id={`${uid}-h`} className="text-[20px]">¿A qué hora escriben tus clientes?</h2>
        {top.length === 0 ? <p className="muted-dark mt-2">Sin mensajes en este período.</p> : (
          <ul className="mt-3 space-y-1">
            {top.map(({ v, h }) => (
              <li key={h} className="flex items-center gap-3 text-[14px]">
                <span className="w-16 shrink-0">{hourLabel(h)}</span>
                <span className="h-3 rounded bg-current opacity-70" style={{ width: `${Math.max(2, (v / max) * 100)}%`, maxWidth: "70%" }} aria-hidden />
                <span>{v}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
      {r.topProducts.length > 0 && (
        <section>
          <h2 className="text-[20px]">Lo más pedido</h2>
          <ol className="mt-3 list-decimal pl-5 text-[15px]">{r.topProducts.map((p) => <li key={p.name}>{p.name} · {p.quantity}</li>)}</ol>
        </section>
      )}
      <section className="card p-4">
        <h2 className="text-[18px]">Resumen por correo</h2>
        <p className="muted-dark mt-1 text-[14px]">Cada lunes enviamos el resumen de la semana al dueño y a los administradores.</p>
        <label className="mt-3 flex items-center gap-2 text-[15px]">
          <input type="checkbox" checked={data.weekly} disabled={busy} onChange={(e) => void toggle(e.target.checked)} /> Recibir el resumen semanal
        </label>
        <button type="button" className="btn btn-secondary mt-3" disabled={busy} onClick={() => void sendNow()}>Enviarme este resumen ahora</button>
        {msg && <p role="status" className="mt-2 text-[14px]">{msg}</p>}
      </section>
    </div>
  );
}
