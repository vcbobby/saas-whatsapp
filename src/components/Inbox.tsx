"use client";

import { TemplateSender } from "./TemplateSender";
import Link from "next/link";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { CONTACT_LABELS, CONTACT_LABEL_TEXT, CONVERSATION_STATUS_LABEL, MEDIA_LABEL, WORK_TYPE_LABEL, type ContactLabel, type WorkType } from "@/lib/work/labels";
import { postJson } from "@/lib/client";
import { messageTime, relativeTime } from "@/lib/work/time";
import { EmptyState } from "@/components/EmptyState";

type Status = "bot" | "human" | "closed";
interface ConvRow {
  id: string;
  status: Status;
  handoffReason: string | null;
  lastMessageAt: string | null;
  contact: { id: string; name: string; waId: string; label: ContactLabel };
  lastPreview: string;
  lastDirection: "in" | "out" | null;
  lastByPerson: boolean;
  needsAttention: boolean;
}
interface Msg {
  id: string;
  direction: "in" | "out";
  sender: "customer" | "assistant" | "me" | "team";
  type: string;
  body: string | null;
  sendState: string | null;
  deliveryStatus: string | null;
  at: string;
}
interface Detail {
  conversation: { id: string; status: Status; handoffReason: string | null; assignedToMe: boolean; assignedName: string | null; replyUntil: string | null; contact: { id: string; name: string; waId: string; label: ContactLabel } };
  messages: Msg[];
  notes: { id: string; author: string; body: string; at: string }[];
  work: { id: string; type: WorkType; title: string }[];
}

const FILTERS = [
  { id: "activas", label: "Activas" },
  { id: "persona", label: "Con una persona" },
  { id: "asistente", label: "Con el asistente" },
  { id: "cerradas", label: "Cerradas" },
] as const;
type FilterId = (typeof FILTERS)[number]["id"];

const DELIVERY: Record<string, string> = { sent: "Enviado", delivered: "Entregado", read: "Leído", failed: "No se entregó" };
const chip = { background: "var(--color-pure-white)", color: "var(--color-ink)", border: "1px solid var(--color-field-border)" } as const;
const urgent = { background: "var(--color-signal-yellow)", color: "var(--color-ink)" } as const;
const SENDER_LABEL = { assistant: "Asistente", me: "Tú", team: "Equipo" } as const;
const MAX_REPLY = 4000;
const LIST_MS = 10_000;
const DETAIL_MS = 5_000;

function newKey(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6]! & 0x0f) | 0x40;
  b[8] = (b[8]! & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** Un pitido corto (si el navegador no deja reproducir audio todavía, se omite en silencio). */
function beep() {
  try {
    const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctx) return;
    const ctx = new Ctx();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.frequency.value = 880;
    gain.gain.value = 0.08;
    osc.connect(gain); gain.connect(ctx.destination);
    osc.start(); osc.stop(ctx.currentTime + 0.18);
    osc.onended = () => void ctx.close();
  } catch { /* sin audio */ }
}

