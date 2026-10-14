"use client";

import { useId, useRef, useState, type FormEvent } from "react";
import { postJson } from "@/lib/client";

interface Turn { role: "user" | "assistant"; content: string; asOf?: string; blocked?: boolean }

const SUGGESTIONS = [
  "¿Qué tengo pendiente hoy?",
  "¿Cuántas citas hay hoy y mañana?",
  "¿Qué productos se me están acabando?",
  "¿Cuánto llevo en pedidos hoy?",
  "¿Hay algo urgente que atender?",
];
const MAX = 500;

/** Copiloto del dueño: pregunta en lenguaje natural; responde solo con las cifras del sistema (solo lectura). */
export function CopilotChat() {
  const uid = useId();
  const [turns, setTurns] = useState<Turn[]>([]);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const endRef = useRef<HTMLDivElement>(null);

  async function ask(question: string) {
    const q = question.trim();
    if (q.length < 2 || busy) return;
    setBusy(true);
    setError(null);
    const history = turns.slice(-6).map((t) => ({ role: t.role, content: t.content.slice(0, 1200) }));
    setTurns((t) => [...t, { role: "user", content: q }]);
    setText("");
    const r = await postJson<{ answer?: string; asOf?: string; blocked?: boolean }>("/api/copilot", { question: q, history });
    if (r.ok && r.data.answer) {
      setTurns((t) => [...t, { role: "assistant", content: r.data.answer!, asOf: r.data.asOf, blocked: r.data.blocked }]);
    } else {
      setError(r.data.message ?? "No se pudo responder. Intenta de nuevo.");
    }
    setBusy(false);
    setTimeout(() => endRef.current?.scrollIntoView({ block: "end" }), 0);
  }

  const submit = (e: FormEvent) => { e.preventDefault(); void ask(text); };
  const hm = (iso?: string) => (iso ? new Date(iso).toLocaleTimeString("es", { hour: "2-digit", minute: "2-digit" }) : "");

  return (
    <div className="flex max-w-[760px] flex-col gap-6">
      <p className="muted-dark text-[15px]">
        Solo lectura: responde con las cifras reales de tu negocio (las mismas del «Resumen de hoy») y no puede cambiar nada. Si algo no está en esos datos, te lo dirá.
      </p>

      {turns.length === 0 && (
        <div className="flex flex-wrap gap-2" role="group" aria-label="Preguntas sugeridas">
          {SUGGESTIONS.map((s) => (
            <button key={s} type="button" className="btn btn-sm btn-ghost-dark" disabled={busy} onClick={() => void ask(s)}>{s}</button>
          ))}
        </div>
      )}

      <div className="flex flex-col gap-4" aria-live="polite" aria-label="Conversación con el copiloto">
        {turns.map((t, i) =>
          t.role === "user" ? (
            <div key={i} className="self-end rounded-[20px] px-5 py-3" style={{ background: "var(--color-neon-pulse)", color: "var(--color-obsidian-shell)", maxWidth: "85%" }}>
              {t.content}
            </div>
          ) : (
            <div key={i} className="card-light" style={{ padding: 20, maxWidth: "92%" }}>
              <p style={{ whiteSpace: "pre-wrap" }}>{t.content}</p>
              <p className="muted mt-3 text-[13px]">{t.blocked ? "Respuesta no disponible." : `Con los datos de las ${hm(t.asOf)}.`}</p>
            </div>
          ),
        )}
        {busy && <p className="muted-dark" role="status">Pensando…</p>}
        <div ref={endRef} />
      </div>

      <div aria-live="assertive" role="alert">{error && <p className="alert-error">{error}</p>}</div>

      <form onSubmit={submit} className="card-light flex flex-col gap-3" style={{ padding: 20 }} aria-label="Pregunta al copiloto">
        <div className="field">
          <label htmlFor={`${uid}-q`}>Tu pregunta</label>
          <textarea id={`${uid}-q`} className="input" rows={2} maxLength={MAX} value={text} onChange={(e) => setText(e.target.value)} placeholder="Ej.: ¿Cuántos pedidos tengo por confirmar?" onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void ask(text); } }} />
          <p className="hint">{text.length}/{MAX} · Enter para enviar</p>
        </div>
        <div className="flex items-center gap-3">
          <button type="submit" className="btn btn-primary btn-sm" disabled={busy || text.trim().length < 2}>Preguntar</button>
          {turns.length > 0 && <button type="button" className="btn btn-sm btn-ghost-light" disabled={busy} onClick={() => { setTurns([]); setError(null); }}>Nueva conversación</button>}
        </div>
      </form>
    </div>
  );
}
