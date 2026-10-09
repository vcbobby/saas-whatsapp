"use client";

import { useRouter } from "next/navigation";
import { useId, useState, type FormEvent } from "react";
import { postJson } from "@/lib/client";

/** Segundo paso del inicio de sesión: código de la app autenticadora o de recuperación. */
export function MfaCodeForm({ onRestart }: { onRestart: () => void }) {
  const router = useRouter();
  const uid = useId();
  const [recovery, setRecovery] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (pending) return;
    setError(null);
    setPending(true);
    const value = String(new FormData(e.currentTarget).get("code") ?? "").trim();
    const r = await postJson("/api/auth/2fa/verify", recovery ? { recoveryCode: value } : { code: value });
    setPending(false);
    if (r.ok) {
      router.replace("/panel");
      router.refresh();
      return;
    }
    setError(r.data.message ?? "No se pudo verificar. Intenta de nuevo.");
    if (r.status === 401 && r.data.message?.includes("venció")) onRestart();
  }

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-6">
      <div className="field">
        <label htmlFor={`${uid}-code`}>{recovery ? "Código de recuperación" : "Código de 6 dígitos"}</label>
        <input
          id={`${uid}-code`}
          name="code"
          className="input"
          style={{ letterSpacing: recovery ? "0.08em" : "0.3em", fontVariantNumeric: "tabular-nums" }}
          type="text"
          inputMode={recovery ? "text" : "numeric"}
          autoComplete="one-time-code"
          autoCapitalize="characters"
          spellCheck={false}
          required
          maxLength={recovery ? 24 : 7}
          autoFocus
          aria-invalid={!!error}
        />
        <span className="hint">
          {recovery
            ? "Usa uno de los códigos que guardaste al activar la verificación. Cada uno sirve una sola vez."
            : "Ábrelo en tu app autenticadora (Google Authenticator, Authy, 1Password…)."}
        </span>
      </div>

      <div role="alert" aria-live="assertive">
        {error && <p className="alert-error">{error}</p>}
      </div>

      <button type="submit" className="btn btn-primary w-full" disabled={pending}>
        {pending ? "Verificando…" : "Verificar y entrar"}
      </button>

      <div className="flex flex-col items-center gap-1 text-sm">
        <button type="button" className="link" onClick={() => { setRecovery((v) => !v); setError(null); }}>
          {recovery ? "Usar el código de la app" : "No tengo mi teléfono: usar un código de recuperación"}
        </button>
        <button type="button" className="link muted" onClick={onRestart}>
          Volver
        </button>
      </div>
    </form>
  );
}
