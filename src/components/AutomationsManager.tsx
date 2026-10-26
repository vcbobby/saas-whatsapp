"use client";

import { useCallback, useEffect, useId, useState, type FormEvent } from "react";
import { postJson } from "@/lib/client";
import { MESSAGE_TRIGGERS, OFFSET_LABEL, PLACEHOLDERS, STATUS_OPTIONS, TIME_TRIGGERS, TRIGGERS, TRIGGER_LABEL } from "@/lib/automations/rules";
import { EmptyState } from "@/components/EmptyState";

interface Rule { id: string; name: string; triggerEvent: string; onlyStatus: string | null; targetEndpointId: string | null; actionType: "tarea" | "mensaje" | "app"; messageTemplate: string | null; taskTitle: string; taskPriority: number; taskDueMinutes: number | null; offsetMinutes: number | null; active: boolean; runCount: number; lastRunAt: string | null }
interface Note { id: string; ruleName: string | null; customerName: string | null; body: string; status: "pendiente" | "enviado" | "omitido" | "fallido"; reason: string | null; attempts: number; createdAt: string }
interface Data { max: number; rules: Rule[]; notifications: Note[] }
interface Conn { id: string; kind: string; description: string | null; active: boolean }
interface Form { id: string | null; name: string; triggerEvent: string; onlyStatus: string; targetEndpointId: string; actionType: "tarea" | "mensaje" | "app"; messageTemplate: string; taskTitle: string; taskPriority: number; due: string; offset: string }

const PRIORITY = { 1: "Alta", 2: "Normal", 3: "Baja" } as const;
const EMPTY: Form = { id: null, name: "", triggerEvent: "order.created", onlyStatus: "", targetEndpointId: "", actionType: "tarea", messageTemplate: "", taskTitle: "", taskPriority: 2, due: "", offset: "" };
const NOTE_STATUS = { pendiente: "En cola", enviado: "Enviado", omitido: "No se envió", fallido: "Falló" } as const;
const REASON: Record<string, string> = { sin_conversacion: "no hay conversación con el cliente", baja: "el cliente pidió no recibir avisos", limite_24h: "ya se le enviaron 5 avisos en 24 h", ventana_cerrada: "pasaron más de 24 h desde su último mensaje", sin_whatsapp: "no hay WhatsApp conectado", negocio_inactivo: "negocio inactivo", cola_llena: "demasiados avisos en cola" };
const reasonText = (r: string | null) => (r ? REASON[r] ?? r.replace(/^[a-z_]+: /, "") : "");
const fmt = new Intl.DateTimeFormat("es-VE", { dateStyle: "short", timeStyle: "short" });
const isTime = (t: string) => (TIME_TRIGGERS as readonly string[]).includes(t);
const statusesFor = (t: string): readonly string[] => (STATUS_OPTIONS as Record<string, readonly string[]>)[t] ?? [];
const RECIPES: { icon: string; title: string; text: string; form: Partial<Form> }[] = [
  { icon: "✅", title: "Confirmar el pedido por WhatsApp", text: "Cuando confirmas un pedido, el cliente recibe un mensaje.", form: { name: "Confirmar pedido al cliente", triggerEvent: "order.status_changed", onlyStatus: "confirmado", actionType: "mensaje", messageTemplate: "Hola {cliente}, tu pedido #{numero} fue confirmado. Total: {total}. ¡Gracias por tu compra!", taskTitle: "Avisar a {cliente}: pedido {numero} confirmado" } },
  { icon: "📦", title: "Avisar que el pedido fue entregado", text: "Al marcarlo como entregado, el cliente recibe las gracias.", form: { name: "Gracias por tu compra", triggerEvent: "order.status_changed", onlyStatus: "entregado", actionType: "mensaje", messageTemplate: "Hola {cliente}, tu pedido #{numero} fue entregado. ¡Gracias por elegirnos!", taskTitle: "Agradecer a {cliente} (pedido {numero})", taskPriority: 3 } },
  { icon: "⏰", title: "Recordar la cita 24 horas antes", text: "El cliente recibe un recordatorio el día anterior.", form: { name: "Recordatorio de cita", triggerEvent: "appointment.upcoming", offset: "1440", actionType: "mensaje", messageTemplate: "Hola {cliente}, te recordamos tu cita de {servicio} el {fecha}. Si no puedes asistir, avísanos por aquí.", taskTitle: "Recordar cita de {cliente} ({fecha})" } },
  { icon: "🔔", title: "Avisarme en mi app cuando entre un pedido", text: "Un mensaje en Telegram, Discord o Slack con el detalle del pedido.", form: { name: "Pedido nuevo en mi app", triggerEvent: "order.created", actionType: "app", messageTemplate: "🛒 Pedido #{numero} de {cliente} por {total}" } },
  { icon: "👋", title: "Avisarme de cada cliente nuevo", text: "Cuando alguien escribe por primera vez, te llega un aviso a tu app.", form: { name: "Cliente nuevo", triggerEvent: "contact.created", actionType: "app", messageTemplate: "👋 Cliente nuevo: {cliente}" } },
  { icon: "⚠️", title: "Avisarme cuando falte stock", text: "Un mensaje en tu app cuando un producto baja de su mínimo o se agota.", form: { name: "Stock bajo", triggerEvent: "stock.low", actionType: "app", messageTemplate: "⚠️ {producto}: quedan {stock}" } },
  { icon: "🙋", title: "Tarea cuando un cliente pide una persona", text: "Aparece en «Hoy» con prioridad alta para que nadie lo olvide.", form: { name: "Atender a quien pide una persona", triggerEvent: "conversation.handoff", actionType: "tarea", taskTitle: "Atender a {cliente}", taskPriority: 1, due: "30" } },
  { icon: "🕑", title: "Pedido sin confirmar por 2 horas", text: "Te crea una tarea para revisarlo antes de que se enfríe.", form: { name: "Pedido sin confirmar", triggerEvent: "order.pending_stale", offset: "120", actionType: "tarea", taskTitle: "Revisar pedido {numero} de {cliente}", taskPriority: 1 } },
];
const dueText = (m: number | null) => (m === null ? "sin plazo" : m % 1440 === 0 ? `plazo de ${m / 1440} día(s)` : m % 60 === 0 ? `plazo de ${m / 60} h` : `plazo de ${m} min`);

