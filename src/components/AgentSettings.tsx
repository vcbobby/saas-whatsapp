"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useId, useState, type FormEvent } from "react";
import {
  BUSINESS_TYPES, BUSINESS_TYPE_INFO, COUNTRY_CODES, COUNTRY_INFO, EMOJI_LABEL, EMOJI_LEVELS, LENGTH_LABEL, REPLY_LENGTHS, TEMPLATES, TONES, TONE_LABEL,
  hasPlaceholders, sampleGreeting, type AgentStyle,
} from "@/lib/agent/style";

export interface AgentSettingsProps {
  enabled: boolean;
  assistantName: string;
  instructions: string;
  style: AgentStyle;
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
  const [name, setName] = useState(p.assistantName);
  const [instructions, setInstructions] = useState(p.instructions);
  const [style, setStyle] = useState<AgentStyle>(p.style);
  const [confirmTemplate, setConfirmTemplate] = useState(false);
  const setS = <K extends keyof AgentStyle>(k: K, v: AgentStyle[K]) => setStyle((s) => ({ ...s, [k]: v }));
  function applyTemplate() {
    setInstructions(TEMPLATES[style.businessType]);
    setConfirmTemplate(false);
    setSaved(false);
  }
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);

  async function save(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      const res = await fetch("/api/agent", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          enabled,
          assistantName: name,
          instructions,
          ...style,
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
          <input id={`${uid}-name`} name="assistantName" className="input" value={name} onChange={(e) => setName(e.target.value)} required maxLength={60} disabled={!p.canManage} />
        </div>

        <fieldset className="flex flex-col gap-3" disabled={!p.canManage} style={{ border: 0, padding: 0, margin: 0 }}>
          <legend className="text-[16px] font-medium">¿Cómo funciona tu negocio?</legend>
          <div className="grid gap-3 sm:grid-cols-3">
            {BUSINESS_TYPES.map((t) => (
              <label key={t} className="flex cursor-pointer flex-col gap-1 rounded-[16px] p-4" style={{ border: `2px solid ${style.businessType === t ? "var(--color-ink)" : "var(--color-field-border)"}`, background: "var(--color-pure-white)" }}>
                <span className="flex items-center gap-2 font-medium">
                  <input type="radio" name="businessType" value={t} checked={style.businessType === t} onChange={() => setS("businessType", t)} />
                  {BUSINESS_TYPE_INFO[t].label}
                </span>
                <span className="muted text-[14px]">{BUSINESS_TYPE_INFO[t].description}</span>
              </label>
            ))}
          </div>
        </fieldset>

        <div className="grid gap-5 sm:grid-cols-2">
          <div className="field">
            <label htmlFor={`${uid}-pais`}>País de tu negocio</label>
            <select id={`${uid}-pais`} className="input" value={style.country} onChange={(e) => setS("country", e.target.value as AgentStyle["country"])} disabled={!p.canManage}>
              {COUNTRY_CODES.map((c) => <option key={c} value={c}>{COUNTRY_INFO[c].label}</option>)}
            </select>
          </div>
          <div className="field">
            <label htmlFor={`${uid}-tono`}>Tono</label>
            <select id={`${uid}-tono`} className="input" value={style.tone} onChange={(e) => setS("tone", e.target.value as AgentStyle["tone"])} disabled={!p.canManage}>
              {TONES.map((t) => <option key={t} value={t}>{TONE_LABEL[t]}</option>)}
            </select>
          </div>
          <div className="field">
            <label htmlFor={`${uid}-emoji`}>Emojis</label>
            <select id={`${uid}-emoji`} className="input" value={style.emojiLevel} onChange={(e) => setS("emojiLevel", e.target.value as AgentStyle["emojiLevel"])} disabled={!p.canManage}>
              {EMOJI_LEVELS.map((t) => <option key={t} value={t}>{EMOJI_LABEL[t]}</option>)}
            </select>
          </div>
          <div className="field">
            <label htmlFor={`${uid}-largo`}>Largo de las respuestas</label>
            <select id={`${uid}-largo`} className="input" value={style.replyLength} onChange={(e) => setS("replyLength", e.target.value as AgentStyle["replyLength"])} disabled={!p.canManage}>
              {REPLY_LENGTHS.map((t) => <option key={t} value={t}>{LENGTH_LABEL[t]}</option>)}
            </select>
          </div>
        </div>
        <p className="rounded-[16px] p-4 text-[15px]" style={{ background: "var(--color-pure-white)", border: "1px solid var(--color-field-border)" }} aria-label="Ejemplo de cómo sonará">
          <span className="muted block text-[14px]">Así sonará tu asistente:</span>
          {sampleGreeting(style, name)}
        </p>
        <div className="field">
          <label htmlFor={`${uid}-ins`}>Información de tu negocio</label>
          <textarea
            id={`${uid}-ins`}
            name="instructions"
            className="input"
            style={{ minHeight: 240, resize: "vertical" }}
            value={instructions}
            onChange={(e) => setInstructions(e.target.value)}
            maxLength={4000}
            disabled={!p.canManage}
            aria-describedby={`${uid}-hint`}
          />
          {p.canManage && (
            <div className="flex flex-wrap items-center gap-3">
              {confirmTemplate ? (
                <>
                  <span className="text-[14px]">Esto reemplaza lo que escribiste. ¿Continuar?</span>
                  <button type="button" className="btn btn-sm btn-ghost-light" onClick={applyTemplate}>Sí, usar la plantilla</button>
                  <button type="button" className="btn btn-sm btn-text" style={{ color: "var(--color-ink)", textDecoration: "underline" }} onClick={() => setConfirmTemplate(false)}>Cancelar</button>
                </>
              ) : (
                <button type="button" className="btn btn-sm btn-ghost-light" onClick={() => (instructions.trim() ? setConfirmTemplate(true) : applyTemplate())}>
                  Usar plantilla de «{BUSINESS_TYPE_INFO[style.businessType].label}»
                </button>
              )}
            </div>
          )}
          {hasPlaceholders(instructions) && (
            <p className="alert-warn" role="note">Todavía hay campos entre [corchetes] sin completar. Reemplázalos con tus datos reales o bórralos: el asistente los leería tal cual.</p>
          )}
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
