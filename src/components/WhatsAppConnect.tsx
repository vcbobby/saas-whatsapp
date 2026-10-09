"use client";

import { useRouter } from "next/navigation";
import { useId, useState, type FormEvent } from "react";
import { postJson } from "@/lib/client";

export function WhatsAppConnect({ connectedId, canManage }: { connectedId: string | null; canManage: boolean }) {
  const router = useRouter();
  const uid = useId();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function connect(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    const f = new FormData(e.currentTarget);
    const r = await postJson("/api/whatsapp/connect", {
      phoneNumberId: String(f.get("phoneNumberId") ?? ""),
      accessToken: String(f.get("accessToken") ?? ""),
    });
    setBusy(false);
    if (!r.ok) return setError(r.data.message ?? "No se pudo conectar.");
    router.refresh();
  }

  async function disconnect() {
    if (!window.confirm("¿Desconectar este número? Dejarás de recibir mensajes.")) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/whatsapp/connect", { method: "DELETE" });
      if (!res.ok) {
        const d = (await res.json().catch(() => ({}))) as { message?: string };
        setError(d.message ?? "No se pudo desconectar.");
      } else router.refresh();
    } catch {
      setError("No hay conexión con el servidor.");
    } finally {
      setBusy(false);
    }
  }

  if (connectedId) {
    return (
      <section className="card-light" style={{ maxWidth: 640 }}>
        <p className="eyebrow">WhatsApp</p>
        <h2 className="mt-3 text-[28px]">Número conectado</h2>
        <p className="muted mt-3">
          ID del número: <strong>{connectedId}</strong>. Los mensajes que lleguen a ese número aparecerán en tu panel.
        </p>
        <div role="alert" aria-live="assertive">{error && <p className="alert-error mt-4">{error}</p>}</div>
        {canManage && (
          <button type="button" className="btn btn-ghost-light mt-6" onClick={disconnect} disabled={busy}>
            Desconectar
          </button>
        )}
      </section>
    );
  }

  return (
    <section className="card-light" style={{ maxWidth: 640 }}>
      <p className="eyebrow">WhatsApp</p>
      <h2 className="mt-3 text-[28px]">Conecta tu número</h2>
      <p className="muted mt-3">
        Necesitas el ID del número y un token de acceso, ambos desde el panel de Meta (WhatsApp &gt; Configuración de la API).
        El token se guarda cifrado y no vuelve a mostrarse.
      </p>
      {canManage ? (
        <form onSubmit={connect} className="mt-6 flex flex-col gap-5">
          <div className="field">
            <label htmlFor={`${uid}-id`}>ID del número de teléfono</label>
            <input id={`${uid}-id`} name="phoneNumberId" className="input" inputMode="numeric" required maxLength={30} autoComplete="off" />
          </div>
          <div className="field">
            <label htmlFor={`${uid}-tk`}>Token de acceso</label>
            <input id={`${uid}-tk`} name="accessToken" className="input" type="password" required maxLength={1000} autoComplete="off" spellCheck={false} />
          </div>
          <div role="alert" aria-live="assertive">{error && <p className="alert-error">{error}</p>}</div>
          <button type="submit" className="btn btn-primary" disabled={busy}>
            {busy ? "Validando con Meta…" : "Conectar"}
          </button>
        </form>
      ) : (
        <p className="muted mt-4">Solo dueños y administradores pueden conectar el número.</p>
      )}
    </section>
  );
}
