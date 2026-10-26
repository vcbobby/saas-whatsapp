"use client";

import { useCallback, useEffect, useId, useState, type FormEvent } from "react";
import { postJson } from "@/lib/client";
import { WEBHOOK_EVENTS, WEBHOOK_EVENT_LABEL, type WebhookEvent } from "@/lib/webhooks/events";
import { EmptyState } from "@/components/EmptyState";
import { APPS, APP_KINDS, type AppKind } from "@/lib/connections/apps";

interface Endpoint { id: string; kind: AppKind; url: string; description: string | null; events: string[]; active: boolean; consecutiveFailures: number; disabledReason: string | null; createdAt: string; pending: number }
interface Delivery { id: string; endpointId: string; eventType: string; status: "pendiente" | "entregado" | "fallido"; attempts: number; lastStatus: number | null; lastError: string | null; createdAt: string; finishedAt: string | null }
interface Data { max: number; endpoints: Endpoint[]; deliveries: Delivery[] }

const STATUS_LABEL = { pendiente: "En cola", entregado: "Entregado", fallido: "Falló" } as const;
const fmt = new Intl.DateTimeFormat("es-VE", { dateStyle: "short", timeStyle: "short" });
const eventTitle = (e: string) => (WEBHOOK_EVENT_LABEL as Record<string, { title: string }>)[e]?.title ?? (e === "webhook.test" ? "Prueba" : e === "automation.message" ? "Aviso de una regla" : e);
const DEFAULT_EVENTS: WebhookEvent[] = ["order.created", "appointment.created", "conversation.handoff"];
const APP_ICON: Record<AppKind, string> = { telegram: "✈️", discord: "🎮", slack: "💬", zapier: "⚡", make: "🔧", n8n: "🧩", webhook: "🛠️" };

const NODE_SNIPPET = `import { createHmac, timingSafeEqual } from "node:crypto";

// body = texto EXACTO recibido (sin convertirlo a objeto antes)
function firmaValida(secreto, cabecera, body) {
  const p = Object.fromEntries(cabecera.split(",").map((x) => x.split("=")));
  if (Math.abs(Date.now() / 1000 - Number(p.t)) > 300) return false;
  const esperado = createHmac("sha256", secreto).update(p.t + "." + body).digest("hex");
  return esperado.length === p.v1.length && timingSafeEqual(Buffer.from(esperado), Buffer.from(p.v1));
}
// cabecera = req.headers["x-webhook-signature"]`;

const PY_SNIPPET = `import hmac, hashlib, time

def firma_valida(secreto: str, cabecera: str, body: bytes) -> bool:
    p = dict(x.split("=", 1) for x in cabecera.split(","))
    if abs(time.time() - int(p["t"])) > 300:
        return False
    esperado = hmac.new(secreto.encode(), p["t"].encode() + b"." + body, hashlib.sha256).hexdigest()
    return hmac.compare_digest(esperado, p["v1"])
# cabecera = request.headers["X-Webhook-Signature"]`;

