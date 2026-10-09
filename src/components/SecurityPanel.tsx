"use client";

import { useRouter } from "next/navigation";
import { useId, useState, type FormEvent } from "react";
import { postJson } from "@/lib/client";
import { RecoveryCodes } from "./RecoveryCodes";

type View = "idle" | "setup" | "codes" | "disable" | "regen";

export function SecurityPanel({
  enabled,
  codesLeft,
  isSuperAdmin,
  mustEnable,
}: {
  enabled: boolean;
  codesLeft: number;
  isSuperAdmin: boolean;
  mustEnable: boolean;
}) {
  const router = useRouter();
  const uid = useId();
  const [view, setView] = useState<View>("idle");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [qr, setQr] = useState<string | null>(null);
  const [secret, setSecret] = useState<string | null>(null);
  const [codes, setCodes] = useState<string[]>([]);

  function reset(next: View = "idle") {
    setError(null);
    setView(next);
  }

  async function startSetup() {
    setBusy(true);
    setError(null);
    const r = await postJson<{ qr: string; secret: string }>("/api/auth/2fa/setup");
    setBusy(false);
    if (!r.ok) return setError(r.data.message ?? "No se pudo iniciar.");
    setQr(r.data.qr);
    setSecret(r.data.secret);
    setView("setup");
  }

  async function confirm(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const code = String(new FormData(e.currentTarget).get("code") ?? "");
    const r = await postJson<{ recoveryCodes: string[] }>("/api/auth/2fa/confirm", { code });
    setBusy(false);
    if (!r.ok) return setError(r.data.message ?? "Código incorrecto.");
    setCodes(r.data.recoveryCodes);
    setQr(null);
    setSecret(null);
    setView("codes");
  }

  async function sensitive(e: FormEvent<HTMLFormElement>, kind: "disable" | "regen") {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const f = new FormData(e.currentTarget);
    const body = { password: String(f.get("password") ?? ""), code: String(f.get("code") ?? "") };
    const r = await postJson<{ recoveryCodes?: string[] }>(
      kind === "disable" ? "/api/auth/2fa/disable" : "/api/auth/2fa/codes",
      body,
    );
    setBusy(false);
    if (!r.ok) return setError(r.data.message ?? "No se pudo completar.");
    if (kind === "regen" && r.data.recoveryCodes) {
      setCodes(r.data.recoveryCodes);
      return setView("codes");
    }
    reset();
    router.refresh();
  }

  function finishCodes() {
    reset();
    router.refresh();
  }

  const errorBox = (
    <div role="alert" aria-live="assertive">
      {error && <p className="alert-error">{error}</p>}
    </div>
  );

  const sensitiveForm = (kind: "disable" | "regen") => (
    <form onSubmit={(e) => sensitive(e, kind)} className="flex flex-col gap-5">
      <div className="field">
        <label htmlFor={`${uid}-pw`}>Tu contraseña</label>
        <input id={`${uid}-pw`} name="password" type="password" className="input" autoComplete="current-password" required maxLength={128} />
      </div>
      <div className="field">
        <label htmlFor={`${uid}-code`}>Código actual de tu app</label>
        <input id={`${uid}-code`} name="code" className="input" inputMode="numeric" autoComplete="one-time-code" required maxLength={7} style={{ letterSpacing: "0.3em" }} />
      </div>
      {errorBox}
      <div className="flex flex-wrap gap-3">
        <button type="submit" className="btn btn-primary" disabled={busy}>
          {kind === "disable" ? "Desactivar verificación" : "Generar códigos nuevos"}
        </button>
        <button type="button" className="btn btn-ghost-light" onClick={() => reset()}>
          Cancelar
        </button>
      </div>
    </form>
  );

  return (
    <section className="card-light" style={{ maxWidth: 640 }} aria-labelledby="mfa-title">
      <p className="eyebrow">Verificación en dos pasos</p>
      <h2 id="mfa-title" className="mt-3 text-[28px]">
        {enabled ? "Está activada" : "Protege tu cuenta"}
      </h2>

      {mustEnable && !enabled && view === "idle" && (
        <p className="alert-warn mt-4" role="status">
          Como súper admin debes activar la verificación en dos pasos. Hasta entonces no tienes acceso a la administración.
        </p>
      )}

      {view === "idle" && !enabled && (
        <>
          <p className="muted mt-3">
            Además de tu contraseña, te pediremos un código de 6 dígitos de una app en tu teléfono. Si alguien
            descubre tu contraseña, no podrá entrar.
          </p>
          {errorBox}
          <button type="button" className="btn btn-primary mt-6" onClick={startSetup} disabled={busy}>
            {busy ? "Preparando…" : "Activar verificación"}
          </button>
        </>
      )}

      {view === "idle" && enabled && (
        <>
          <p className="muted mt-3">
            Te quedan <strong>{codesLeft}</strong> {codesLeft === 1 ? "código de recuperación" : "códigos de recuperación"}.
            {codesLeft <= 3 && " Genera códigos nuevos pronto."}
          </p>
          <div className="mt-6 flex flex-wrap gap-3">
            <button type="button" className="btn btn-ghost-light" onClick={() => reset("regen")}>
              Generar códigos nuevos
            </button>
            {!isSuperAdmin && (
              <button type="button" className="btn btn-ghost-light" onClick={() => reset("disable")}>
                Desactivar
              </button>
            )}
          </div>
          {isSuperAdmin && <p className="muted mt-4 text-sm">El súper admin no puede desactivarla.</p>}
        </>
      )}

      {view === "setup" && qr && secret && (
        <div className="mt-6 flex flex-col gap-6">
          <ol className="muted flex list-decimal flex-col gap-2 pl-5">
            <li>Abre tu app autenticadora (Google Authenticator, Authy, 1Password…).</li>
            <li>Escanea este código QR.</li>
            <li>Escribe aquí el código de 6 dígitos que te muestra.</li>
          </ol>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={qr} alt="Código QR para tu app autenticadora" width={220} height={220} style={{ background: "#fff", padding: 8, borderRadius: 8 }} />
          <details className="text-sm">
            <summary className="link cursor-pointer">¿No puedes escanear? Escribe la clave a mano</summary>
            <p className="mt-2 break-all" style={{ fontFamily: "ui-monospace, monospace", letterSpacing: "0.08em" }}>{secret}</p>
          </details>
          <form onSubmit={confirm} className="flex flex-col gap-5">
            <div className="field">
              <label htmlFor={`${uid}-c`}>Código de 6 dígitos</label>
              <input id={`${uid}-c`} name="code" className="input" inputMode="numeric" autoComplete="one-time-code" required maxLength={7} autoFocus style={{ letterSpacing: "0.3em" }} />
            </div>
            {errorBox}
            <div className="flex flex-wrap gap-3">
              <button type="submit" className="btn btn-primary" disabled={busy}>
                {busy ? "Verificando…" : "Confirmar y activar"}
              </button>
              <button type="button" className="btn btn-ghost-light" onClick={() => reset()}>
                Cancelar
              </button>
            </div>
          </form>
        </div>
      )}

      {view === "codes" && (
        <div className="mt-6">
          <RecoveryCodes codes={codes} onDone={finishCodes} />
        </div>
      )}
      {view === "disable" && <div className="mt-6">{sensitiveForm("disable")}</div>}
      {view === "regen" && <div className="mt-6">{sensitiveForm("regen")}</div>}
    </section>
  );
}
