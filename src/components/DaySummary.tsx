"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { moneyText } from "@/lib/summary/text";
import type { Snapshot } from "@/lib/summary/snapshot";

const POLL_MS = 60_000;

function Tile({ label, value, href, alert }: { label: string; value: string; href?: string; alert?: boolean }) {
  const inner = (
    <>
      <p className="muted text-[13px]">{label}</p>
      <p className="mt-1 text-[28px] font-semibold leading-none" style={alert ? { color: "var(--color-danger-on-light)" } : undefined}>{value}</p>
    </>
  );
  const style = { padding: 20, minWidth: 0 } as const;
  return href ? (
    <Link href={href} className="card-light block" style={{ ...style, textDecoration: "none" }}>{inner}</Link>
  ) : (
    <div className="card-light" style={style}>{inner}</div>
  );
}

/** «Resumen de hoy»: cifras reales del negocio, calculadas por el servidor (sin IA). */
export function DaySummary() {
  const [s, setS] = useState<Snapshot | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/summary", { cache: "no-store" });
      const data = (await res.json().catch(() => ({}))) as { snapshot?: Snapshot; message?: string };
      if (res.ok && data.snapshot) { setS(data.snapshot); setError(null); }
      else setError(data.message ?? "No se pudo cargar el resumen.");
    } catch {
      setError("No hay conexión con el servidor. Revisa tu internet e intenta de nuevo.");
    }
  }, []);

  useEffect(() => {
    const first = setTimeout(load, 0);
    const t = setInterval(load, POLL_MS);
    return () => { clearTimeout(first); clearInterval(t); };
  }, [load]);

  if (error && !s) return <p className="alert-error" role="alert">{error}</p>;
  if (!s) return <p className="muted-dark" role="status">Cargando resumen…</p>;

  return (
    <section aria-labelledby="resumen-h">
      <h2 id="resumen-h" className="text-[24px]">Resumen de hoy</h2>
      <p className="muted-dark mt-1 text-[14px]">Cifras reales de tu negocio, calculadas por el sistema. Ayer: {s.messages.inYesterday} mensajes recibidos.</p>
      <div className="mt-4 grid gap-3" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(170px, 1fr))" }}>
        <Tile label="Mensajes recibidos hoy" value={`${s.messages.inToday}`} href="/conversaciones" />
        <Tile label="Esperan a una persona" value={`${s.attention.humanConversations}`} href="/conversaciones" alert={s.attention.humanConversations > 0} />
        <Tile label="Tareas abiertas" value={`${s.attention.openTasks}`} alert={s.attention.urgentTasks > 0 || s.attention.overdueTasks > 0} />
        {s.agenda && <Tile label="Citas hoy" value={`${s.agenda.todayCount}`} href="/agenda" />}
        {s.agenda && <Tile label="Citas por confirmar" value={`${s.agenda.pendingConfirm}`} href="/agenda" alert={s.agenda.pendingConfirm > 0} />}
        {s.orders && <Tile label="Pedidos por confirmar" value={`${s.orders.pending}`} href="/pedidos" alert={s.orders.pendingOlderThan24h > 0} />}
        {s.orders && <Tile label="Pedidos de hoy" value={moneyText(s.orders.todayTotals)} href="/pedidos" />}
      </div>
      {(s.attention.urgentTasks > 0 || s.attention.overdueTasks > 0) && (
        <p className="muted-dark mt-3 text-[14px]">{s.attention.urgentTasks} urgentes · {s.attention.overdueTasks} vencidas.</p>
      )}
      {s.agenda && s.agenda.todayList.length > 0 && (
        <div className="card-light mt-4" style={{ padding: 20 }}>
          <h3 className="text-[18px]">Citas de hoy</h3>
          <ul className="mt-2 flex flex-col gap-1 text-[15px]">
            {s.agenda.todayList.map((a) => (
              <li key={a.startsAt + a.customer}>
                <strong>{a.time}</strong> · {a.service} · {a.customer}{a.status === "pendiente" ? " · por confirmar" : ""}
              </li>
            ))}
          </ul>
        </div>
      )}
      {s.orders && (s.orders.lowStock.length > 0 || s.orders.soldOutCount > 0) && (
        <div className="card-light mt-4" style={{ padding: 20 }}>
          <h3 className="text-[18px]">Inventario</h3>
          {s.orders.lowStock.length > 0 && (
            <p className="muted mt-2 text-[15px]">Poco stock: {s.orders.lowStock.map((p) => `${p.name} (${p.stock})`).join(", ")}.</p>
          )}
          {s.orders.soldOutCount > 0 && <p className="muted mt-1 text-[15px]">Agotados: {s.orders.soldOutCount}.</p>}
        </div>
      )}
    </section>
  );
}
