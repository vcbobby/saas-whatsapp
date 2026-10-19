"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { DayChart } from "@/components/DayChart";
import { formatMoney } from "@/lib/catalog/money";
import { pctChange, type DashboardData, type Delta } from "@/lib/dashboard/pure";
import type { Snapshot } from "@/lib/summary/snapshot";

const GREEN = "#3ddc91";
const BLUE = "#6ea8ff";

function Trend({ d }: { d: Delta }) {
  const p = pctChange(d);
  if (p === null) return <span className="muted-dark text-[13px]">{d.current > 0 ? "Primera semana con datos" : "Sin datos todavía"}</span>;
  if (p === 0) return <span className="muted-dark text-[13px]">= igual que la semana anterior</span>;
  return <span className="text-[13px]" style={{ color: p > 0 ? "var(--color-neon-pulse)" : "var(--color-signal-yellow)" }}>{p > 0 ? "▲" : "▼"} {Math.abs(p)} % vs. semana anterior</span>;
}

function Kpi({ label, value, trend, href }: { label: string; value: string; trend?: React.ReactNode; href?: string }) {
  const body = (
    <>
      <p className="muted-dark text-[13px]">{label}</p>
      <p className="mt-1 text-[30px] font-semibold leading-none">{value}</p>
      <p className="mt-2">{trend}</p>
    </>
  );
  return href ? <Link href={href} className="card-dark block" style={{ textDecoration: "none", color: "inherit", minWidth: 0 }}>{body}</Link> : <div className="card-dark" style={{ minWidth: 0 }}>{body}</div>;
}

