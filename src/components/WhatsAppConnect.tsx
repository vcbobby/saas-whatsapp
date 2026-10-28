"use client";

import { useRouter } from "next/navigation";
import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { postJson } from "@/lib/client";

export interface EmbeddedProps { appId: string; configId: string; graphVersion: string }
interface Status { via: "manual" | "embedded"; ok: boolean; problem: { reason: string; message: string } | null; displayPhoneNumber: string | null; verifiedName: string | null; quality: string | null; expiresAt: string | null; hoursLeft: number | null; expiresSoon: boolean }

const QUALITY: Record<string, string> = { GREEN: "Alta", YELLOW: "Media", RED: "Baja", UNKNOWN: "Sin datos todavía" };
type FbSdk = { init: (o: Record<string, unknown>) => void; login: (cb: (r: { authResponse?: { code?: string } }) => void, o: Record<string, unknown>) => void };
declare global { interface Window { FB?: FbSdk; fbAsyncInit?: () => void } }

const STEPS = [
  { t: "Abre el panel de Meta", d: "Entra a developers.facebook.com → «Mis apps» → tu app → WhatsApp → «Configuración de la API» (API Setup)." },
  { t: "Copia el ID del número", d: "Debajo del teléfono verás «Phone number ID»: un código largo de solo dígitos. No es el número de teléfono." },
  { t: "Genera el token", d: "En la misma pantalla pulsa «Generar token de acceso» y cópialo (empieza con EAA…). El temporal dura unas 24 horas; para pruebas largas crea un token permanente con un «usuario del sistema»." },
  { t: "Pégalos aquí", d: "Te diremos al instante si algo no cuadra y qué hacer. El token se guarda cifrado y no vuelve a mostrarse." },
];

