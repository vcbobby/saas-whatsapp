"use client";

import Link from "next/link";
import { useId, useState, type FormEvent } from "react";
import { postJson } from "@/lib/client";

/** Elegir la contraseña nueva con el enlace del correo. */
export function ResetForm({ token }: { token: string }) {
  const uid = useId();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (busy) return;
    const f = new FormData(e.currentTarget);
    const password = String(f.get("password") ?? "");
    if (password !== String(f.get("again") ?? "")) return setError("Las dos contraseñas no coinciden.");
    setBusy(true);
    setError(null);
    const r = await postJson("/api/auth/reset", { token, password });
    setBusy(false);
    if (!r.ok) return setError(r.data.message ?? "No se pudo cambiar la contraseña.");
    setDone(true);
  }

  if (done) {
    return (
      <div className="grid gap-5">
        <p className="alert-ok" role="status">Listo, tu contraseña cambió. Por seguridad cerramos tu sesión en todos los dispositivos.</p>
        <Link href="/entrar" className="btn btn-primary">Entrar</Link>
      </div>
    );
  }
  return (
    <form onSubmit={submit} className="grid gap-5">
      <div className="field">
        <label htmlFor={`${uid}-p`}>Contraseña nueva</label>
        <input id={`${uid}-p`} name="password" type="password" className="input" autoComplete="new-password" required minLength={10} maxLength={128} />
        <p className="hint">Mínimo 10 caracteres. No uses tu correo.</p>
      </div>
      <div className="field">
        <label htmlFor={`${uid}-a`}>Repite la contraseña</label>
        <input id={`${uid}-a`} name="again" type="password" className="input" autoComplete="new-password" required maxLength={128} />
      </div>
      <div role="alert" aria-live="assertive">{error && <p className="alert-error">{error}</p>}</div>
      <button type="submit" className="btn btn-primary w-full" disabled={busy}>{busy ? "Guardando…" : "Cambiar contraseña"}</button>
    </form>
  );
}
