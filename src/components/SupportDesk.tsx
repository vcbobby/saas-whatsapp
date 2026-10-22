"use client";

import { useCallback, useEffect, useId, useRef, useState, type FormEvent } from "react";
import { ADMIN_STATUS_LABEL, BODY_MAX, CUSTOMER_STATUS_LABEL, SUBJECT_MAX, type TicketStatus } from "@/lib/support/schema";

type Mode = "customer" | "admin";
interface Row { id: string; subject: string; status: TicketStatus; lastFrom: "user" | "support"; lastMessageAt: string; tenantName?: string; email?: string | null; messages?: number }
interface Msg { id: string; fromSupport: boolean; body: string; createdAt: string }
interface Thread { id: string; subject: string; status: TicketStatus; tenantName?: string; email?: string | null; messages: Msg[] }

const FILTERS: { id: string; label: string; query: string }[] = [
  { id: "open", label: "Por responder", query: "?status=open" },
  { id: "answered", label: "Respondidos", query: "?status=answered" },
  { id: "closed", label: "Cerrados", query: "?status=closed" },
  { id: "all", label: "Todos", query: "" },
];

const fmt = new Intl.DateTimeFormat("es-VE", { dateStyle: "medium", timeStyle: "short" });
const when = (iso: string) => fmt.format(new Date(iso));
const NO_NET = "No hay conexión con el servidor. Revisa tu internet e intenta de nuevo.";

async function call<T>(url: string, init?: RequestInit): Promise<{ ok: boolean; status: number; data: T & { message?: string } }> {
  try {
    const res = await fetch(url, { cache: "no-store", ...init, headers: init?.body ? { "content-type": "application/json" } : undefined });
    return { ok: res.ok, status: res.status, data: (await res.json().catch(() => ({}))) as T & { message?: string } };
  } catch {
    return { ok: false, status: 0, data: { message: NO_NET } as T & { message?: string } };
  }
}

