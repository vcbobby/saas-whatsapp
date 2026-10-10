"use client";

import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";

interface Msg {
  id: string;
  direction: "in" | "out";
  msg_type: string;
  body: string | null;
  send_state: string | null;
  send_error: string | null;
  process_state: string;
}
interface State {
  sendMode: "meta" | "simulate";
  agentEnabled: boolean;
  whatsappReady: boolean;
  conversation: { status: string; handoffReason: string | null } | null;
  messages: Msg[];
}

const REASON: Record<string, string> = {
  pedido_de_persona: "El cliente pidió hablar con una persona.",
  limite_diario: "Se alcanzó el tope diario de respuestas.",
  envio_rechazado: "Meta rechazó el envío del mensaje.",
  envio_incierto: "No se sabe si el mensaje salió; una persona debe revisarlo.",
  limite_contacto: "Este cliente alcanzó el tope de respuestas por hora o por día.",
  intentos_de_manipulacion: "El cliente insistió en manipular al asistente; lo atiende una persona.",
  fuga_de_instrucciones: "El asistente iba a revelar sus instrucciones internas; se bloqueó la respuesta.",
  salida_bloqueada: "La respuesta traía un enlace o correo que el negocio no escribió; se bloqueó.",
  respuesta_vacia: "El asistente no generó una respuesta.",
  agente_fallo: "El asistente no pudo procesar el mensaje.",
};

const WAIT_HINT_MS = 12_000;

