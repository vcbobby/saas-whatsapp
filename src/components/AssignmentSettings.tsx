"use client";

import { useEffect, useId, useState } from "react";
import { postJson } from "@/lib/client";

type Mode = "manual" | "turnos" | "menos_carga";
interface State { mode: Mode; notifyEmail: boolean; agents: number; people: number }

const OPTIONS: { id: Mode; title: string; text: string }[] = [
  { id: "manual", title: "A mano", text: "Nadie se asigna solo: cada persona toma las conversaciones que quiera." },
  { id: "turnos", title: "Por turnos", text: "Cada conversación nueva va a la persona a la que hace más tiempo no le tocó una." },
  { id: "menos_carga", title: "A quien tenga menos", text: "Va a quien esté atendiendo menos conversaciones en ese momento." },
];

export function AssignmentSettings() {
  const uid = useId();
  const [s, setS] = useState<State | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const t = setTimeout(async () => {
      try {
        const res = await fetch("/api/team/assignment", { cache: "no-store" });
        if (!res.ok) return setFailed(true);
        setS((await res.json()) as State);
      } catch { setFailed(true); }
    }, 0);
    return () => clearTimeout(t);
  }, []);

  async function save(next: State) {
    if (busy) return;
    setBusy(true); setMsg(null);
    const r = await postJson("/api/team/assignment", { mode: next.mode, notifyEmail: next.notifyEmail });
    setBusy(false);
    if (!r.ok) return setMsg({ ok: false, text: r.data.message ?? "No se pudo guardar." });
    setS(next);
    setMsg({ ok: true, text: "Guardado." });
  }

  if (failed) return <p className="alert-error" role="alert">No pudimos cargar el reparto de conversaciones.</p>;
  if (!s) return <p className="muted-dark" role="status">Cargando…</p>;

  return (
    <section className="card-light" style={{ padding: 24 }} aria-labelledby={`${uid}-t`}>
      <h2 id={`${uid}-t`} className="text-[22px]">Reparto de conversaciones</h2>
      <p className="muted mt-2 text-[15px]">
        Cuando el asistente pasa una conversación a una persona, ¿a quién se le asigna? {s.agents > 0 ? `Se reparte entre tus ${s.agents} ${s.agents === 1 ? "agente" : "agentes"}.` : "Como aún no tienes agentes, se reparte entre todo el equipo."}
      </p>
      <fieldset className="mt-4 grid gap-3" disabled={busy}>
        <legend className="sr-only">Cómo se reparten</legend>
        {OPTIONS.map((o) => (
          <label key={o.id} className="flex items-start gap-3">
            <input type="radio" name={`${uid}-modo`} className="mt-1" checked={s.mode === o.id} onChange={() => void save({ ...s, mode: o.id })} />
            <span><strong>{o.title}</strong><br /><span className="muted text-[14px]">{o.text}</span></span>
          </label>
        ))}
      </fieldset>
      <label className="mt-5 flex items-start gap-3">
        <input type="checkbox" className="mt-1" checked={s.notifyEmail} disabled={busy} onChange={(e) => void save({ ...s, notifyEmail: e.target.checked })} />
        <span><strong>Avisar por correo</strong><br /><span className="muted text-[14px]">A quien le toca la conversación; si nadie la tiene, al dueño y a los administradores.</span></span>
      </label>
      {msg && <p className={`${msg.ok ? "alert-ok" : "alert-error"} mt-4`} role={msg.ok ? "status" : "alert"}>{msg.text}</p>}
    </section>
  );
}
