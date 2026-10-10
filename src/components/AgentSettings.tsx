"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useId, useState, type FormEvent } from "react";

export interface AgentSettingsProps {
  enabled: boolean;
  assistantName: string;
  instructions: string;
  canManage: boolean;
  whatsappConnected: boolean;
  mockMode: boolean;
  repliesToday: number;
  dailyLimit: number;
  /** Solo en desarrollo: muestra el enlace al simulador. */
  simulatorLink?: boolean;
  /** Solo en desarrollo: las respuestas no salen a WhatsApp. */
  simulateMode?: boolean;
}

export function AgentSettings(p: AgentSettingsProps) {
  const router = useRouter();
  const uid = useId();
  const [enabled, setEnabled] = useState(p.enabled);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);

  async function save(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    setSaved(false);
    const f = new FormData(e.currentTarget);
    try {
      const res = await fetch("/api/agent", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          enabled,
          assistantName: String(f.get("assistantName") ?? ""),
          instructions: String(f.get("instructions") ?? ""),
        }),
      });
      const d = (await res.json().catch(() => ({}))) as { message?: string };
      if (!res.ok) setError(d.message ?? "No se pudo guardar.");
      else {
        setSaved(true);
        router.refresh();
      }
    } catch {
      setError("No hay conexión con el servidor. Revisa tu internet e intenta de nuevo.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card-light" style={{ maxWidth: 720 }}>
      <p className="eyebrow">Asistente</p>
      <h2 className="mt-3 text-[28px]">Tu asistente de WhatsApp</h2>

      {p.simulateMode && (
        <p className="alert-warn mt-4" role="status">
          Modo simulación: las respuestas NO se envían a WhatsApp. Pruébalas en el simulador.
        </p>
      )}
      {p.simulatorLink && (
        <p className="mt-4">
          <Link href="/simulador" className="link">Probar en el simulador →</Link>
        </p>
      )}
      {!p.whatsappConnected && !p.simulateMode && (
        <p className="alert-warn mt-4" role="status">
          Aún no conectaste tu número de WhatsApp. El asistente solo responde cuando hay un número conectado.
        </p>
      )}
      {p.mockMode && (
        <p className="alert-warn mt-4" role="status">
          Modo de prueba: todavía no hay un modelo de IA conectado, así que el asistente responde con un texto fijo.
        </p>
      )}
      <p className="muted mt-3">
        Respuestas de hoy: <strong>{p.repliesToday}</strong> de {p.dailyLimit}. Si el cliente pide hablar con una persona, o el asistente no
        puede ayudar, la conversación pasa a tu equipo y el asistente deja de responder en ella.
      </p>

      <form onSubmit={save} className="mt-6 flex flex-col gap-5">
        <div className="field">
          <label htmlFor={`${uid}-name`}>Nombre del asistente</label>
          <input id={`${uid}-name`} name="assistantName" className="input" defaultValue={p.assistantName} required maxLength={60} disabled={!p.canManage} />
        </div>
        <div className="field">
          <label htmlFor={`${uid}-ins`}>Información de tu negocio</label>
          <textarea
            id={`${uid}-ins`}
            name="instructions"
            className="input"
            style={{ minHeight: 240, resize: "vertical" }}
            defaultValue={p.instructions}
            maxLength={4000}
            disabled={!p.canManage}
            aria-describedby={`${uid}-hint`}
          />
          <p id={`${uid}-hint`} className="hint">
            Horarios, servicios, precios, ubicación, formas de pago y preguntas frecuentes. El asistente solo dirá lo que escribas aquí. No pegues
            contraseñas ni datos privados. Máximo 4000 caracteres.
          </p>
        </div>
        <label className="flex items-center gap-3" style={{ fontSize: 16 }}>
          <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} disabled={!p.canManage} style={{ width: 20, height: 20 }} />
          Activar el asistente (responderá solo a los mensajes nuevos)
        </label>
        <div role="alert" aria-live="assertive">{error && <p className="alert-error">{error}</p>}</div>
        <div role="status" aria-live="polite">{saved && <p className="muted">Guardado.</p>}</div>
        {p.canManage ? (
          <button type="submit" className="btn btn-primary" disabled={busy}>
            {busy ? "Guardando…" : "Guardar"}
          </button>
        ) : (
          <p className="muted">Solo dueños y administradores pueden cambiar el asistente.</p>
        )}
      </form>
    </section>
  );
}
