"use client";

import { useRouter } from "next/navigation";
import { useId, useState, type FormEvent } from "react";
import { PLAN_MODULES, PLAN_MODULE_LABEL, type PlanInfo, type PlanModule } from "@/lib/plans/usage";

export type AdminPlan = PlanInfo & { active: boolean; isDefault: boolean };

function Row({ plan }: { plan: AdminPlan }) {
  const router = useRouter();
  const uid = useId();
  const lab = { color: "var(--color-pure-white)" } as const; // las etiquetas por defecto son oscuras (para tarjetas claras)
  const [name, setName] = useState(plan.name);
  const [replies, setReplies] = useState(plan.maxRepliesMonth === null ? "" : String(plan.maxRepliesMonth));
  const [members, setMembers] = useState(String(plan.maxMembers));
  const [mods, setMods] = useState<PlanModule[]>(plan.modules);
  const [active, setActive] = useState(plan.active);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  async function save(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setMsg(null);
    try {
      const res = await fetch("/api/admin/plans", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ planId: plan.id, name, maxRepliesMonth: replies.trim() === "" ? null : Number(replies), maxMembers: Number(members), modules: mods, active }),
      });
      const d = (await res.json().catch(() => ({}))) as { message?: string };
      setMsg(res.ok ? { ok: true, text: "Guardado." } : { ok: false, text: d.message ?? "No se pudo guardar." });
      if (res.ok) router.refresh();
    } catch {
      setMsg({ ok: false, text: "Sin conexión." });
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={save} className="card-dark grid gap-4" aria-label={`Plan ${plan.name}`}>
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-lg">{plan.slug}</h3>
        {plan.isDefault && <span className="badge">Por defecto (planes nuevos)</span>}
      </div>
      <div className="grid gap-4 md:grid-cols-4">
        <div className="field">
          <label htmlFor={`${uid}-n`} style={lab}>Nombre</label>
          <input id={`${uid}-n`} className="input" style={{ background: "#fff" }} value={name} onChange={(e) => setName(e.target.value)} maxLength={60} required />
        </div>
        <div className="field">
          <label htmlFor={`${uid}-r`} style={lab}>Respuestas al mes</label>
          <input id={`${uid}-r`} className="input" style={{ background: "#fff" }} type="number" min={0} max={10000000} step={1} value={replies} onChange={(e) => setReplies(e.target.value)} placeholder="Sin tope" />
        </div>
        <div className="field">
          <label htmlFor={`${uid}-m`} style={lab}>Personas del equipo</label>
          <input id={`${uid}-m`} className="input" style={{ background: "#fff" }} type="number" min={1} max={1000} step={1} value={members} onChange={(e) => setMembers(e.target.value)} required />
        </div>
        <div className="field">
          <span className="text-sm">Estado</span>
          <label className="flex items-center gap-2 text-sm" style={lab}>
            <input type="checkbox" checked={active} disabled={plan.isDefault} onChange={(e) => setActive(e.target.checked)} /> Activo (se puede asignar)
          </label>
        </div>
      </div>
      <fieldset>
        <legend className="text-sm">Módulos incluidos (se aplican al instante; los datos nunca se borran)</legend>
        <div className="mt-2 flex flex-wrap gap-4">
          {PLAN_MODULES.map((m) => (
            <label key={m} className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={mods.includes(m)} onChange={(e) => setMods(e.target.checked ? [...mods, m] : mods.filter((x) => x !== m))} />
              {PLAN_MODULE_LABEL[m]}
            </label>
          ))}
        </div>
      </fieldset>
      <div className="flex flex-wrap items-center gap-3">
        <button type="submit" className="btn btn-primary btn-sm" disabled={busy}>{busy ? "Guardando…" : "Guardar plan"}</button>
        {msg && <span role={msg.ok ? "status" : "alert"} className="text-sm" style={msg.ok ? undefined : { color: "var(--color-danger-on-dark)" }}>{msg.text}</span>}
      </div>
    </form>
  );
}

export function PlanEditor({ plans }: { plans: AdminPlan[] }) {
  return (
    <section aria-label="Planes" className="mt-8 flex flex-col gap-4">
      <h2 className="text-2xl">Planes</h2>
      <p className="muted-dark max-w-xl text-sm">
        Los límites se aplican al instante. «Sin tope» = respuestas ilimitadas. Un cambio de nombre no afecta a los negocios que ya lo tienen.
      </p>
      {plans.map((p) => <Row key={p.id} plan={p} />)}
    </section>
  );
}
