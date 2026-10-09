"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useId, useState, type FormEvent } from "react";
import { MfaCodeForm } from "./MfaCodeForm";

type Mode = "login" | "signup";

const COPY = {
  login: {
    endpoint: "/api/auth/login",
    submit: "Entrar",
    pending: "Entrando…",
  },
  signup: {
    endpoint: "/api/auth/signup",
    submit: "Crear cuenta y empezar la prueba",
    pending: "Creando cuenta…",
  },
} as const;

export function AuthForm({ mode }: { mode: Mode }) {
  const router = useRouter();
  const uid = useId();
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [needsCode, setNeedsCode] = useState(false);
  const copy = COPY[mode];
  const errorId = `${uid}-error`;

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (pending) return;
    setError(null);
    setPending(true);

    const form = new FormData(e.currentTarget);
    const payload: Record<string, string> = {
      email: String(form.get("email") ?? ""),
      password: String(form.get("password") ?? ""),
    };
    if (mode === "signup") payload.businessName = String(form.get("businessName") ?? "");

    try {
      const res = await fetch(copy.endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (res.ok) {
        const ok = (await res.clone().json().catch(() => null)) as { mfaRequired?: boolean } | null;
        if (ok?.mfaRequired) {
          setNeedsCode(true);
          return;
        }
        router.replace("/panel");
        router.refresh();
        return;
      }
      const data = (await res.json().catch(() => null)) as { message?: string } | null;
      setError(data?.message ?? "No se pudo completar. Intenta de nuevo.");
    } catch {
      setError("No hay conexión con el servidor. Revisa tu internet e intenta de nuevo.");
    } finally {
      setPending(false);
    }
  }

  if (needsCode) return <MfaCodeForm onRestart={() => setNeedsCode(false)} />;

  return (
    <form onSubmit={onSubmit} noValidate={false} className="flex flex-col gap-6" aria-describedby={error ? errorId : undefined}>
      {mode === "signup" && (
        <div className="field">
          <label htmlFor={`${uid}-negocio`}>Nombre de tu negocio</label>
          <input
            id={`${uid}-negocio`}
            name="businessName"
            className="input"
            type="text"
            autoComplete="organization"
            required
            minLength={2}
            maxLength={120}
            aria-invalid={!!error}
          />
        </div>
      )}

      <div className="field">
        <label htmlFor={`${uid}-correo`}>Correo electrónico</label>
        <input
          id={`${uid}-correo`}
          name="email"
          className="input"
          type="email"
          inputMode="email"
          autoComplete="email"
          autoCapitalize="none"
          spellCheck={false}
          required
          maxLength={254}
          aria-invalid={!!error}
        />
      </div>

      <div className="field">
        <label htmlFor={`${uid}-clave`}>Contraseña</label>
        <div className="relative">
          <input
            id={`${uid}-clave`}
            name="password"
            className="input pr-24"
            type={showPassword ? "text" : "password"}
            autoComplete={mode === "signup" ? "new-password" : "current-password"}
            required
            minLength={mode === "signup" ? 10 : 1}
            maxLength={128}
            aria-invalid={!!error}
          />
          <button
            type="button"
            className="btn btn-text absolute right-1 top-1/2 -translate-y-1/2 text-sm"
            style={{ minHeight: 40 }}
            aria-pressed={showPassword}
            aria-controls={`${uid}-clave`}
            onClick={() => setShowPassword((v) => !v)}
          >
            {showPassword ? "Ocultar" : "Mostrar"}
          </button>
        </div>
        {mode === "signup" && <span className="hint">Mínimo 10 caracteres. Una frase larga funciona mejor que una palabra rara.</span>}
      </div>

      <div id={errorId} role="alert" aria-live="assertive">
        {error && <p className="alert-error">{error}</p>}
      </div>

      <button type="submit" className="btn btn-primary w-full" disabled={pending}>
        {pending ? copy.pending : copy.submit}
      </button>

      <p className="muted text-center text-sm">
        {mode === "login" ? (
          <>
            ¿Aún no tienes cuenta?{" "}
            <Link href="/registro" className="link">
              Empieza gratis
            </Link>
          </>
        ) : (
          <>
            ¿Ya tienes cuenta?{" "}
            <Link href="/entrar" className="link">
              Entrar
            </Link>
          </>
        )}
      </p>
    </form>
  );
}
