"use client";

import { useId, useState, type FormEvent } from "react";
import { postJson } from "@/lib/client";

/** Cambiar la contraseña: pide la actual y cierra la sesión en los demás dispositivos. */
export function PasswordForm() {
  const uid = useId();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<number | null>(null);

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (busy) return;
    const form = e.currentTarget;
    const f = new FormData(form);
    const current = String(f.get("current") ?? "");
    const next = String(f.get("next") ?? "");
    const again = String(f.get("again") ?? "");
    setDone(null);
    if (next !== again) return setError("Las dos contraseñas nuevas no coinciden.");
    setBusy(true);
    setError(null);
    const r = await postJson<{ otherSessionsClosed?: number }>("/api/account/password", { currentPassword: current, newPassword: next });
    setBusy(false);
    if (!r.ok) return setError(r.data.message ?? "No se pudo cambiar la contraseña.");
    form.reset();
    setDone(r.data.otherSessionsClosed ?? 0);
  }

  return (
    <section className="card-light" style={{ maxWidth: 640 }} aria-labelledby={`${uid}-t`}>
      <p className="eyebrow">Contraseña</p>
      <h2 id={`${uid}-t`} className="mt-3 text-[28px]">Cambiar contraseña</h2>
      <p className="muted mt-2">Por seguridad, al cambiarla cerramos tu sesión en los demás dispositivos.</p>
      <form onSubmit={submit} className="mt-6 grid gap-5">
        <div className="field"><label htmlFor={`${uid}-c`}>Contraseña actual</label><input id={`${uid}-c`} name="current" type="password" className="input" autoComplete="current-password" required maxLength={128} /></div>
        <div className="field"><label htmlFor={`${uid}-n`}>Contraseña nueva</label><input id={`${uid}-n`} name="next" type="password" className="input" autoComplete="new-password" required minLength={10} maxLength={128} /><p className="hint">Mínimo 10 caracteres. No uses tu correo.</p></div>
        <div className="field"><label htmlFor={`${uid}-a`}>Repite la contraseña nueva</label><input id={`${uid}-a`} name="again" type="password" className="input" autoComplete="new-password" required maxLength={128} /></div>
        {error && <p className="alert-error" role="alert">{error}</p>}
        {done !== null && <p className="alert-ok" role="status">Contraseña cambiada.{done > 0 ? ` Cerramos ${done === 1 ? "1 sesión" : `${done} sesiones`} en otros dispositivos.` : ""}</p>}
        <div><button type="submit" className="btn btn-primary" disabled={busy}>{busy ? "Guardando…" : "Cambiar contraseña"}</button></div>
      </form>
    </section>
  );
}