/** Bandeja de soporte: la usa el negocio (escribe y lee respuestas) y el súper admin (responde). Solo texto, sin HTML. */
export function SupportDesk({ mode }: { mode: Mode }) {
  const uid = useId();
  const base = mode === "admin" ? "/api/admin/support" : "/api/support";
  const label = mode === "admin" ? ADMIN_STATUS_LABEL : CUSTOMER_STATUS_LABEL;
  const [filter, setFilter] = useState("open");
  const [rows, setRows] = useState<Row[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [thread, setThread] = useState<Thread | null>(null);
  const [reply, setReply] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [sent, setSent] = useState(false);
  const headingRef = useRef<HTMLHeadingElement>(null);

  const loadList = useCallback(async () => {
    const q = mode === "admin" ? (FILTERS.find((f) => f.id === filter)?.query ?? "") : "";
    const r = await call<{ tickets: Row[] }>(base + q);
    if (r.ok) { setRows(r.data.tickets); setLoadError(null); } else setLoadError(r.data.message ?? "No se pudo cargar.");
  }, [base, filter, mode]);

  const loadThread = useCallback(async (id: string) => {
    const r = await call<{ ticket: Thread & { messages: Msg[] }; messages?: Msg[] }>(`${base}/thread?id=${encodeURIComponent(id)}`);
    if (!r.ok) { setError(r.data.message ?? "No se pudo abrir la consulta."); return; }
    // El negocio recibe { ticket, messages }; el súper admin recibe todo dentro de ticket.
    const t = r.data.ticket;
    setThread({ ...t, messages: mode === "admin" ? t.messages : (r.data.messages ?? []) });
  }, [base, mode]);

  useEffect(() => {
    let off = false;
    const run = () => { if (!off) void loadList(); };
    run();
    const t = setInterval(run, 30_000);
    return () => { off = true; clearInterval(t); };
  }, [loadList]);

  useEffect(() => { if (thread) headingRef.current?.focus(); }, [thread?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  function openTicket(id: string) { setThread(null); setError(null); setOpenId(id); void loadThread(id); }

  async function create(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    setBusy(true); setError(null);
    const r = await call<{ id?: string }>(base, { method: "POST", body: JSON.stringify({ subject, body }) });
    setBusy(false);
    if (!r.ok) { setError(r.data.message ?? "No se pudo enviar."); return; }
    setSubject(""); setBody(""); setCreating(false); setSent(true);
    await loadList();
    if (r.data.id) openTicket(r.data.id);
  }

  async function send(e: FormEvent) {
    e.preventDefault();
    if (busy || !thread) return;
    setBusy(true); setError(null);
    const r = await call(`${base}/reply`, { method: "POST", body: JSON.stringify({ id: thread.id, body: reply }) });
    setBusy(false);
    if (!r.ok) { setError(r.data.message ?? "No se pudo enviar."); return; }
    setReply("");
    await Promise.all([loadThread(thread.id), loadList()]);
  }

  async function setStatus(status: "open" | "closed") {
    if (busy || !thread) return;
    setBusy(true); setError(null);
    const r = mode === "admin"
      ? await call(`${base}/status`, { method: "POST", body: JSON.stringify({ id: thread.id, status }) })
      : await call(`${base}/close`, { method: "POST", body: JSON.stringify({ id: thread.id }) });
    setBusy(false);
    if (!r.ok) { setError(r.data.message ?? "No se pudo cambiar."); return; }
    await Promise.all([loadThread(thread.id), loadList()]);
  }

  const mine = (m: Msg) => (mode === "admin" ? m.fromSupport : !m.fromSupport);

  return (
    <div className="mt-8 grid gap-6" style={{ maxWidth: 900 }}>
      {mode === "admin" && (
        <div className="flex flex-wrap gap-2" role="group" aria-label="Filtrar consultas">
          {FILTERS.map((f) => (
            <button key={f.id} type="button" aria-pressed={filter === f.id} className={`btn btn-sm ${filter === f.id ? "btn-primary" : "btn-ghost-dark"}`} onClick={() => { setFilter(f.id); setRows(null); }}>{f.label}</button>
          ))}
        </div>
      )}

      {mode === "customer" && !creating && !thread && (
        <div>
          <button type="button" className="btn btn-primary" onClick={() => { setCreating(true); setSent(false); setError(null); }}>Nueva consulta</button>
          {sent && <p className="alert-ok mt-4" role="status">Enviamos tu consulta. Aquí verás la respuesta; también puedes seguir escribiendo en ella.</p>}
        </div>
      )}

      {mode === "customer" && creating && (
        <form onSubmit={create} className="card-light grid gap-4" aria-label="Nueva consulta">
          <h2 className="text-[22px]">Nueva consulta</h2>
          <div className="field">
            <label htmlFor={`${uid}-s`}>Asunto</label>
            <input id={`${uid}-s`} className="input" value={subject} maxLength={SUBJECT_MAX} required onChange={(e) => setSubject(e.target.value)} placeholder="Ej.: No me responde el asistente" />
          </div>
          <div className="field">
            <label htmlFor={`${uid}-b`}>Cuéntanos qué pasa</label>
            <textarea id={`${uid}-b`} className="input" rows={6} value={body} maxLength={BODY_MAX} required onChange={(e) => setBody(e.target.value)} />
            <p className="hint">Mientras más detalle (qué pantalla, qué esperabas, qué pasó), más rápido te ayudamos. No escribas contraseñas.</p>
          </div>
          {error && <p className="alert-error" role="alert">{error}</p>}
          <div className="flex flex-wrap gap-3">
            <button type="submit" className="btn btn-primary" disabled={busy || subject.trim().length < 3 || !body.trim()}>{busy ? "Enviando…" : "Enviar consulta"}</button>
            <button type="button" className="btn btn-ghost-light" onClick={() => { setCreating(false); setError(null); }}>Cancelar</button>
          </div>
        </form>
      )}

      {openId && thread ? (
        <section className="card-light" aria-labelledby={`${uid}-t`}>
          <button type="button" className="link text-[14px]" style={{ background: "none", border: 0, padding: 0, cursor: "pointer", textDecoration: "underline" }} onClick={() => { setOpenId(null); setThread(null); setError(null); }}>← Volver a la lista</button>
          <h2 id={`${uid}-t`} ref={headingRef} tabIndex={-1} className="mt-3 text-[24px]" style={{ outline: "none" }}>{thread.subject}</h2>
          <p className="muted mt-1 text-[14px]">
            <span className="badge">{label[thread.status]}</span>
            {mode === "admin" && <> · {thread.tenantName}{thread.email ? ` · ${thread.email}` : ""}</>}
          </p>
          <ul className="mt-5 grid gap-3" style={{ listStyle: "none", padding: 0 }} aria-label="Mensajes">
            {thread.messages.map((m) => (
              <li key={m.id} style={{ justifySelf: mine(m) ? "end" : "start", maxWidth: "92%" }}>
                <p className="muted text-[12px]" style={{ textAlign: mine(m) ? "right" : "left" }}>
                  {mode === "admin" ? (m.fromSupport ? "Soporte" : "Cliente") : (m.fromSupport ? "Soporte" : "Tú")} · {when(m.createdAt)}
                </p>
                <div style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere", padding: "10px 14px", borderRadius: 14, background: m.fromSupport ? "rgba(61,220,145,0.22)" : "rgba(19,35,34,0.08)" }}>{m.body}</div>
              </li>
            ))}
          </ul>
          <form onSubmit={send} className="mt-6 grid gap-3">
            <div className="field">
              <label htmlFor={`${uid}-r`}>{thread.status === "closed" ? "Escribir de nuevo (reabre la consulta)" : "Tu respuesta"}</label>
              <textarea id={`${uid}-r`} className="input" rows={4} value={reply} maxLength={BODY_MAX} onChange={(e) => setReply(e.target.value)} />
            </div>
            {error && <p className="alert-error" role="alert">{error}</p>}
            <div className="flex flex-wrap gap-3">
              <button type="submit" className="btn btn-primary" disabled={busy || !reply.trim()}>{busy ? "Enviando…" : "Enviar"}</button>
              {thread.status !== "closed"
                ? <button type="button" className="btn btn-ghost-light" disabled={busy} onClick={() => void setStatus("closed")}>{mode === "admin" ? "Cerrar consulta" : "Ya se resolvió: cerrar"}</button>
                : mode === "admin" && <button type="button" className="btn btn-ghost-light" disabled={busy} onClick={() => void setStatus("open")}>Reabrir</button>}
            </div>
          </form>
        </section>
      ) : openId ? (
        <p className="muted-dark" role="status">{error ?? "Cargando…"}</p>
      ) : loadError && !rows ? (
        <p className="alert-warn" role="alert">{loadError}</p>
      ) : rows === null ? (
        <p className="muted-dark" role="status">Cargando…</p>
      ) : rows.length === 0 ? (
        creating ? null : (
          <div className="card-light">
            <h2 className="text-[22px]">{mode === "admin" ? "No hay consultas en esta lista" : "Todavía no has escrito a soporte"}</h2>
            <p className="muted mt-2">{mode === "admin" ? "Cuando un negocio escriba, aparecerá aquí." : "Si algo no funciona o tienes una duda que la Ayuda no resuelve, abre una consulta y te respondemos aquí mismo."}</p>
          </div>
        )
      ) : (
        <ul className="grid gap-3" style={{ listStyle: "none", padding: 0 }} aria-label="Consultas">
          {rows.map((t) => {
            const attention = mode === "admin" ? t.status === "open" : t.status === "answered";
            return (
              <li key={t.id}>
                <button type="button" className="card-light block w-full text-left" style={{ cursor: "pointer", borderColor: attention ? "var(--color-neon-pulse)" : undefined }} onClick={() => openTicket(t.id)}>
                  <span className="flex flex-wrap items-baseline justify-between gap-2">
                    <strong style={{ fontWeight: 600 }}>{t.subject}</strong>
                    <span className="badge">{label[t.status]}</span>
                  </span>
                  <span className="muted mt-1 block text-[13px]">
                    {mode === "admin" && <>{t.tenantName}{t.email ? ` · ${t.email}` : ""} · {t.messages} {t.messages === 1 ? "mensaje" : "mensajes"} · </>}
                    {when(t.lastMessageAt)}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
