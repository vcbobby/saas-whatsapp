"use client";

import { useState } from "react";
import { postJson } from "@/lib/client";

/** Aviso suave (no bloquea nada) mientras el correo no esté confirmado. */
export function VerifyEmailNotice() {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  async function resend() {
    setBusy(true);
    const r = await postJson("/api/account/verify-email");
    setBusy(false);
    setMsg(r.data.message ?? (r.ok ? "Listo." : "No se pudo enviar."));
  }
  return (
    <p className="alert-warn mb-8" role="status">
      Confirma tu correo para recibir avisos y poder recuperar tu contraseña. Te enviamos un enlace al registrarte.{" "}
      <button type="button" className="link" onClick={resend} disabled={busy}>{busy ? "Enviando…" : "Reenviar correo"}</button>
      {msg && <span className="ml-2">{msg}</span>}
    </p>
  );
}