export function WhatsAppConnect({ connectedId, canManage, embedded, via }: { connectedId: string | null; canManage: boolean; embedded: EmbeddedProps | null; via: "manual" | "embedded" | null }) {
  const router = useRouter();
  const uid = useId();
  const [error, setError] = useState<string | null>(null);
  const [field, setField] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [manual, setManual] = useState(!embedded);
  const [status, setStatus] = useState<Status | null>(null);
  const [to, setTo] = useState("");
  const [testMsg, setTestMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const session = useRef<{ phoneNumberId?: string; wabaId?: string; code?: string; sent?: boolean }>({});

  async function connect(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (busy) return;
    setBusy(true); setError(null); setField(null);
    const f = new FormData(e.currentTarget);
    const r = await postJson<{ fields?: string[] }>("/api/whatsapp/connect", { phoneNumberId: String(f.get("phoneNumberId") ?? ""), accessToken: String(f.get("accessToken") ?? "") });
    setBusy(false);
    if (!r.ok) { setField((r.data as { fields?: string[] }).fields?.[0] ?? null); return setError(r.data.message ?? "No se pudo conectar."); }
    router.refresh();
  }

  async function disconnect() {
    if (!window.confirm("¿Desconectar este número? Dejarás de recibir mensajes.")) return;
    setBusy(true); setError(null);
    try {
      const res = await fetch("/api/whatsapp/connect", { method: "DELETE" });
      if (!res.ok) { const d = (await res.json().catch(() => ({}))) as { message?: string }; setError(d.message ?? "No se pudo desconectar."); }
      else router.refresh();
    } catch { setError("No hay conexión con el servidor."); } finally { setBusy(false); }
  }

  async function check() {
    setBusy(true); setError(null); setStatus(null);
    try {
      const res = await fetch("/api/whatsapp/status", { cache: "no-store" });
      const j = (await res.json().catch(() => ({}))) as Status & { message?: string };
      if (!res.ok) setError(j.message ?? "No se pudo comprobar.");
      else setStatus(j);
    } catch { setError("No hay conexión con el servidor."); } finally { setBusy(false); }
  }

  async function sendTest(e: FormEvent) {
    e.preventDefault();
    setBusy(true); setTestMsg(null);
    const r = await postJson<{ via?: string }>("/api/whatsapp/test", { to });
    setBusy(false);
    setTestMsg(r.ok ? { ok: true, text: `¡Enviado! Mira tu WhatsApp${r.data.via === "plantilla" ? " (llegó la plantilla «hello_world» porque ese teléfono no te había escrito en las últimas 24 h)" : ""}.` } : { ok: false, text: r.data.message ?? "No se pudo enviar." });
  }

  // ---- Conexión con un clic (solo si Meta ya aprobó la app y se activó en el servidor)
  useEffect(() => {
    if (!embedded || connectedId) return;
    const onMessage = (ev: MessageEvent) => {
      if (!/^https:\/\/(www|web)\.facebook\.com$/.test(ev.origin)) return;
      try {
        const d = JSON.parse(String(ev.data)) as { type?: string; event?: string; data?: { phone_number_id?: string; waba_id?: string } };
        if (d.type !== "WA_EMBEDDED_SIGNUP") return;
        if (d.event === "FINISH" || d.event === "FINISH_ONLY_WABA") { session.current.phoneNumberId = d.data?.phone_number_id; session.current.wabaId = d.data?.waba_id; void finish(); }
        else if (d.event === "CANCEL") { setBusy(false); setError("Cancelaste la conexión antes de terminar. Puedes intentarlo de nuevo cuando quieras."); }
      } catch { /* mensajes de otros orígenes o con otro formato */ }
    };
    window.addEventListener("message", onMessage);
    window.fbAsyncInit = () => window.FB?.init({ appId: embedded.appId, autoLogAppEvents: true, xfbml: false, version: embedded.graphVersion });
    if (!document.getElementById("fb-sdk")) {
      const s = document.createElement("script");
      s.id = "fb-sdk"; s.async = true; s.defer = true; s.crossOrigin = "anonymous"; s.src = "https://connect.facebook.net/en_US/sdk.js";
      document.body.appendChild(s);
    } else window.fbAsyncInit();
    return () => window.removeEventListener("message", onMessage);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [embedded, connectedId]);

  async function finish() {
    const s = session.current;
    if (s.sent || !s.code || !s.phoneNumberId || !s.wabaId) return;
    s.sent = true;
    const r = await postJson<{ warnings?: string[] }>("/api/whatsapp/embedded", { code: s.code, phoneNumberId: s.phoneNumberId, wabaId: s.wabaId });
    setBusy(false);
    session.current = {};
    if (!r.ok) return setError(r.data.message ?? "No se pudo completar la conexión.");
    router.refresh();
  }
  function startFacebook() {
    if (!embedded || !window.FB) return setError("Facebook todavía está cargando. Espera unos segundos e inténtalo de nuevo (si tienes un bloqueador de anuncios, desactívalo para esta página).");
    setBusy(true); setError(null); session.current = {};
    window.FB.login((r) => {
      const code = r.authResponse?.code;
      if (!code) { setBusy(false); return setError("No se completó la autorización de Facebook."); }
      session.current.code = code;
      void finish();
    }, { config_id: embedded.configId, response_type: "code", override_default_response_type: true, extras: { setup: {}, featureType: "", sessionInfoVersion: "3" } });
  }

  if (connectedId) {
    return (
      <section className="card-light" style={{ maxWidth: 640 }}>
        <p className="eyebrow">WhatsApp</p>
        <h2 className="mt-3 text-[28px]">Número conectado ✅</h2>
        <p className="muted mt-3">
          ID del número: <strong>{connectedId}</strong>{via === "embedded" ? " · conectado con Facebook" : ""}. Los mensajes que lleguen a ese número aparecerán en tu panel.
        </p>
        <p className="mt-4"><a href="/whatsapp/plantillas" className="link">Plantillas de mensaje</a> <span className="muted">(para escribirle a un cliente pasadas las 24 horas)</span></p>
        <div role="alert" aria-live="assertive">{error && <p className="alert-error mt-4">{error}</p>}</div>
        {canManage && (
          <>
            <div className="mt-6 flex flex-col gap-3">
              <h3 className="text-[18px]">Comprobar que todo funciona</h3>
              <div><button type="button" className="btn btn-sm btn-ghost-light" onClick={check} disabled={busy}>Comprobar conexión</button></div>
              {status && (
                <div role="status" className={status.ok ? "muted" : "alert-error"}>
                  {status.ok ? (
                    <>
                      <p>✔ Meta acepta la conexión: <strong>{status.displayPhoneNumber}</strong>{status.verifiedName ? ` (${status.verifiedName})` : ""}.</p>
                      {status.quality && <p>Calidad del número: {QUALITY[status.quality] ?? status.quality}.</p>}
                      {status.expiresAt ? <p className={status.expiresSoon ? "alert-warn mt-2" : ""}>{status.expiresSoon ? "⚠️ " : ""}El token vence el {new Date(status.expiresAt).toLocaleString("es-VE")}{status.hoursLeft !== null && status.hoursLeft < 48 ? ` (en ${Math.max(status.hoursLeft, 0)} h). Genera uno nuevo antes y vuelve a conectar.` : "."}</p> : status.via === "manual" ? <p>Si usas un token temporal de Meta, dura unas 24 horas. Para pruebas largas crea uno permanente (guía del paso 25).</p> : null}
                    </>
                  ) : <p>✖ {status.problem?.message}</p>}
                </div>
              )}
              <form onSubmit={sendTest} className="flex flex-col gap-2">
                <label htmlFor={`${uid}-to`} className="font-medium">Enviarme un mensaje de prueba</label>
                <div className="flex flex-wrap gap-2">
                  <input id={`${uid}-to`} className="input" style={{ maxWidth: 260 }} inputMode="tel" required maxLength={40} placeholder="584141234567" value={to} onChange={(e) => setTo(e.target.value)} />
                  <button type="submit" className="btn btn-sm btn-primary" disabled={busy || to.trim().length < 8}>Enviar prueba</button>
                </div>
                <p className="hint">Tu teléfono con código de país y solo números. Con el número de prueba de Meta, ese teléfono debe estar en la lista «Para».</p>
                <div role="status" aria-live="polite">{testMsg && <p className={testMsg.ok ? "muted" : "alert-error"}>{testMsg.text}</p>}</div>
              </form>
            </div>
            <button type="button" className="btn btn-ghost-light mt-6" onClick={disconnect} disabled={busy}>Desconectar</button>
          </>
        )}
      </section>
    );
  }

  if (!canManage) return (
    <section className="card-light" style={{ maxWidth: 640 }}>
      <p className="eyebrow">WhatsApp</p>
      <h2 className="mt-3 text-[28px]">Conecta tu número</h2>
      <p className="muted mt-4">Solo dueños y administradores pueden conectar el número.</p>
    </section>
  );

  return (
    <section className="card-light flex flex-col gap-5" style={{ maxWidth: 640 }}>
      <div>
        <p className="eyebrow">WhatsApp</p>
        <h2 className="mt-3 text-[28px]">Conecta tu número</h2>
      </div>
      <div role="alert" aria-live="assertive">{error && <p className="alert-error">{error}</p>}</div>
      {embedded && (
        <div className="flex flex-col gap-3">
          <p className="muted">Pulsa el botón, inicia sesión en Facebook y elige o crea tu cuenta de WhatsApp Business. Nosotros hacemos el resto: no tendrás que copiar ningún token.</p>
          <div><button type="button" className="btn btn-primary" onClick={startFacebook} disabled={busy}>{busy ? "Conectando…" : "Conectar con Facebook"}</button></div>
          <button type="button" className="underline self-start text-[14px]" onClick={() => setManual((m) => !m)}>{manual ? "Ocultar la opción manual" : "Prefiero conectarlo manualmente (avanzado)"}</button>
        </div>
      )}
      {manual && (
        <>
          <ol className="flex flex-col gap-3">
            {STEPS.map((s, i) => (
              <li key={s.t} className="flex gap-3">
                <span className="badge self-start" style={{ minWidth: 28, justifyContent: "center" }} aria-hidden="true">{i + 1}</span>
                <span><strong>{s.t}</strong><span className="muted block text-[14px]">{s.d}</span></span>
              </li>
            ))}
          </ol>
          <form onSubmit={connect} className="flex flex-col gap-5">
            <div className="field">
              <label htmlFor={`${uid}-id`}>ID del número de teléfono (Phone number ID)</label>
              <input id={`${uid}-id`} name="phoneNumberId" className="input" inputMode="numeric" required maxLength={60} autoComplete="off" aria-invalid={field === "phoneNumberId"} placeholder="Ej.: 123456789012345" />
            </div>
            <div className="field">
              <label htmlFor={`${uid}-tk`}>Token de acceso</label>
              <input id={`${uid}-tk`} name="accessToken" className="input" type="password" required maxLength={3000} autoComplete="off" spellCheck={false} aria-invalid={field === "accessToken"} placeholder="EAA…" />
            </div>
            <button type="submit" className="btn btn-primary" disabled={busy}>{busy ? "Validando con Meta…" : "Conectar"}</button>
          </form>
        </>
      )}
    </section>
  );
}