/** Automatizaciones: «cuando pase X, crea una tarea en Hoy». */
export function AutomationsManager() {
  const uid = useId();
  const [data, setData] = useState<Data | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState<Form | null>(null);
  const [conns, setConns] = useState<Conn[]>([]);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/automations", { cache: "no-store" });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) { setLoadError(j.message ?? "No se pudieron cargar las reglas."); return; }
      setLoadError(null); setData(j as Data);
      const c = await fetch("/api/webhooks", { cache: "no-store" }).then((x) => x.json()).catch(() => ({}));
      setConns(Array.isArray(c.endpoints) ? (c.endpoints as Conn[]) : []);
    } catch { setLoadError("No hay conexión con el servidor. Revisa tu internet e intenta de nuevo."); }
  }, []);
  useEffect(() => { const t = setTimeout(() => void load(), 0); return () => clearTimeout(t); }, [load]);

  async function run(body: unknown, path = "/api/automations/update") {
    setBusy(true); setError(null);
    const r = await postJson(path, body);
    setBusy(false);
    if (!r.ok) { setError(r.data.message ?? "No se pudo completar."); return false; }
    await load();
    return true;
  }
  async function save(e: FormEvent) {
    e.preventDefault();
    if (!form) return;
    const dueNum = form.due.trim() === "" ? null : Number(form.due);
    const base = { name: form.name, triggerEvent: form.triggerEvent, onlyStatus: form.onlyStatus || null, actionType: form.actionType, targetEndpointId: form.actionType === "app" ? form.targetEndpointId || null : null, messageTemplate: form.actionType === "tarea" ? null : form.messageTemplate, taskTitle: form.taskTitle, taskPriority: form.taskPriority, taskDueMinutes: dueNum, offsetMinutes: isTime(form.triggerEvent) && form.offset.trim() !== "" ? Number(form.offset) : null };
    const ok = form.id ? await run({ action: "edit", id: form.id, ...base }) : await run(base, "/api/automations");
    if (ok) setForm(null);
  }
  const edit = (r: Rule) => setForm({ id: r.id, name: r.name, triggerEvent: r.triggerEvent, onlyStatus: r.onlyStatus ?? "", targetEndpointId: r.targetEndpointId ?? "", actionType: r.actionType, messageTemplate: r.messageTemplate ?? "", taskTitle: r.taskTitle, taskPriority: r.taskPriority, due: r.taskDueMinutes === null ? "" : String(r.taskDueMinutes), offset: r.offsetMinutes === null ? "" : String(r.offsetMinutes) });
  const startRecipe = (r: (typeof RECIPES)[number]) => { const f = { ...EMPTY, ...r.form } as Form; if (f.actionType === "app" && conns.length === 1) f.targetEndpointId = conns[0]!.id; setForm(f); setError(null); };
  const connName = (id: string | null) => { const c = conns.find((x) => x.id === id); return c ? `${c.description ?? c.kind}` : null; };
  const title = (e: string) => (TRIGGER_LABEL as Record<string, { title: string }>)[e]?.title ?? e;

  if (loadError) return <p className="alert-error" role="alert">{loadError}</p>;
  if (!data) return <p className="muted-dark" role="status">Cargando…</p>;

  return (
    <div className="flex max-w-[900px] flex-col gap-6">
      <p className="muted-dark text-[15px]">
        Una regla dice: «cuando pase esto, haz aquello»: crear una tarea en Hoy, avisar al cliente por WhatsApp o mandarte un mensaje a tu app (Telegram, Discord, Slack…). Empieza con una receta lista para usar o crea la tuya. Máximo {data.max} reglas.
      </p>
      <div aria-live="assertive" role="alert">{error && <p className="alert-error">{error}</p>}</div>

      {data.rules.length === 0 && !form && <EmptyState tone="dark" title="Todavía no tienes reglas" text="Una regla hace algo por ti cuando ocurre un evento, por ejemplo crear una tarea en Hoy cuando entra un pedido nuevo. Pulsa el botón de crear regla para empezar." help="automatizaciones" />}
      {data.rules.map((r) => (
        <section key={r.id} className="card-light flex flex-col gap-2" style={{ padding: 20 }} aria-label={`Regla ${r.name}`}>
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-[20px]">{r.name}</h2>
            <span className="badge" style={r.active ? undefined : { background: "var(--color-signal-yellow)", color: "var(--color-ink)" }}>{r.active ? "Activa" : "Desactivada"}</span>
          </div>
          <p>Cuando: <strong>{title(r.triggerEvent)}</strong>{r.onlyStatus ? ` (nuevo estado: ${r.onlyStatus.replace("_", " ")})` : ""}{r.offsetMinutes !== null ? ` · ${r.offsetMinutes} min` : ""}</p>
          {r.actionType === "app" ? (
            <p>Avisar a {connName(r.targetEndpointId) ? <strong>{connName(r.targetEndpointId)}</strong> : <em>(app borrada: elige otra al editar)</em>}: «{r.messageTemplate}»</p>
          ) : r.actionType === "mensaje" ? (
            <>
              <p>Avisar al cliente por WhatsApp: «{r.messageTemplate}»</p>
              <p className="muted text-[14px]">Si no se puede (pasaron más de 24 h de su último mensaje, etc.), se crea la tarea «{r.taskTitle}» · prioridad {PRIORITY[r.taskPriority as 1 | 2 | 3]} · {dueText(r.taskDueMinutes)}</p>
            </>
          ) : (
            <p>Crear tarea: «{r.taskTitle}» · prioridad {PRIORITY[r.taskPriority as 1 | 2 | 3]} · {dueText(r.taskDueMinutes)}</p>
          )}
          <p className="muted text-[13px]">{r.runCount === 0 ? "Aún no se ha ejecutado." : `Se ejecutó ${r.runCount} vez/veces; la última: ${r.lastRunAt ? fmt.format(new Date(r.lastRunAt)).replace(/\.$/, "") : "—"}`}</p>
          <div className="flex flex-wrap gap-2">
            <button type="button" className="btn btn-sm btn-ghost-light" disabled={busy} onClick={() => edit(r)}>Editar</button>
            <button type="button" className="btn btn-sm btn-ghost-light" disabled={busy} onClick={() => void run({ action: "toggle", id: r.id, active: !r.active })}>{r.active ? "Desactivar" : "Activar"}</button>
            <button type="button" className="btn btn-sm btn-ghost-light" disabled={busy} onClick={() => { if (window.confirm("¿Borrar esta regla? Las tareas ya creadas se quedan.")) void run({ action: "delete", id: r.id }); }}>Borrar</button>
          </div>
        </section>
      ))}

      {data.notifications.length > 0 && (
        <section className="card-light flex flex-col gap-2" style={{ padding: 20 }} aria-label="Avisos a clientes">
          <h2 className="text-[20px]">Últimos avisos a clientes</h2>
          <div className="overflow-x-auto">
            <table className="w-full text-left text-[14px]">
              <caption className="sr-only">Avisos automáticos enviados o intentados por las reglas</caption>
              <thead><tr><th scope="col" className="py-1 pr-3">Cuándo</th><th scope="col" className="pr-3">Cliente</th><th scope="col" className="pr-3">Mensaje</th><th scope="col">Estado</th></tr></thead>
              <tbody>
                {data.notifications.map((n) => (
                  <tr key={n.id}>
                    <td className="py-1 pr-3 align-top">{fmt.format(new Date(n.createdAt))}</td>
                    <td className="pr-3 align-top">{n.customerName ?? "—"}</td>
                    <td className="pr-3 align-top">{n.body}</td>
                    <td className="align-top">{NOTE_STATUS[n.status]}{n.status !== "enviado" && n.status !== "pendiente" && n.reason ? ` · ${reasonText(n.reason)}` : ""}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {!form && (
        <section className="flex flex-col gap-3" aria-label="Recetas">
          <h2 className="text-[20px]">Recetas listas para usar</h2>
          <div className="grid gap-3 sm:grid-cols-2">
            {RECIPES.map((r) => (
              <button key={r.title} type="button" className="card-light text-left" style={{ padding: 14, cursor: "pointer" }} disabled={data.rules.length >= data.max} onClick={() => startRecipe(r)}>
                <span className="text-[17px] font-medium">{r.icon} {r.title}</span>
                <span className="muted block text-[14px]">{r.text}</span>
              </button>
            ))}
          </div>
        </section>
      )}

      {form ? (
        <form onSubmit={save} className="card-light flex flex-col gap-4" style={{ padding: 20 }} aria-label={form.id ? "Editar regla" : "Nueva regla"}>
          <div className="field">
            <label htmlFor={`${uid}-n`}>Nombre de la regla</label>
            <input id={`${uid}-n`} className="input" required maxLength={80} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Ej.: Confirmar pedidos nuevos" />
          </div>
          <div className="field">
            <label htmlFor={`${uid}-t`}>Cuando…</label>
            <select id={`${uid}-t`} className="input" value={form.triggerEvent} onChange={(e) => setForm({ ...form, triggerEvent: e.target.value, onlyStatus: "", offset: isTime(e.target.value) ? form.offset : "", actionType: form.actionType === "mensaje" && !(MESSAGE_TRIGGERS as readonly string[]).includes(e.target.value) ? "tarea" : form.actionType })}>
              {TRIGGERS.map((t) => <option key={t} value={t}>{TRIGGER_LABEL[t].title}</option>)}
            </select>
            <p className="hint">{(TRIGGER_LABEL as Record<string, { hint: string }>)[form.triggerEvent]?.hint}</p>
          </div>
          {isTime(form.triggerEvent) && (
            <div className="field">
              <label htmlFor={`${uid}-o`}>{OFFSET_LABEL[form.triggerEvent as keyof typeof OFFSET_LABEL]}</label>
              <input id={`${uid}-o`} className="input" type="number" inputMode="numeric" min={1} max={43200} step={1} required value={form.offset} onChange={(e) => setForm({ ...form, offset: e.target.value })} />
            </div>
          )}
          {statusesFor(form.triggerEvent).length > 0 && (
            <div className="field">
              <label htmlFor={`${uid}-s`}>Solo si el nuevo estado es</label>
              <select id={`${uid}-s`} className="input" value={form.onlyStatus} onChange={(e) => setForm({ ...form, onlyStatus: e.target.value })}>
                <option value="">Cualquiera</option>
                {statusesFor(form.triggerEvent).map((s) => <option key={s} value={s}>{s.replace("_", " ")}</option>)}
              </select>
            </div>
          )}
          <div className="field">
            <label htmlFor={`${uid}-a`}>Hacer esto</label>
            <select id={`${uid}-a`} className="input" value={form.actionType} onChange={(e) => setForm({ ...form, actionType: e.target.value as Form["actionType"] })}>
              <option value="tarea">Crear una tarea en «Hoy»</option>
              <option value="mensaje" disabled={!(MESSAGE_TRIGGERS as readonly string[]).includes(form.triggerEvent)}>Avisar al cliente por WhatsApp</option>
              <option value="app">Avisarme en una app conectada (Telegram, Discord, Slack…)</option>
            </select>
          </div>
          {form.actionType === "app" && (
            <>
              <div className="field">
                <label htmlFor={`${uid}-ap`}>¿A qué app?</label>
                {conns.length === 0 ? (
                  <p className="hint">Todavía no tienes apps conectadas. <a href="/conexiones" className="underline">Conecta una en «Conexiones»</a> y vuelve.</p>
                ) : (
                  <select id={`${uid}-ap`} className="input" required value={form.targetEndpointId} onChange={(e) => setForm({ ...form, targetEndpointId: e.target.value })}>
                    <option value="">Elige…</option>
                    {conns.map((c) => <option key={c.id} value={c.id}>{c.description ?? c.kind}{c.active ? "" : " (desactivada)"}</option>)}
                  </select>
                )}
              </div>
              <div className="field">
                <label htmlFor={`${uid}-am`}>Mensaje que recibirás</label>
                <textarea id={`${uid}-am`} className="input" rows={3} required maxLength={600} value={form.messageTemplate} onChange={(e) => setForm({ ...form, messageTemplate: e.target.value })} />
                <p className="hint">Puedes usar: {PLACEHOLDERS.join(" ")}</p>
              </div>
            </>
          )}
          {form.actionType === "mensaje" && (
            <div className="field">
              <label htmlFor={`${uid}-m`}>Mensaje para el cliente</label>
              <textarea id={`${uid}-m`} className="input" rows={3} required maxLength={600} value={form.messageTemplate} onChange={(e) => setForm({ ...form, messageTemplate: e.target.value })} placeholder="Ej.: Hola {cliente}, tu pedido #{numero} fue confirmado. Total: {total}." />
              <p className="hint">Solo se envía dentro de las 24 h siguientes al último mensaje del cliente (regla de WhatsApp), máximo 5 avisos por cliente al día, y no se envía a quien escriba BAJA. Puedes usar: {PLACEHOLDERS.join(" ")}</p>
            </div>
          )}
          {form.actionType !== "app" && (<>
          <div className="field">
            <label htmlFor={`${uid}-ti`}>{form.actionType === "mensaje" ? "Tarea si no se puede enviar el mensaje" : "Título de la tarea"}</label>
            <input id={`${uid}-ti`} className="input" required maxLength={120} value={form.taskTitle} onChange={(e) => setForm({ ...form, taskTitle: e.target.value })} placeholder="Ej.: Preparar pedido {numero} de {cliente}" />
            <p className="hint">Puedes usar: {PLACEHOLDERS.join(" ")}</p>
          </div>
          <div className="flex flex-wrap gap-4">
            <div className="field">
              <label htmlFor={`${uid}-p`}>Prioridad</label>
              <select id={`${uid}-p`} className="input" value={form.taskPriority} onChange={(e) => setForm({ ...form, taskPriority: Number(e.target.value) })}>
                <option value={1}>Alta</option><option value={2}>Normal</option><option value={3}>Baja</option>
              </select>
            </div>
            <div className="field">
              <label htmlFor={`${uid}-d`}>Plazo en minutos (opcional)</label>
              <input id={`${uid}-d`} className="input" type="number" min={1} max={43200} value={form.due} onChange={(e) => setForm({ ...form, due: e.target.value })} placeholder="Ej.: 60" />
            </div>
          </div>
          </>)}
          <div className="flex gap-3">
            <button type="submit" className="btn btn-primary btn-sm" disabled={busy || (form.actionType === "app" && !form.targetEndpointId)}>{form.id ? "Guardar cambios" : "Crear regla"}</button>
            <button type="button" className="btn btn-sm btn-ghost-light" onClick={() => { setForm(null); setError(null); }}>Cancelar</button>
          </div>
        </form>
      ) : (
        <div><button type="button" className="btn btn-primary btn-sm" disabled={data.rules.length >= data.max} onClick={() => { setForm(EMPTY); setError(null); }}>Nueva regla</button></div>
      )}
    </div>
  );
}