export function Inbox({ initialId }: { initialId: string | null }) {
  const uid = useId();
  const [filter, setFilter] = useState<FilterId>("activas");
  const [label, setLabel] = useState<ContactLabel | "">("");
  const [first, setFirst] = useState<ConvRow[] | null>(null);
  const [more, setMore] = useState<ConvRow[]>([]);
  const [next, setNext] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(initialId);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmClose, setConfirmClose] = useState(false);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [replyError, setReplyError] = useState<string | null>(null);
  const sendKey = useRef<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const bottomRef = useRef<HTMLDivElement>(null);
  const lastCount = useRef(0);
  const [noteDraft, setNoteDraft] = useState("");
  const [noteBusy, setNoteBusy] = useState(false);
  const [noteError, setNoteError] = useState<string | null>(null);
  const [sound, setSound] = useState(true);
  const seenAttention = useRef<Set<string> | null>(null);

  const qs = useCallback((before?: string) => {
    const p = new URLSearchParams({ filter });
    if (label) p.set("label", label);
    if (before) p.set("before", before);
    return p.toString();
  }, [filter, label]);

  const loadList = useCallback(async () => {
    try {
      const res = await fetch(`/api/conversations?${qs()}`, { cache: "no-store" });
      if (!res.ok) return;
      const d = (await res.json()) as { conversations: ConvRow[]; nextBefore: string | null };
      setFirst(d.conversations);
      setNext((cur) => (more.length ? cur : d.nextBefore));
      setNow(Date.now());
    } catch {
      /* se reintenta */
    }
  }, [qs, more.length]);

  useEffect(() => {
    const t0 = setTimeout(() => void loadList(), 0);
    const t = setInterval(() => void loadList(), LIST_MS);
    return () => {
      clearTimeout(t0);
      clearInterval(t);
    };
  }, [loadList]);

  // Aviso de conversaciones nuevas que esperan a una persona: sonido (si está activo) y número en la pestaña.
  useEffect(() => {
    const t = setTimeout(() => {
      try { if (window.localStorage.getItem("inbox-sound") === "off") setSound(false); } catch { /* sin almacenamiento */ }
    }, 0);
    return () => clearTimeout(t);
  }, []);
  useEffect(() => {
    if (!first) return;
    const cur = new Set(first.filter((r) => r.needsAttention).map((r) => r.id));
    const prev = seenAttention.current;
    seenAttention.current = cur;
    if (prev && sound && [...cur].some((id) => !prev.has(id))) beep();
    const base = "Conversaciones";
    document.title = cur.size > 0 ? `(${cur.size}) ${base}` : base;
  }, [first, sound]);
  useEffect(() => () => { document.title = "Conversaciones"; }, []);
  function toggleSound() {
    const on = !sound;
    setSound(on);
    try { window.localStorage.setItem("inbox-sound", on ? "on" : "off"); } catch { /* sin almacenamiento */ }
    if (on) beep();
  }
  async function addNote() {
    if (noteBusy || !selected || !noteDraft.trim()) return;
    setNoteBusy(true); setNoteError(null);
    const r = await postJson("/api/conversations/note", { id: selected, body: noteDraft });
    setNoteBusy(false);
    if (!r.ok) return setNoteError(r.data.message ?? "No se pudo guardar la nota.");
    setNoteDraft("");
    await loadDetail(selected);
  }

  async function loadMore() {
    if (!next) return;
    const res = await fetch(`/api/conversations?${qs(next)}`, { cache: "no-store" });
    if (!res.ok) return;
    const d = (await res.json()) as { conversations: ConvRow[]; nextBefore: string | null };
    setMore((m) => [...m, ...d.conversations]);
    setNext(d.nextBefore);
  }

  const loadDetail = useCallback(async (id: string) => {
    try {
      const res = await fetch(`/api/conversations/messages?id=${id}`, { cache: "no-store" });
      if (res.status === 404 || res.status === 400) {
        setNotFound(true);
        setDetail(null);
        return;
      }
      if (!res.ok) return;
      setNotFound(false);
      setDetail((await res.json()) as Detail);
    } catch {
      /* se reintenta */
    }
  }, []);

  useEffect(() => {
    if (!selected) return;
    const t0 = setTimeout(() => void loadDetail(selected), 0);
    const t = setInterval(() => void loadDetail(selected), DETAIL_MS);
    return () => {
      clearTimeout(t0);
      clearInterval(t);
    };
  }, [selected, loadDetail]);

  // Al llegar mensajes nuevos, baja al final.
  useEffect(() => {
    const n = detail?.messages.length ?? 0;
    if (n !== lastCount.current) {
      lastCount.current = n;
      bottomRef.current?.scrollIntoView({ block: "end" });
    }
  }, [detail]);

  function open(id: string) {
    setSelected(id);
    setDetail(null);
    setNotFound(false);
    setConfirmClose(false);
    setError(null);
    setDraft("");
    setReplyError(null);
    sendKey.current = null;
    lastCount.current = 0;
    window.history.replaceState(null, "", `/conversaciones?c=${id}`);
  }
  function back() {
    setSelected(null);
    setDetail(null);
    setNotFound(false);
    window.history.replaceState(null, "", "/conversaciones");
  }

  async function act(body: Record<string, unknown>) {
    if (!selected || busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/conversations/update", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: selected, ...body }) });
      if (!res.ok) {
        const d = (await res.json().catch(() => ({}))) as { message?: string };
        setError(d.message ?? "No se pudo completar la acción.");
      }
      setConfirmClose(false);
      await Promise.all([loadDetail(selected), loadList()]);
    } catch {
      setError("No hay conexión con el servidor. Revisa tu internet e intenta de nuevo.");
    } finally {
      setBusy(false);
    }
  }

  async function sendReply() {
    const text = draft.trim();
    if (!selected || sending || text.length === 0 || text.length > MAX_REPLY) return;
    setSending(true);
    setReplyError(null);
    // Una clave por intento: si la petición se repite (doble clic, reintento de red) el servidor NO envía dos veces.
    sendKey.current ??= newKey();
    let keep = false;
    try {
      const res = await fetch("/api/conversations/reply", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: selected, clientKey: sendKey.current, text }) });
      if (res.ok) {
        setDraft("");
      } else {
        const d = (await res.json().catch(() => ({}))) as { error?: string; message?: string };
        setReplyError(d.message ?? "No se pudo enviar el mensaje.");
        keep = d.error === "envio_en_curso";
      }
    } catch {
      // Sin respuesta: puede que sí haya llegado. Se conserva la misma clave para que reintentar sea seguro.
      setReplyError("No hay conexión con el servidor. Revisa tu internet y vuelve a pulsar Enviar: no se duplicará.");
      keep = true;
    } finally {
      if (!keep) sendKey.current = null;
      setSending(false);
    }
    await Promise.all([loadDetail(selected), loadList()]);
  }

  const rows = [...(first ?? []), ...more.filter((m) => !(first ?? []).some((f) => f.id === m.id))];
  const c = detail?.conversation;

  return (
    <div className="grid gap-6 lg:grid-cols-[380px_1fr]">
      {/* ------------------------------------------------------------ lista */}
      <section className={selected ? "hidden lg:block" : ""} aria-label="Lista de conversaciones">
        <div className="flex flex-wrap gap-2" role="group" aria-label="Filtrar conversaciones">
          {FILTERS.map((f) => (
            <button key={f.id} type="button" aria-pressed={filter === f.id} className={`btn btn-sm ${filter === f.id ? "btn-primary" : "btn-ghost-dark"}`} onClick={() => { setFilter(f.id); setFirst(null); setMore([]); setNext(null); }}>
              {f.label}
            </button>
          ))}
          <button type="button" className="btn btn-sm btn-ghost-dark" aria-pressed={sound} onClick={toggleSound}>{sound ? "🔔 Sonido activado" : "🔕 Sonido apagado"}</button>
        </div>
        <div className="field mt-4">
          <label htmlFor={`${uid}-lab`} className="muted-dark" style={{ color: "rgba(255,255,255,0.78)" }}>Tipo de contacto</label>
          <select id={`${uid}-lab`} className="input" value={label} onChange={(e) => { setLabel(e.target.value as ContactLabel | ""); setFirst(null); setMore([]); setNext(null); }}>
            <option value="">Todos</option>
            {CONTACT_LABELS.map((l) => (
              <option key={l} value={l}>{CONTACT_LABEL_TEXT[l].replace(" (el asistente no responde)", "")}</option>
            ))}
          </select>
        </div>

        {first === null ? (
          <p className="muted-dark mt-6" role="status">Cargando…</p>
        ) : rows.length === 0 ? (
          <div className="mt-6">
            <EmptyState
              title={filter === "activas" ? "Aún no hay conversaciones" : "No hay conversaciones con este filtro"}
              text={filter === "activas" ? "Cuando un cliente te escriba por WhatsApp, su chat aparecerá aquí. Conecta tu número y pruébalo escribiéndole desde otro teléfono." : "Cambia el filtro de arriba para ver otras conversaciones."}
              actions={filter === "activas" ? [{ href: "/whatsapp", label: "Conectar WhatsApp" }, { href: "/simulador", label: "Probar el asistente" }] : []}
              help="conversaciones"
            />
          </div>
        ) : (
          <ul className="mt-6 flex flex-col gap-3">
            {rows.map((r) => (
              <li key={r.id}>
                <button
                  type="button"
                  onClick={() => open(r.id)}
                  aria-current={selected === r.id ? "true" : undefined}
                  className="card-light w-full text-left"
                  style={{ padding: 16, borderRadius: 20, border: selected === r.id ? "2px solid var(--color-ink)" : "2px solid transparent", cursor: "pointer" }}
                >
                  <span className="flex items-baseline justify-between gap-3">
                    <strong className="truncate text-[16px]">{r.contact.name}</strong>
                    <span className="muted shrink-0 text-[13px]">{relativeTime(r.lastMessageAt, now)}</span>
                  </span>
                  <span className="muted mt-1 block truncate text-[14px]">
                    {r.lastDirection === "out" ? (r.lastByPerson ? "Equipo: " : "Asistente: ") : ""}
                    {r.lastPreview || "Sin mensajes"}
                  </span>
                  <span className="mt-2 flex flex-wrap gap-2">
                    {r.needsAttention && <span className="badge" style={urgent}>Necesita atención</span>}
                    {r.status !== "bot" && <span className="badge" style={chip}>{CONVERSATION_STATUS_LABEL[r.status]}</span>}
                    {r.contact.label !== "sin_clasificar" && <span className="badge" style={chip}>{CONTACT_LABEL_TEXT[r.contact.label].replace(" (el asistente no responde)", "")}</span>}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
        {next && (
          <button type="button" className="btn btn-sm btn-ghost-dark mt-4 w-full" onClick={() => void loadMore()}>
            Ver más antiguas
          </button>
        )}
      </section>

      {/* ---------------------------------------------------------- detalle */}
      <section className={selected ? "" : "hidden lg:block"} aria-label="Conversación">
        {!selected ? (
          <div className="card-light" style={{ padding: 32 }}>
            <p className="eyebrow">Conversaciones</p>
            <h2 className="mt-3 text-[24px]">Elige una conversación</h2>
            <p className="muted mt-3">Aquí verás todo lo que se habló, podrás tomarla para que el asistente deje de responder y clasificar a la persona.</p>
          </div>
        ) : notFound ? (
          <div className="card-light" style={{ padding: 32 }}>
            <h2 className="text-[24px]">No encontramos esa conversación</h2>
            <button type="button" className="btn btn-sm btn-ghost-light mt-4" onClick={back}>Volver a la lista</button>
          </div>
        ) : !c ? (
          <p className="muted-dark" role="status">Cargando…</p>
        ) : (
          <div className="card-light" style={{ padding: 24 }}>
            <div className="lg:hidden">
              <button type="button" className="btn btn-text btn-sm" style={{ color: "var(--color-ink)", textDecoration: "underline" }} onClick={back}>← Volver a la lista</button>
            </div>
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div>
                <h2 className="text-[24px]">{c.contact.name}</h2>
                <p className="muted mt-1 text-[14px]">+{c.contact.waId} · {CONVERSATION_STATUS_LABEL[c.status]}{c.status === "human" && c.assignedToMe ? " · la tienes tú" : c.status === "human" && c.assignedName ? ` · la atiende ${c.assignedName}` : ""} · <Link href={`/clientes/${c.contact.id}`} className="link">Ver ficha</Link></p>
              </div>
              <div className="field" style={{ minWidth: 220 }}>
                <label htmlFor={`${uid}-tipo`}>Tipo de contacto</label>
                <select id={`${uid}-tipo`} className="input" value={c.contact.label} disabled={busy} onChange={(e) => void act({ action: "label", label: e.target.value })}>
                  {CONTACT_LABELS.map((l) => (
                    <option key={l} value={l}>{CONTACT_LABEL_TEXT[l]}</option>
                  ))}
                </select>
              </div>
            </div>

            {c.contact.label === "personal" && (
              <p className="alert-warn mt-4" role="note">Este contacto está marcado como personal: el asistente no le responde.</p>
            )}
            {detail!.work.length > 0 && (
              <p className="alert-warn mt-4" role="note">
                Pendiente: <strong>{detail!.work[0]!.title}</strong> ({WORK_TYPE_LABEL[detail!.work[0]!.type]}).{" "}
                <Link href="/hoy" className="link">Ver en Hoy</Link>
              </p>
            )}

            <div className="mt-5 flex flex-wrap items-center gap-2">
              {c.status !== "closed" && !(c.status === "human" && c.assignedToMe) && (
                <button type="button" className="btn btn-sm btn-primary" disabled={busy} onClick={() => void act({ action: "take" })}>
                  Tomar la conversación
                </button>
              )}
              {c.status === "human" && (
                <button type="button" className="btn btn-sm btn-ghost-light" disabled={busy} onClick={() => void act({ action: "release" })}>
                  Devolver al asistente
                </button>
              )}
              {c.status !== "closed" &&
                (confirmClose ? (
                  <>
                    <span className="text-[14px]">¿Cerrar la conversación?</span>
                    <button type="button" className="btn btn-sm btn-ghost-light" disabled={busy} onClick={() => void act({ action: "close" })}>Sí, cerrar</button>
                    <button type="button" className="btn btn-sm btn-text" style={{ color: "var(--color-ink)", textDecoration: "underline" }} onClick={() => setConfirmClose(false)}>Cancelar</button>
                  </>
                ) : (
                  <button type="button" className="btn btn-sm btn-text" style={{ color: "var(--color-ink)", textDecoration: "underline" }} disabled={busy} onClick={() => setConfirmClose(true)}>Cerrar</button>
                ))}
            </div>
            <div role="alert" aria-live="assertive">{error && <p className="alert-error mt-4">{error}</p>}</div>

            <div className="mt-6 flex max-h-[60vh] flex-col gap-3 overflow-y-auto rounded-[20px] p-4" style={{ background: "var(--color-pure-white)", border: "1px solid var(--color-fog-border)" }} role="log" aria-label="Mensajes" tabIndex={0}>
              {detail!.messages.length === 0 && <p className="muted text-[14px]">Todavía no hay mensajes.</p>}
              {[...detail!.messages.map((m) => ({ kind: "msg" as const, at: m.at, m })), ...detail!.notes.map((n) => ({ kind: "note" as const, at: n.at, n }))]
                .sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime())
                .map((it) => {
                if (it.kind === "note") {
                  return (
                    <div key={`n-${it.n.id}`} className="flex justify-center">
                      <div className="max-w-[90%] rounded-[14px] px-4 py-3" style={{ background: "var(--color-warn-bg, #fff8e1)", color: "var(--color-ink)", border: "1px dashed var(--color-ink-muted)" }}>
                        <p className="text-[12px] font-medium" style={{ color: "var(--color-ink-muted)" }}>Nota privada de {it.n.author} · solo tu equipo la ve</p>
                        <p className="text-[15px]" style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{it.n.body}</p>
                        <p className="mt-1 text-[12px]" style={{ color: "var(--color-ink-muted)" }}>{messageTime(it.n.at, now)}</p>
                      </div>
                    </div>
                  );
                }
                const m = it.m;
                const out = m.direction === "out";
                const media = m.type !== "text" ? `[${MEDIA_LABEL[m.type] ?? m.type}]` : "";
                const status = out ? (m.sendState === "failed" ? "No se pudo enviar" : m.sendState === "unknown" ? "Envío incierto" : m.deliveryStatus ? DELIVERY[m.deliveryStatus] : "") : "";
                return (
                  <div key={m.id} className={`flex ${out ? "justify-end" : "justify-start"}`}>
                    <div
                      className="max-w-[85%] rounded-[18px] px-4 py-3"
                      style={{ background: out ? "var(--color-mint-whisper)" : "var(--color-mint-frost)", color: "var(--color-ink)", border: "1px solid var(--color-fog-border)" }}
                    >
                      {out && <p className="text-[12px] font-medium" style={{ color: "var(--color-ink-muted)" }}>{SENDER_LABEL[m.sender === "customer" ? "assistant" : m.sender]}</p>}
                      {media && <p className="text-[14px] font-medium">{media}</p>}
                      {m.body && <p className="text-[15px]" style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{m.body}</p>}
                      <p className="mt-1 text-[12px]" style={{ color: "var(--color-ink-muted)" }}>
                        {messageTime(m.at, now)}
                        {status && ` · ${status}`}
                      </p>
                    </div>
                  </div>
                );
              })}
              <div ref={bottomRef} />
            </div>
            {c.status !== "closed" &&
              (c.status === "human" && c.assignedToMe ? (
                (() => {
                  const until = c.replyUntil && new Date(c.replyUntil).getTime() > now ? c.replyUntil : null;
                  return until ? (
                    <form className="mt-4" onSubmit={(e) => { e.preventDefault(); void sendReply(); }}>
                      <div className="field">
                        <label htmlFor={`${uid}-resp`}>Tu respuesta</label>
                        <textarea
                          id={`${uid}-resp`}
                          className="input"
                          rows={3}
                          maxLength={MAX_REPLY}
                          value={draft}
                          disabled={sending}
                          onChange={(e) => setDraft(e.target.value)}
                          onKeyDown={(e) => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); void sendReply(); } }}
                        />
                      </div>
                      <div className="mt-2 flex flex-wrap items-center justify-between gap-3">
                        <p className="muted text-[14px]">Puedes responder hasta {messageTime(until, now)} (WhatsApp permite 24 horas desde el último mensaje del cliente). Ctrl + Enter envía.</p>
                        <button type="submit" className="btn btn-sm btn-primary" disabled={sending || draft.trim().length === 0}>
                          {sending ? "Enviando…" : "Enviar"}
                        </button>
                      </div>
                    </form>
                  ) : (
                    <TemplateSender conversationId={c.id} onSent={() => void Promise.all([loadDetail(selected!), loadList()])} />
                  );
                })()
              ) : (
                <p className="muted mt-4 text-[14px]">Para responder desde aquí, toma la conversación: el asistente dejará de contestar mientras la tengas.</p>
              ))}
            <div role="alert" aria-live="assertive">{replyError && <p className="alert-error mt-3">{replyError}</p>}</div>
            <form className="mt-6" onSubmit={(e) => { e.preventDefault(); void addNote(); }}>
              <div className="field">
                <label htmlFor={`${uid}-nota`}>Nota privada <span className="muted">(solo tu equipo la ve; no se envía al cliente)</span></label>
                <textarea id={`${uid}-nota`} className="input" rows={2} maxLength={2000} value={noteDraft} disabled={noteBusy} onChange={(e) => setNoteDraft(e.target.value)} placeholder="Ej. Pidió descuento por volumen; consultar con el dueño." />
              </div>
              <div className="mt-2 flex flex-wrap items-center gap-3">
                <button type="submit" className="btn btn-sm btn-ghost-light" disabled={noteBusy || noteDraft.trim().length === 0}>{noteBusy ? "Guardando…" : "Guardar nota"}</button>
              </div>
              <div role="alert" aria-live="assertive">{noteError && <p className="alert-error mt-3">{noteError}</p>}</div>
            </form>
          </div>
        )}
      </section>
    </div>
  );
}