/** Conexiones: avisos firmados que el sistema manda a otros programas del negocio cuando pasa algo (pedido, cita, traspaso). */
export function ConnectionsManager() {
  const uid = useId();
  const [data, setData] = useState<Data | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [secret, setSecret] = useState<{ value: string; what: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const [creating, setCreating] = useState(false);
  const [kind, setKind] = useState<AppKind | null>(null);
  const [url, setUrl] = useState("");
  const [token, setToken] = useState("");
  const [chatId, setChatId] = useState("");
  const [chats, setChats] = useState<{ id: string; title: string }[] | null>(null);
  const [description, setDescription] = useState("");
  const [events, setEvents] = useState<WebhookEvent[]>(DEFAULT_EVENTS);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/webhooks", { cache: "no-store" });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) { setLoadError(j.message ?? "No se pudieron cargar las conexiones."); return; }
      setLoadError(null);
      setData(j as Data);
    } catch {
      setLoadError("No hay conexión con el servidor. Revisa tu internet e intenta de nuevo.");
    }
  }, []);
  useEffect(() => { const t = setTimeout(() => void load(), 0); return () => clearTimeout(t); }, [load]);

  async function run(path: string, body: unknown, okMsg?: string) {
    setBusy(true); setError(null); setNotice(null);
    const r = await postJson<{ secret?: string; id?: string }>(path, body);
    setBusy(false);
    if (!r.ok) { setError(r.data.message ?? "No se pudo completar."); return null; }
    if (okMsg) setNotice(okMsg);
    await load();
    return r.data;
  }

  function reset() { setCreating(false); setKind(null); setUrl(""); setToken(""); setChatId(""); setChats(null); setDescription(""); setEvents(DEFAULT_EVENTS); }
  async function create(e: FormEvent) {
    e.preventDefault();
    if (!kind) return;
    const r = await run("/api/webhooks", { kind, url: url || undefined, token: token || undefined, chatId: chatId || undefined, description: description || undefined, events },
      kind === "webhook" ? undefined : "¡Conectado! Te acabamos de mandar un mensaje de prueba: en unos segundos debe aparecer en tu app (mira el registro de abajo).");
    if (!r) return;
    if (r.secret) { setSecret({ value: r.secret, what: "la conexión nueva" }); setCopied(false); }
    reset();
  }
  async function findChats() {
    setBusy(true); setError(null); setChats(null);
    const r = await postJson<{ bot?: string; chats?: { id: string; title: string }[] }>("/api/webhooks/telegram", { token });
    setBusy(false);
    if (!r.ok) { setError(r.data.message ?? "No se pudo buscar el chat."); return; }
    const list = r.data.chats ?? [];
    setChats(list);
    if (list.length === 1) setChatId(list[0]!.id);
    if (list.length === 0) setError(`Todavía no vemos mensajes. Abre Telegram, escríbele «hola» a @${r.data.bot ?? "tu bot"} y vuelve a pulsar «Buscar mi chat».`);
  }
  async function rotate(id: string) {
    if (!window.confirm("Se creará un secreto nuevo y el anterior dejará de servir al instante. ¿Seguir?")) return;
    const r = await run("/api/webhooks/update", { action: "rotate", id });
    if (r?.secret) { setSecret({ value: r.secret, what: "la conexión" }); setCopied(false); }
  }
  async function remove(id: string) {
    if (!window.confirm("¿Borrar esta conexión y su registro de envíos?")) return;
    await run("/api/webhooks/update", { action: "delete", id }, "Conexión borrada.");
  }
  async function copy() {
    if (!secret) return;
    try { await navigator.clipboard.writeText(secret.value); setCopied(true); } catch { setCopied(false); }
  }
  const toggleEvent = (ev: WebhookEvent) => setEvents((cur) => (cur.includes(ev) ? cur.filter((x) => x !== ev) : [...cur, ev]));

  if (loadError) return <p className="alert-error" role="alert">{loadError}</p>;
  if (!data) return <p className="muted-dark" role="status">Cargando…</p>;

  return (
    <div className="flex max-w-[900px] flex-col gap-6">
      <p className="muted-dark text-[15px]">
        Conecta tu negocio con las apps que ya usas: recibe un mensaje en Telegram, Discord o Slack cuando entra un pedido o una cita, o envía los datos a Zapier, Make o n8n para guardarlos en una hoja de cálculo, mandar correos y mucho más. Máximo {data.max} conexiones.
      </p>

      {secret && (
        <div className="alert-warn" role="alert">
          <p><strong>Guarda este secreto ahora.</strong> Es lo que usa {secret.what} para firmar los avisos y no se vuelve a mostrar.</p>
          <p className="mt-2 break-all font-mono text-[14px]" data-testid="secret">{secret.value}</p>
          <div className="mt-3 flex gap-3">
            <button type="button" className="btn btn-sm btn-ghost-light" onClick={() => void copy()}>{copied ? "Copiado" : "Copiar"}</button>
            <button type="button" className="btn btn-sm btn-ghost-light" onClick={() => setSecret(null)}>Ya lo guardé</button>
          </div>
        </div>
      )}
      <div aria-live="assertive" role="alert">{error && <p className="alert-error">{error}</p>}</div>
      <div aria-live="polite" role="status">{notice && <p className="muted-dark">{notice}</p>}</div>

      {data.endpoints.length === 0 && !creating && <EmptyState tone="dark" title="Todavía no tienes conexiones" text="Una conexión avisa a otra aplicación cuando pasa algo en tu negocio. Pulsa «Conectar una app» y elige la que uses; si no usas otras herramientas, puedes ignorar esta pantalla." help="conexiones" />}

      {data.endpoints.map((ep) => {
        const mine = data.deliveries.filter((d) => d.endpointId === ep.id).slice(0, 8);
        return (
          <section key={ep.id} className="card-light flex flex-col gap-3" style={{ padding: 20 }} aria-label={`Conexión ${ep.description ?? ep.url}`}>
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-[20px]">{APP_ICON[ep.kind] ?? ""} {ep.description || APPS[ep.kind]?.name || "Sin nombre"}</h2>
              <span className="badge">{APPS[ep.kind]?.name ?? ep.kind}</span>
              <span className="badge" style={ep.active ? undefined : { background: "var(--color-signal-yellow)", color: "var(--color-ink)" }}>{ep.active ? "Activa" : "Desactivada"}</span>
              {ep.pending > 0 && <span className="badge">{ep.pending} en cola</span>}
            </div>
            <p className="break-all font-mono text-[14px]">{ep.url}</p>
            <p className="muted text-[14px]">Avisa de: {ep.events.map(eventTitle).join(" · ")}</p>
            {ep.disabledReason && !ep.active && <p className="alert-warn">{ep.disabledReason}</p>}
            <div className="flex flex-wrap gap-2">
              <button type="button" className="btn btn-sm btn-ghost-light" disabled={busy || !ep.active} onClick={() => void run("/api/webhooks/update", { action: "test", id: ep.id }, "Prueba en cola: aparece en el registro en unos segundos.")}>Enviar prueba</button>
              <button type="button" className="btn btn-sm btn-ghost-light" disabled={busy} onClick={() => void run("/api/webhooks/update", { action: "toggle", id: ep.id, active: !ep.active })}>{ep.active ? "Desactivar" : "Activar"}</button>
              {ep.kind === "webhook" && <button type="button" className="btn btn-sm btn-ghost-light" disabled={busy} onClick={() => void rotate(ep.id)}>Nuevo secreto</button>}
              <button type="button" className="btn btn-sm btn-ghost-light" disabled={busy} onClick={() => void remove(ep.id)}>Borrar</button>
            </div>
            {mine.length > 0 && (
              <div className="overflow-x-auto">
                <table className="w-full text-left text-[14px]">
                  <caption className="sr-only">Últimos envíos de esta conexión</caption>
                  <thead><tr><th scope="col" className="py-1 pr-3">Cuándo</th><th scope="col" className="pr-3">Aviso</th><th scope="col" className="pr-3">Estado</th><th scope="col" /></tr></thead>
                  <tbody>
                    {mine.map((d) => (
                      <tr key={d.id}>
                        <td className="py-1 pr-3">{fmt.format(new Date(d.createdAt))}</td>
                        <td className="pr-3">{eventTitle(d.eventType)}</td>
                        <td className="pr-3">{STATUS_LABEL[d.status]}{d.status !== "entregado" && d.lastError ? ` · ${d.lastError}` : ""}{d.status === "pendiente" && d.attempts > 0 ? ` (intento ${d.attempts})` : ""}</td>
                        <td>{d.status === "fallido" && ep.active && <button type="button" className="btn btn-sm btn-ghost-light" disabled={busy} onClick={() => void run("/api/webhooks/update", { action: "retry", deliveryId: d.id }, "Reintento en cola.")}>Reintentar</button>}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        );
      })}

      {creating ? (
        <form onSubmit={create} className="card-light flex flex-col gap-4" style={{ padding: 20 }} aria-label="Nueva conexión">
          {!kind ? (
            <>
              <h2 className="text-[20px]">¿Con qué app quieres conectarte?</h2>
              <div className="grid gap-3 sm:grid-cols-2">
                {APP_KINDS.map((k) => (
                  <button key={k} type="button" className="card-light text-left" style={{ padding: 14, cursor: "pointer" }} onClick={() => { setKind(k); setError(null); }}>
                    <span className="text-[18px] font-medium">{APP_ICON[k]} {APPS[k].name}</span>
                    <span className="muted block text-[14px]">{APPS[k].tagline}</span>
                  </button>
                ))}
              </div>
              <div><button type="button" className="btn btn-sm btn-ghost-light" onClick={reset}>Cancelar</button></div>
            </>
          ) : (
            <>
              <h2 className="text-[20px]">{APP_ICON[kind]} Conectar {APPS[kind].name}</h2>
              <ol className="list-decimal pl-5 text-[15px]">{APPS[kind].steps.map((st) => <li key={st} className="mb-1">{st}</li>)}</ol>
              {kind === "telegram" ? (
                <>
                  <div className="field">
                    <label htmlFor={`${uid}-tok`}>{APPS[kind].field}</label>
                    <input id={`${uid}-tok`} className="input" required autoComplete="off" spellCheck={false} maxLength={200} value={token} onChange={(e) => { setToken(e.target.value); setChats(null); setChatId(""); }} placeholder={APPS[kind].placeholder} />
                  </div>
                  <div><button type="button" className="btn btn-sm btn-ghost-light" disabled={busy || token.trim().length < 20} onClick={() => void findChats()}>Buscar mi chat</button></div>
                  {chats && chats.length > 0 && (
                    <fieldset className="flex flex-col gap-2">
                      <legend className="mb-1 font-medium">¿Dónde quieres recibir los avisos?</legend>
                      {chats.map((c) => (
                        <label key={c.id} className="flex items-center gap-2"><input type="radio" name={`${uid}-chat`} checked={chatId === c.id} onChange={() => setChatId(c.id)} /> {c.title}</label>
                      ))}
                    </fieldset>
                  )}
                </>
              ) : (
                <div className="field">
                  <label htmlFor={`${uid}-url`}>{APPS[kind].field}</label>
                  <input id={`${uid}-url`} className="input" type="url" required autoComplete="off" spellCheck={false} maxLength={2000} value={url} onChange={(e) => setUrl(e.target.value)} placeholder={APPS[kind].placeholder} />
                </div>
              )}
              <div className="field">
                <label htmlFor={`${uid}-d`}>Nombre (opcional)</label>
                <input id={`${uid}-d`} className="input" maxLength={120} value={description} onChange={(e) => setDescription(e.target.value)} placeholder={`Ej.: ${APPS[kind].name} del equipo`} />
              </div>
              <fieldset className="flex flex-col gap-2">
                <legend className="mb-1 font-medium">Avisar cuando…</legend>
                {WEBHOOK_EVENTS.map((ev) => (
                  <label key={ev} className="flex items-start gap-2">
                    <input type="checkbox" checked={events.includes(ev)} onChange={() => toggleEvent(ev)} />
                    <span><strong>{WEBHOOK_EVENT_LABEL[ev].title}</strong><span className="muted block text-[13px]">{WEBHOOK_EVENT_LABEL[ev].hint}</span></span>
                  </label>
                ))}
              </fieldset>
              <div className="flex gap-3">
                <button type="submit" className="btn btn-primary btn-sm" disabled={busy || events.length === 0 || (kind === "telegram" && !chatId)}>Conectar y enviar prueba</button>
                <button type="button" className="btn btn-sm btn-ghost-light" onClick={() => { setKind(null); setError(null); }}>Atrás</button>
                <button type="button" className="btn btn-sm btn-ghost-light" onClick={reset}>Cancelar</button>
              </div>
            </>
          )}
        </form>
      ) : (
        <div>
          <button type="button" className="btn btn-primary btn-sm" disabled={data.endpoints.length >= data.max} onClick={() => { setCreating(true); setError(null); }}>Conectar una app</button>
        </div>
      )}

      <details className="card-light" style={{ padding: 20 }}>
        <summary className="cursor-pointer font-medium">Para programadores: cómo comprobar que un aviso es auténtico (conexión «Avanzado»)</summary>
        <p className="muted mt-3 text-[14px]">
          Cada aviso llega por POST con el cuerpo en JSON y la cabecera <code>X-Webhook-Signature: t=…,v1=…</code>. Calcula HMAC-SHA256 con tu secreto sobre <code>t + &quot;.&quot; + cuerpo exacto</code>, compáralo con <code>v1</code> y rechaza avisos con más de 5 minutos de antigüedad. Un mismo aviso puede llegar más de una vez: usa el campo <code>id</code> para no procesarlo dos veces. Responde con 2xx para darlo por recibido.
        </p>
        <p className="mt-3 font-medium">Node.js</p>
        <pre className="mt-1 overflow-x-auto text-[13px]"><code>{NODE_SNIPPET}</code></pre>
        <p className="mt-3 font-medium">Python</p>
        <pre className="mt-1 overflow-x-auto text-[13px]"><code>{PY_SNIPPET}</code></pre>
      </details>
    </div>
  );
}
