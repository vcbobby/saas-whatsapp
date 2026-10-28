"use client";

import Link from "next/link";
import { useId, useState, type FormEvent } from "react";
import { postJson } from "@/lib/client";

/** Pide el enlace para cambiar la contraseña. La respuesta es la misma exista o no la cuenta. */
export function ForgotForm() {
  const uid = useId();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState<string | null>(null);

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (busy) return;
    const email = String(new FormData(e.currentTarget).get("email") ?? "");
    setBusy(true);
    setError(null);
    const r = await postJson("/api/auth/forgot", { email });
    setBusy(false);
    if (!r.ok) return setError(r.data.message ?? "No se pudo enviar. Intenta de nuevo.");
    setSent(r.data.message ?? "Listo. Revisa tu correo.");
  }

  if (sent) {
    return (
      <div className="grid gap-5">
        <p className="alert-ok" role="status">{sent}</p>
        <Link href="/entrar" className="link">Volver a entrar</Link>
      </div>
    );
  }
  return (
    <form onSubmit={submit} className="grid gap-5" noValidate>
      <div className="field">
        <label htmlFor={`${uid}-e`}>Tu correo</label>
        <input id={`${uid}-e`} name="email" type="email" className="input" autoComplete="email" autoCapitalize="none" spellCheck={false} required maxLength={254} />
      </div>
      <div role="alert" aria-live="assertive">{error && <p className="alert-error">{error}</p>}</div>
      <button type="submit" className="btn btn-primary w-full" disabled={busy}>{busy ? "Enviando…" : "Enviarme el enlace"}</button>
      <p className="muted text-center text-sm"><Link href="/entrar" className="link">Volver a entrar</Link></p>
    </form>
  );
}
