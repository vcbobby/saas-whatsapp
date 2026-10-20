"use client";

import { useRouter } from "next/navigation";
import { useId, useState, type FormEvent } from "react";

/** Nombre del negocio: lo ven tus clientes en las respuestas y tú en toda la app. */
export function BusinessNameForm({ initialName, canEdit }: { initialName: string; canEdit: boolean }) {
  const router = useRouter();
  const uid = useId();
  const [name, setName] = useState(initialName);
  const [saved, setSaved] = useState(initialName);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    setOk(false);
    try {
      const res = await fetch("/api/account/business", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ name }) });
      const data = (await res.json().catch(() => ({}))) as { name?: string; message?: string };
      if (res.ok) { setSaved(data.name ?? name); setName(data.name ?? name); setOk(true); router.refresh(); }
      else setError(data.message ?? "No se pudo guardar.");
    } catch {
      setError("No hay conexión con el servidor. Revisa tu internet e intenta de nuevo.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="grid gap-4" style={{ maxWidth: 480 }}>
      <div className="field">
        <label htmlFor={`${uid}-n`}>Nombre del negocio</label>
        <input id={`${uid}-n`} className="input" value={name} maxLength={120} disabled={!canEdit} onChange={(e) => { setName(e.target.value); setOk(false); }} aria-invalid={error ? true : undefined} />
        {!canEdit && <p className="hint">Solo el dueño o un administrador puede cambiarlo.</p>}
      </div>
      {error && <p className="alert-error" role="alert">{error}</p>}
      {ok && <p className="alert-ok" role="status">Nombre actualizado.</p>}
      {canEdit && <div><button type="submit" className="btn btn-primary" disabled={busy || name.trim() === saved}>{busy ? "Guardando…" : "Guardar nombre"}</button></div>}
    </form>
  );
}
