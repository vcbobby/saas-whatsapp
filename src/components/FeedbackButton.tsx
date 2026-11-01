"use client";

import { usePathname } from "next/navigation";
import { useId, useRef, useState, type FormEvent } from "react";

const KINDS = [
  { id: "idea", label: "Tengo una idea" },
  { id: "problema", label: "Algo no funciona" },
  { id: "otro", label: "Otra cosa" },
] as const;

export function FeedbackButton() {
  const uid = useId();
  const path = usePathname();
  const ref = useRef<HTMLDialogElement>(null);
  const [kind, setKind] = useState<(typeof KINDS)[number]["id"]>("idea");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  function open() { setMsg(null); ref.current?.showModal(); }
  function close() { ref.current?.close(); }

  async function send(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    if (message.trim().length < 3) return setMsg({ ok: false, text: "Cuéntanos un poco más." });
    setBusy(true); setMsg(null);
    try {
      const res = await fetch("/api/feedback", {
        method: "POST", headers: { "content-type": "application/json" }, cache: "no-store",
        body: JSON.stringify({ kind, message, page: /^\/[A-Za-z0-9/_\-.]*$/.test(path) ? path.slice(0, 120) : undefined }),
      });
      const j = (await res.json().catch(() => ({}))) as { message?: string };
      if (res.ok) { setMessage(""); setMsg({ ok: true, text: "¡Gracias! Lo leemos todo." }); } else setMsg({ ok: false, text: j.message ?? "No se pudo enviar. Intenta de nuevo." });
    } catch { setMsg({ ok: false, text: "No hay conexión con el servidor." }); }
    setBusy(false);
  }

  return (
    <>
      <button type="button" className="btn btn-sm btn-ghost-dark" onClick={open}>Enviar comentario</button>
      <dialog ref={ref} aria-labelledby={`${uid}-t`} className="card m-auto p-6" style={{ maxWidth: 480, width: "calc(100% - 32px)", color: "inherit" }}>
        <form onSubmit={send} className="flex flex-col gap-4">
          <h2 id={`${uid}-t`} className="text-[20px]">Cuéntanos qué piensas</h2>
          <fieldset className="flex flex-wrap gap-3">
            <legend className="sr-only">Tipo de comentario</legend>
            {KINDS.map((k) => (
              <label key={k.id} className="flex items-center gap-2 text-[15px]">
                <input type="radio" name={`${uid}-k`} checked={kind === k.id} onChange={() => setKind(k.id)} /> {k.label}
              </label>
            ))}
          </fieldset>
          <div>
            <label htmlFor={`${uid}-m`} className="sr-only">Tu comentario</label>
            <textarea id={`${uid}-m`} className="input" rows={5} maxLength={2000} value={message} onChange={(e) => { setMessage(e.target.value); setMsg(null); }} placeholder="Qué intentabas hacer, qué pasó y qué esperabas…" />
          </div>
          {msg && <p role={msg.ok ? "status" : "alert"} className="text-[14px]">{msg.text}</p>}
          <div className="flex gap-3">
            <button type="submit" className="btn btn-primary btn-sm" disabled={busy}>{busy ? "Enviando…" : "Enviar"}</button>
            <button type="button" className="btn btn-sm btn-ghost-dark" onClick={close}>Cerrar</button>
          </div>
        </form>
      </dialog>
    </>
  );
}
