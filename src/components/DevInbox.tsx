"use client";

import { useEffect, useState } from "react";

type Mail = { id: string; to: string; subject: string; text: string; status: string; createdAt: string };

/** Solo desarrollo: los correos que en producción llegarían a la gente aparecen aquí. */
export function DevInbox() {
  const [mails, setMails] = useState<Mail[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let alive = true;
    void fetch("/api/dev/correos")
      .then(async (res) => {
        if (!alive) return;
        if (!res.ok) return setError("No se pudo cargar (¿iniciaste sesión? Esta bandeja solo existe en desarrollo).");
        setError(null);
        setMails(((await res.json()) as { emails: Mail[] }).emails);
      })
      .catch(() => alive && setError("No se pudo cargar."));
    return () => { alive = false; };
  }, [tick]);
  return (
    <div className="grid gap-4">
      <button type="button" className="btn btn-ghost-light self-start" onClick={() => setTick((n) => n + 1)}>Actualizar</button>
      {error && <p className="alert-error">{error}</p>}
      {mails?.length === 0 && <p className="muted">Todavía no hay correos.</p>}
      {mails?.map((m) => (
        <article key={m.id} className="card-light">
          <p className="muted text-sm">Para {m.to} · {m.status} · {new Date(m.createdAt).toLocaleString("es")}</p>
          <h2 className="mt-1 text-lg">{m.subject}</h2>
          <pre className="mt-3 whitespace-pre-wrap text-sm">{m.text}</pre>
        </article>
      ))}
    </div>
  );
}
