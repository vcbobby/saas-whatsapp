"use client";

import { useCallback, useEffect, useId, useState, type FormEvent } from "react";
import { postJson } from "@/lib/client";
import { WEBHOOK_EVENTS, WEBHOOK_EVENT_LABEL, type WebhookEvent } from "@/lib/webhooks/events";

interface Endpoint { id: string; url: string; description: string | null; events: string[]; active: boolean; consecutiveFailures: number; disabledReason: string | null; createdAt: string; pending: number }
interface Delivery { id: string; endpointId: string; eventType: string; status: "pendiente" | "entregado" | "fallido"; attempts: number; lastStatus: number | null; lastError: string | null; createdAt: string; finishedAt: string | null }
interface Data { max: number; endpoints: Endpoint[]; deliveries: Delivery[] }

const STATUS_LABEL = { pendiente: "En cola", entregado: "Entregado", fallido: "Falló" } as const;
const fmt = new Intl.DateTimeFormat("es-VE", { dateStyle: "short", timeStyle: "short" });
const eventTitle = (e: string) => (WEBHOOK_EVENT_LABEL as Record<string, { title: string }>)[e]?.title ?? (e === "webhook.test" ? "Prueba" : e);

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
  const [url, setUrl] = useState("");
  const [description, setDescription] = useState("");
  const [events, setEvents] = useState<WebhookEvent[]>(["order.created", "appointment.created"]);
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

  async function create(e: FormEvent) {
    e.preventDefault();
    const r = await run("/api/webhooks", { url, description: description || undefined, events });
    if (r?.secret) {
      setSecret({ value: r.secret, what: "la conexión nueva" });
      setCreating(false); setUrl(""); setDescription(""); setCopied(false);
    }
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
        Cada vez que pasa algo importante (pedido nuevo, cita, conversación que pasa a una persona) se manda un aviso firmado a la dirección que tú indiques, para conectar tu sistema, una hoja de cálculo o una herramienta de automatización. Máximo {data.max} conexiones.
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

      {data.endpoints.length === 0 && !creating && <p className="muted-dark">Todavía no tienes conexiones.</p>}

      {data.endpoints.map((ep) => {
        const mine = data.deliveries.filter((d) => d.endpointId === ep.id).slice(0, 8);
        return (
          <section key={ep.id} className="card-light flex flex-col gap-3" style={{ padding: 20 }} aria-label={`Conexión ${ep.description ?? ep.url}`}>
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-[20px]">{ep.description || "Sin nombre"}</h2>
              <span className="badge" style={ep.active ? undefined : { background: "var(--color-signal-yellow)", color: "var(--color-ink)" }}>{ep.active ? "Activa" : "Desactivada"}</span>
              {ep.pending > 0 && <span className="badge">{ep.pending} en cola</span>}
            </div>
            <p className="break-all font-mono text-[14px]">{ep.url}</p>
            <p className="muted text-[14px]">Avisa de: {ep.events.map(eventTitle).join(" · ")}</p>
            {ep.disabledReason && !ep.active && <p className="alert-warn">{ep.disabledReason}</p>}
            <div className="flex flex-wrap gap-2">
              <button type="button" className="btn btn-sm btn-ghost-light" disabled={busy || !ep.active} onClick={() => void run("/api/webhooks/update", { action: "test", id: ep.id }, "Prueba en cola: aparece en el registro en unos segundos.")}>Enviar prueba</button>
              <button type="button" className="btn btn-sm btn-ghost-light" disabled={busy} onClick={() => void run("/api/webhooks/update", { action: "toggle", id: ep.id, active: !ep.active })}>{ep.active ? "Desactivar" : "Activar"}</button>
              <button type="button" className="btn btn-sm btn-ghost-light" disabled={busy} onClick={() => void rotate(ep.id)}>Nuevo secreto</button>
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
          <div className="field">
            <label htmlFor={`${uid}-url`}>Dirección de destino (https)</label>
            <input id={`${uid}-url`} className="input" type="url" required maxLength={2000} value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://mi-sistema.com/avisos" />
          </div>
          <div className="field">
            <label htmlFor={`${uid}-d`}>Nombre (opcional)</label>
            <input id={`${uid}-d`} className="input" maxLength={120} value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Ej.: Mi sistema de inventario" />
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
            <button type="submit" className="btn btn-primary btn-sm" disabled={busy || events.length === 0}>Crear conexión</button>
            <button type="button" className="btn btn-sm btn-ghost-light" onClick={() => setCreating(false)}>Cancelar</button>
          </div>
        </form>
      ) : (
        <div>
          <button type="button" className="btn btn-primary btn-sm" disabled={data.endpoints.length >= data.max} onClick={() => { setCreating(true); setError(null); }}>Nueva conexión</button>
        </div>
      )}

      <details className="card-light" style={{ padding: 20 }}>
        <summary className="cursor-pointer font-medium">Cómo comprobar que un aviso es auténtico</summary>
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
