"use client";

import { useEffect, useState } from "react";
import { PLAN_MODULES, PLAN_MODULE_LABEL, type PlanUsage, type QuotaState } from "@/lib/plans/usage";

type Data = PlanUsage & { repliesState: QuotaState; membersState: QuotaState };

function Bar({ used, max, state, label }: { used: number; max: number | null; state: QuotaState; label: string }) {
  const pct = max === null || max === 0 ? 0 : Math.min(100, Math.round((used / max) * 100));
  const color = state === "full" ? "var(--color-danger-on-dark)" : state === "near" ? "var(--color-signal-yellow)" : "var(--color-neon-pulse)";
  return (
    <div>
      <p className="text-sm">
        {label}: <strong>{used.toLocaleString("es")}</strong> {max === null ? "(sin tope)" : `de ${max.toLocaleString("es")}`}
      </p>
      {max !== null && (
        <div role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={max} aria-valuenow={Math.min(used, max)} className="mt-2" style={{ height: 8, borderRadius: 8, background: "rgba(255,255,255,0.15)" }}>
          <div style={{ width: `${pct}%`, height: 8, borderRadius: 8, background: color }} />
        </div>
      )}
    </div>
  );
}

/** Plan del negocio y cuánto lleva usado este mes. */
export function PlanCard() {
  const [d, setD] = useState<Data | null | undefined>(undefined);
  useEffect(() => {
    let off = false;
    fetch("/api/plan", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((j: (Data & { plan: unknown }) | null) => { if (!off) setD(j && j.plan ? j : null); })
      .catch(() => { if (!off) setD(null); });
    return () => { off = true; };
  }, []);
  if (!d) return null;
  return (
    <section className="card-dark mt-8" aria-label="Tu plan" style={{ maxWidth: 720 }}>
      <p className="eyebrow eyebrow--dark">Tu plan</p>
      <h2 className="mt-2 text-xl">{d.plan.name}</h2>
      <div className="mt-4 grid gap-5 md:grid-cols-2">
        <Bar used={d.repliesThisMonth} max={d.plan.maxRepliesMonth} state={d.repliesState} label="Respuestas del asistente este mes" />
        <Bar used={d.members + d.pendingInvitations} max={d.plan.maxMembers} state={d.membersState} label="Personas del equipo (con invitaciones)" />
      </div>
      {d.repliesState === "full" && (
        <p className="alert-warn mt-4" role="alert">
          Llegaste al tope mensual de tu plan: el asistente dejó de responder y las conversaciones nuevas pasan a una persona. Se renueva el día 1 de cada mes.
        </p>
      )}
      {d.repliesState === "near" && (
        <p className="alert-warn mt-4" role="status">Estás cerca del tope mensual de respuestas de tu plan.</p>
      )}
      <p className="muted-dark mt-4 text-sm">
        Incluye: {d.plan.modules.length ? d.plan.modules.map((m) => PLAN_MODULE_LABEL[m]).join(", ") : "solo atención"}.
        {PLAN_MODULES.some((m) => !d.plan.modules.includes(m)) && (
          <> No incluye: {PLAN_MODULES.filter((m) => !d.plan.modules.includes(m)).map((m) => PLAN_MODULE_LABEL[m]).join(", ")}.</>
        )}
      </p>
    </section>
  );
}