export function SimulatorChat() {
  const [state, setState] = useState<State | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [waitingSince, setWaitingSince] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const listRef = useRef<HTMLDivElement>(null);
  const textRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/dev/simulador", { cache: "no-store" });
      if (!res.ok) {
        const d = (await res.json().catch(() => ({}))) as { message?: string };
        setError(d.message ?? "No se pudo cargar el simulador.");
        return;
      }
      setState((await res.json()) as State);
      setError(null);
    } catch {
      setError("No hay conexión con el servidor local. ¿Sigue corriendo `npm run dev`?");
    }
  }, []);

  useEffect(() => {
    const first = setTimeout(() => void load(), 0);
    const t = setInterval(() => {
      setNow(Date.now());
      void load();
    }, 1500);
    return () => {
      clearTimeout(first);
      clearInterval(t);
    };
  }, [load]);

  const last = state?.messages[state.messages.length - 1];
  const pendingReply = !!last && last.direction === "in" && state?.conversation?.status === "bot" && !!state?.agentEnabled;
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- el cronómetro de espera se deriva de los datos que llegan por sondeo
    setWaitingSince((prev) => (pendingReply ? (prev ?? Date.now()) : null));
  }, [pendingReply]);

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
  }, [state?.messages.length]);

  async function post(body: unknown): Promise<boolean> {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/dev/simulador", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      if (!res.ok) {
        const d = (await res.json().catch(() => ({}))) as { message?: string };
        setError(d.message ?? "No se pudo completar la acción.");
        return false;
      }
      await load();
      return true;
    } catch {
      setError("No hay conexión con el servidor local.");
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function send(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const text = (textRef.current?.value ?? "").trim();
    if (!text || busy) return;
    if (await post({ action: "send", text })) {
      if (textRef.current) textRef.current.value = "";
      textRef.current?.focus();
    }
  }

  const status = state?.conversation?.status;
  const slow = waitingSince !== null && now - waitingSince > WAIT_HINT_MS;

  return (
    <section className="card-light" style={{ maxWidth: 720 }}>
      <p className="eyebrow">Solo desarrollo</p>
      <h2 className="mt-3 text-[28px]">Simulador de WhatsApp</h2>
      <p className="muted mt-3">
        Escribe como si fueras un cliente. El mensaje pasa por la misma ruta real (base de datos, cola y asistente), pero no sale a WhatsApp.
      </p>

      {state && !state.agentEnabled && (
        <p className="alert-warn mt-4" role="status">
          El asistente está apagado: nadie responderá. Actívalo en <a className="link" href="/agente">Asistente</a>.
        </p>
      )}
      {state && state.sendMode === "meta" && (
        <p className="alert-warn mt-4" role="status">
          Atención: tu entorno está en modo <strong>meta</strong>, así que las respuestas SÍ se enviarían por WhatsApp si el número es real. Para probar sin
          enviar nada, pon WHATSAPP_SEND_MODE=simulate en .env.local y reinicia.
        </p>
      )}

      <div className="mt-6 flex flex-wrap items-center gap-3">
        <span className="badge" style={{ background: "var(--color-mint-frost)", color: "var(--color-ink)", border: "1px solid var(--color-fog-border)" }}>{status === "human" ? "En manos de una persona" : status === "bot" ? "Atiende el asistente" : "Sin conversación"}</span>
        <button type="button" className="btn btn-ghost-light btn-sm" disabled={busy} onClick={() => post({ action: "reset" })}>
          Nueva conversación
        </button>
      </div>
      {status === "human" && (
        <p className="muted mt-3" role="status">
          {REASON[state?.conversation?.handoffReason ?? ""] ?? "Pasó a una persona."} El asistente ya no responde aquí. Pulsa «Nueva conversación» para seguir probando.
        </p>
      )}

      <div
        ref={listRef}
        className="mt-5 flex flex-col gap-3 overflow-y-auto"
        style={{ height: 380, padding: 16, background: "var(--color-pure-white)", border: "1.5px solid var(--color-fog-border)", borderRadius: "var(--radius-small)" }}
        role="log"
        aria-live="polite"
        aria-label="Conversación de prueba"
      >
        {state && state.messages.length === 0 && <p className="muted">Aún no hay mensajes. Escribe el primero abajo.</p>}
        {state?.messages.map((m) => {
          const mine = m.direction === "in"; // "in" = lo que escribe el cliente simulado
          return (
            <div key={m.id} style={{ alignSelf: mine ? "flex-end" : "flex-start", maxWidth: "82%" }}>
              <div
                style={{
                  padding: "10px 14px",
                  borderRadius: 16,
                  whiteSpace: "pre-wrap",
                  overflowWrap: "anywhere",
                  background: mine ? "var(--color-ink)" : "var(--color-mint-frost)",
                  color: mine ? "var(--color-pure-white)" : "var(--color-ink)",
                  border: mine ? "none" : "1px solid var(--color-fog-border)",
                }}
              >
                {m.body ?? `(${m.msg_type})`}
              </div>
              <p className="muted" style={{ fontSize: 12, marginTop: 4, textAlign: mine ? "right" : "left" }}>
                {mine ? "Cliente (tú)" : "Asistente"}
                {!mine && m.send_state && m.send_state !== "sent" ? ` · envío: ${m.send_state}${m.send_error ? ` (${m.send_error})` : ""}` : ""}
              </p>
            </div>
          );
        })}
        {pendingReply && !slow && <p className="muted" style={{ alignSelf: "flex-start" }}>El asistente está escribiendo…</p>}
      </div>

      {slow && (
        <p className="alert-warn mt-4" role="status">
          Pasaron más de 12 segundos sin respuesta. Revisa que <strong>npm run worker</strong> esté corriendo (o usa <strong>npm run dev:all</strong>).
        </p>
      )}
      <div role="alert" aria-live="assertive">{error && <p className="alert-error mt-4">{error}</p>}</div>

      <form onSubmit={send} className="mt-4 flex gap-3">
        <label htmlFor="sim-text" className="sr-only" style={{ position: "absolute", width: 1, height: 1, overflow: "hidden", clip: "rect(0 0 0 0)" }}>
          Mensaje del cliente
        </label>
        <input id="sim-text" ref={textRef} className="input" placeholder="Escribe como si fueras el cliente…" maxLength={1000} autoComplete="off" disabled={busy} />
        <button type="submit" className="btn btn-primary" disabled={busy}>
          Enviar
        </button>
      </form>
    </section>
  );
}
