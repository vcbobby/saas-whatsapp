"use client";

import Link from "next/link";
import { useState } from "react";
import { postJson } from "@/lib/client";

/** El enlace del correo se confirma con un botón (así un programa que «previsualiza» el enlace no lo gasta). */
export function VerifyEmailButton({ token }: { token: string }) {
  const [busy, setBusy] = useState(false);
  const [state, setState] = useState<{ ok: boolean; text: string } | null>(null);
  async function go() {
    setBusy(true);
    const r = await postJson("/api/auth/verify", { token });
    setBusy(false);
    setState(r.ok ? { ok: true, text: "¡Listo! Tu correo quedó confirmado." } : { ok: false, text: r.data.message ?? "No se pudo confirmar." });
  }
  if (state) {
    return (
      <div className="grid gap-5">
        <p className={state.ok ? "alert-ok" : "alert-error"} role="status">{state.text}</p>
        <Link href={state.ok ? "/panel" : "/entrar"} className="btn btn-primary">{state.ok ? "Ir al panel" : "Entrar"}</Link>
      </div>
    );
  }
  return <button type="button" className="btn btn-primary" onClick={go} disabled={busy}>{busy ? "Confirmando…" : "Confirmar mi correo"}</button>;
}