function Attention({ s }: { s: Snapshot }) {
  const items: { n: number; text: string; href: string }[] = [
    { n: s.attention.humanConversations, text: s.attention.humanConversations === 1 ? "conversación espera a una persona" : "conversaciones esperan a una persona", href: "/conversaciones" },
    { n: s.attention.openTasks, text: s.attention.openTasks === 1 ? "tarea abierta" : "tareas abiertas", href: "/hoy" },
    ...(s.agenda ? [{ n: s.agenda.pendingConfirm, text: s.agenda.pendingConfirm === 1 ? "cita por confirmar" : "citas por confirmar", href: "/agenda" }] : []),
    ...(s.orders ? [{ n: s.orders.pending, text: s.orders.pending === 1 ? "pedido por confirmar" : "pedidos por confirmar", href: "/pedidos" }] : []),
  ].filter((i) => i.n > 0);
  return (
    <section className="card-dark" aria-label="Requiere tu atención">
      <p className="eyebrow eyebrow--dark">Requiere tu atención</p>
      {items.length === 0 ? (
        <p className="mt-2">Todo al día. No hay nada pendiente ahora mismo.</p>
      ) : (
        <ul className="mt-3 flex flex-wrap gap-3" style={{ listStyle: "none", padding: 0 }}>
          {items.map((i) => (
            <li key={i.href + i.text}>
              <Link href={i.href} className="badge" style={{ textDecoration: "none" }}><strong>{i.n}</strong>&nbsp;{i.text}</Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function Checklist({ d }: { d: DashboardData }) {
  const done = d.checklist.filter((c) => c.done).length;
  if (done === d.checklist.length) return null;
  const pct = Math.round((done / d.checklist.length) * 100);
  return (
    <section className="card-dark" aria-label="Primeros pasos">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="eyebrow eyebrow--dark">Primeros pasos</p>
        <p className="muted-dark text-[13px]">{done} de {d.checklist.length} listos</p>
      </div>
      <div role="progressbar" aria-label="Avance de los primeros pasos" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct} className="mt-3" style={{ height: 8, borderRadius: 8, background: "rgba(255,255,255,0.15)" }}>
        <div style={{ width: `${pct}%`, height: 8, borderRadius: 8, background: "var(--color-neon-pulse)" }} />
      </div>
      <ul className="mt-4 grid gap-3 md:grid-cols-2" style={{ listStyle: "none", padding: 0 }}>
        {d.checklist.map((c) => (
          <li key={c.key} className="flex items-start gap-3">
            <span aria-hidden="true" style={{ flex: "none", width: 22, height: 22, borderRadius: 22, display: "inline-flex", alignItems: "center", justifyContent: "center", fontSize: 13, background: c.done ? "var(--color-neon-pulse)" : "transparent", color: "#070f0f", border: c.done ? 0 : "2px solid rgba(255,255,255,0.4)" }}>{c.done ? "✓" : ""}</span>
            <span>
              {c.done ? <span style={{ textDecoration: "line-through", opacity: 0.75 }}>{c.label}</span> : <Link href={c.href} className="link">{c.label}</Link>}
              <span className="sr-only">{c.done ? " (listo)" : " (pendiente)"}</span>
              {!c.done && <span className="muted-dark block text-[13px]">{c.hint}</span>}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** Panel de Inicio: qué pide atención, cómo va la semana y qué falta por configurar. Todo viene del servidor, sin IA. */
export function Dashboard() {
  const [d, setD] = useState<DashboardData | null>(null);
  const [s, setS] = useState<Snapshot | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    let off = false;
    const load = () =>
      Promise.all([
        fetch("/api/dashboard", { cache: "no-store" }).then((r) => (r.ok ? r.json() : Promise.reject(new Error("dashboard")))),
        fetch("/api/summary", { cache: "no-store" }).then((r) => (r.ok ? r.json() : Promise.reject(new Error("summary")))),
      ])
        .then(([a, b]: [{ dashboard: DashboardData }, { snapshot: Snapshot }]) => { if (!off) { setD(a.dashboard); setS(b.snapshot); setError(false); } })
        .catch(() => { if (!off) setError(true); });
    void load();
    const t = setInterval(() => void load(), 60_000);
    return () => { off = true; clearInterval(t); };
  }, []);

  if (error && !d) return <p className="alert-warn mt-8" role="alert">No se pudieron cargar las cifras. Revisa tu conexión y recarga la página.</p>;
  if (!d || !s) return <p className="muted-dark mt-8" role="status">Cargando tus cifras…</p>;

  const days = d.days.map((x) => x.day);
  const hasAgenda = d.modules.includes("agenda");
  const hasOrders = d.modules.includes("catalogo");
  const sales = d.week.sales.length ? d.week.sales.map((m) => formatMoney(m.totalMinor, m.currency)).join(" + ") : "—";

  return (
    <div className="mt-8 grid gap-6">
      {d.onboarding === "skipped" && (
        <p className="card-dark" role="note">¿Prefieres que te guiemos? <Link href="/bienvenida" className="link">Abrir el asistente de bienvenida</Link> y dejamos tu cuenta lista en 5 pasos.</p>
      )}
      <Attention s={s} />
      <Checklist d={d} />

      <section aria-label="Esta semana" className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Kpi label="Mensajes recibidos (7 días)" value={d.week.inbound.current.toLocaleString("es")} trend={<Trend d={d.week.inbound} />} href="/conversaciones" />
        <Kpi label="Personas que escribieron (7 días)" value={d.week.people.current.toLocaleString("es")} trend={<Trend d={d.week.people} />} href="/conversaciones" />
        {hasAgenda && <Kpi label="Citas (7 días)" value={d.week.appointments.current.toLocaleString("es")} trend={<Trend d={d.week.appointments} />} href="/agenda" />}
        {hasOrders && <Kpi label="Ventas en pedidos (7 días)" value={sales} trend={<Trend d={d.week.orders} />} href="/pedidos" />}
      </section>

      <section aria-label="Gráficos" className="grid gap-6 lg:grid-cols-2">
        <div className="lg:col-span-2">
          <DayChart title="Mensajes por día (últimas 2 semanas)" days={days} series={[
            { name: "Recibidos", color: GREEN, kind: "bar", values: d.days.map((x) => x.inbound) },
            { name: "Enviados", color: BLUE, kind: "line", values: d.days.map((x) => x.outbound) },
          ]} />
        </div>
        {hasAgenda && <DayChart title="Citas por día" days={days} series={[{ name: "Citas", color: GREEN, kind: "bar", values: d.days.map((x) => x.appointments) }]} />}
        {hasOrders && <DayChart title="Pedidos por día" days={days} series={[{ name: "Pedidos", color: GREEN, kind: "bar", values: d.days.map((x) => x.orders) }]} />}
      </section>
      <p className="muted-dark text-[13px]">Los días se cuentan con la zona horaria de tu negocio ({d.timezone}). Se actualiza solo cada minuto.</p>
    </div>
  );
}
