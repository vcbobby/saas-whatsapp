"use client";

import { useRouter } from "next/navigation";
import { useId, useState, type FormEvent } from "react";
import { postJson } from "@/lib/client";

/** mode "signup": persona nueva (elige contraseña). mode "accept": ya tiene sesión con ese correo. */
export function InviteAccept({ token, mode, email }: { token: string; mode: "signup" | "accept"; email: string }) {
  const router = useRouter();
  const uid = useId();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [show, setShow] = useState(false);

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    const password = String(new FormData(e.currentTarget).get("password") ?? "");
    const r =
      mode === "signup"
        ? await postJson("/api/invitations/signup", { token, password })
        : await postJson("/api/invitations/accept", { token });
    setBusy(false);
    if (r.ok) {
      router.replace("/panel");
      router.refresh();
      return;
    }
    setError(r.data.message ?? "No se pudo completar.");
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-6">
      {mode === "signup" && (
        <>
          <div className="field">
            <label htmlFor={`${uid}-e`}>Correo</label>
            <input id={`${uid}-e`} className="input" value={email} readOnly />
          </div>
          <div className="field">
            <label htmlFor={`${uid}-p`}>Elige una contraseña</label>
            <div className="relative">
              <input id={`${uid}-p`} name="password" className="input pr-24" type={show ? "text" : "password"} autoComplete="new-password" required minLength={10} maxLength={128} />
              <button type="button" className="btn btn-text absolute right-1 top-1/2 -translate-y-1/2 text-sm" style={{ minHeight: 40 }} aria-pressed={show} onClick={() => setShow((v) => !v)}>
                {show ? "Ocultar" : "Mostrar"}
              </button>
            </div>
            <span className="hint">Mínimo 10 caracteres.</span>
          </div>
        </>
      )}
      <div role="alert" aria-live="assertive">{error && <p className="alert-error">{error}</p>}</div>
      <button type="submit" className="btn btn-primary w-full" disabled={busy}>
        {busy ? "Un momento…" : mode === "signup" ? "Crear cuenta y unirme" : "Aceptar invitación"}
      </button>
    </form>
  );
}
