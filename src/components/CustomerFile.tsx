"use client";

import Link from "next/link";
import { useCallback, useEffect, useId, useState, type FormEvent } from "react";
import { formatMoney, type Currency } from "@/lib/catalog/money";
import { postJson } from "@/lib/client";
import { CONSENT_SOURCES, CONSENT_SOURCE_TEXT, MAX_TAGS, MAX_TAG_LENGTH, splitTagInput, type ConsentSource } from "@/lib/customers/tags";
import { CONTACT_LABEL_TEXT, CONTACT_LABELS, CONVERSATION_STATUS_LABEL, type ContactLabel } from "@/lib/work/labels";

interface Detail {
  customer: { id: string; name: string | null; waId: string; label: ContactLabel; tags: string[]; notes: string; optedOut: boolean; consentAt: string | null; consentSource: ConsentSource | null; createdAt: string; messagesReceived: number };
  spent: { currency: Currency; totalMinor: number; orders: number }[];
  conversations: { id: string; status: string; lastMessageAt: string | null; createdAt: string; lastBody: string | null }[];
  orders: { id: string; number: number; status: string; currency: Currency; totalMinor: number; createdAt: string; items: string | null }[];
  appointments: { id: string; startsAt: string; status: string; service: string }[];
}

const ORDER_STATUS: Record<string, string> = { pendiente: "Por confirmar", confirmado: "Confirmado", entregado: "Entregado", cancelado: "Cancelado" };
const APPT_STATUS: Record<string, string> = { pendiente: "Pendiente", confirmada: "Confirmada", cancelada: "Cancelada", completada: "Completada", no_asistio: "No asistió" };
const chip = { background: "var(--color-pure-white)", color: "var(--color-ink)", border: "1px solid var(--color-field-border)" } as const;
const day = (iso: string) => new Intl.DateTimeFormat("es-VE", { day: "numeric", month: "short", year: "numeric" }).format(new Date(iso));
const dayTime = (iso: string) => new Intl.DateTimeFormat("es-VE", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit", hour12: true }).format(new Date(iso));

export function CustomerFile({ id, canEdit }: { id: string; canEdit: boolean }) {
  const uid = useId();
  const [d, setD] = useState<Detail | null>(null);
  const [state, setState] = useState<"loading" | "ok" | "missing" | "error">("loading");
  const [tagText, setTagText] = useState("");
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: "ok" | "error"; text: string } | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/customers/detail?id=${encodeURIComponent(id)}`, { cache: "no-store" });
      if (res.status === 404 || res.status === 400) return setState("missing");
      if (!res.ok) return setState("error");
      const j = (await res.json()) as Detail;
      setD(j); setNotes(j.customer.notes); setState("ok");
    } catch { setState("error"); }
  }, [id]);

  useEffect(() => {
    const t = setTimeout(() => void load(), 0);
    return () => clearTimeout(t);
  }, [load]);

  async function save(body: Record<string, unknown>, okText: string) {
    if (busy) return false;
    setBusy(true); setMsg(null);
    const r = await postJson("/api/customers/update", { id, ...body });
    setBusy(false);
    if (!r.ok) { setMsg({ kind: "error", text: r.data.message ?? "No se pudo guardar. Intenta de nuevo." }); return false; }
    setMsg({ kind: "ok", text: okText });
    await load();
    return true;
  }

  async function addTags(e: FormEvent) {
    e.preventDefault();
    if (!d) return;
    const add = splitTagInput(tagText);
    if (add.every((t) => !t.trim())) return;
    if (await save({ action: "tags", tags: [...d.customer.tags, ...add] }, "Etiquetas guardadas.")) setTagText("");
  }

  if (state === "loading") return <p className="muted-dark" role="status">Cargando…</p>;
  if (state === "missing") return (
    <div className="card-light" style={{ padding: 24 }}>
      <h2 className="text-[22px]">No encontramos a ese cliente</h2>
      <Link href="/clientes" className="btn btn-sm btn-ghost-light mt-4">Volver a clientes</Link>
    </div>
  );
  if (state === "error" || !d) return <p className="alert-error" role="alert">No pudimos cargar la ficha. <button type="button" className="link" onClick={() => void load()}>Reintentar</button></p>;

  const c = d.customer;
  const dirty = notes.trim() !== c.notes.trim();
  return (
    <div className="grid gap-6">
      <div className="card-light" style={{ padding: 24 }}>
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h2 className="text-[26px]">{c.name ?? `+${c.waId}`}</h2>
            <p className="muted mt-1 text-[14px]">+{c.waId} · Cliente desde {day(c.createdAt)} · {c.messagesReceived} {c.messagesReceived === 1 ? "mensaje recibido" : "mensajes recibidos"}</p>
          </div>
          <div className="field" style={{ minWidth: 220 }}>
            <label htmlFor={`${uid}-tipo`}>Tipo de contacto</label>
            <select id={`${uid}-tipo`} className="input" value={c.label} disabled={busy || !canEdit} onChange={(e) => void save({ action: "label", label: e.target.value }, "Tipo actualizado.")}>
              {CONTACT_LABELS.map((l) => <option key={l} value={l}>{CONTACT_LABEL_TEXT[l]}</option>)}
            </select>
          </div>
        </div>
        {d.spent.length > 0 && (
          <p className="mt-4 text-[15px]">
            <strong>Ha comprado:</strong> {d.spent.map((s) => `${formatMoney(s.totalMinor, s.currency)} en ${s.orders} ${s.orders === 1 ? "pedido" : "pedidos"}`).join(" · ")}
          </p>
        )}
        {msg && <p className={msg.kind === "ok" ? "alert-ok mt-4" : "alert-error mt-4"} role={msg.kind === "ok" ? "status" : "alert"}>{msg.text}</p>}
      </div>

      <div className="card-light" style={{ padding: 24 }}>
        <h3 className="text-[18px]">Etiquetas</h3>
        <p className="muted mt-1 text-[14px]">Para agrupar a tus clientes: «mayorista», «VIP», «zona norte»… Hasta {MAX_TAGS}.</p>
        <p className="mt-3 flex flex-wrap gap-2">
          {c.tags.length === 0 && <span className="muted text-[14px]">Sin etiquetas todavía.</span>}
          {c.tags.map((t) => (
            <span key={t} className="badge" style={chip}>
              #{t}
              {canEdit && <button type="button" className="ml-2" aria-label={`Quitar la etiqueta ${t}`} disabled={busy} onClick={() => void save({ action: "tags", tags: c.tags.filter((x) => x !== t) }, "Etiqueta quitada.")}>×</button>}
            </span>
          ))}
        </p>
        {canEdit && c.tags.length < MAX_TAGS && (
          <form className="mt-3 flex flex-wrap items-end gap-3" onSubmit={addTags}>
            <div className="field" style={{ minWidth: 240 }}>
              <label htmlFor={`${uid}-tag`}>Agregar etiqueta</label>
              <input id={`${uid}-tag`} className="input" value={tagText} maxLength={MAX_TAG_LENGTH * 3} onChange={(e) => setTagText(e.target.value)} placeholder="vip, mayorista" />
            </div>
            <button type="submit" className="btn btn-sm btn-primary" disabled={busy || !tagText.trim()}>Agregar</button>
          </form>
        )}
      </div>

      <div className="card-light" style={{ padding: 24 }}>
        <h3 className="text-[18px]">Nota interna</h3>
        <p className="muted mt-1 text-[14px]">Solo la ve tu equipo. Ej. «prefiere que le escriban en la tarde», «alérgica al maní».</p>
        <div className="field mt-3">
          <label htmlFor={`${uid}-nota`} className="sr-only">Nota interna</label>
          <textarea id={`${uid}-nota`} className="input" rows={4} maxLength={2000} value={notes} disabled={!canEdit} onChange={(e) => setNotes(e.target.value)} />
        </div>
        {canEdit && <button type="button" className="btn btn-sm btn-primary mt-3" disabled={busy || !dirty} onClick={() => void save({ action: "notes", notes }, "Nota guardada.")}>Guardar nota</button>}
      </div>

      <div className="card-light" style={{ padding: 24 }}>
        <h3 className="text-[18px]">Permiso para promociones</h3>
        {c.consentAt && c.consentSource ? (
          <p className="mt-1 text-[14px]">Dio su permiso el {day(c.consentAt)}: {CONSENT_SOURCE_TEXT[c.consentSource].toLowerCase()}.</p>
        ) : (
          <p className="muted mt-1 text-[14px]">Sin permiso registrado. Solo escríbele promociones a quien te haya dicho que sí quiere recibirlas: WhatsApp puede bloquear tu número si te reportan.</p>
        )}
        {canEdit && !c.consentAt && (
          <div className="field mt-3" style={{ maxWidth: 360 }}>
            <label htmlFor={`${uid}-perm`}>Registrar que aceptó</label>
            <select id={`${uid}-perm`} className="input" defaultValue="" disabled={busy} onChange={(e) => { if (e.target.value) void save({ action: "consent", source: e.target.value }, "Permiso registrado."); }}>
              <option value="">Elige cómo lo aceptó…</option>
              {CONSENT_SOURCES.map((k) => <option key={k} value={k}>{CONSENT_SOURCE_TEXT[k]}</option>)}
            </select>
          </div>
        )}
        {canEdit && c.consentAt && (
          <button type="button" className="btn btn-sm btn-ghost-light mt-3" disabled={busy} onClick={() => void save({ action: "consent", source: null }, "Permiso retirado.")}>Retirar el permiso</button>
        )}
        {c.optedOut && <p className="alert-warn mt-3" role="note">Pidió no recibir avisos: aunque tenga permiso, no se le enviarán.</p>}
      </div>

      <div className="card-light" style={{ padding: 24 }}>
        <h3 className="text-[18px]">Avisos automáticos</h3>
        <p className="mt-1 text-[14px]">
          {c.optedOut ? "Esta persona pidió no recibir avisos (recordatorios y mensajes automáticos). No se le enviarán." : "Recibe los avisos y recordatorios que tengas activos."}
        </p>
        {canEdit && (
          <button type="button" className="btn btn-sm btn-ghost-light mt-3" disabled={busy} onClick={() => void save({ action: "baja", off: !c.optedOut }, c.optedOut ? "Volverá a recibir avisos." : "No recibirá más avisos.")}>
            {c.optedOut ? "Volver a enviarle avisos" : "No enviarle avisos"}
          </button>
        )}
      </div>

      <div className="card-light" style={{ padding: 24 }}>
        <h3 className="text-[18px]">Conversaciones</h3>
        {d.conversations.length === 0 ? <p className="muted mt-2 text-[14px]">Todavía no hay conversaciones.</p> : (
          <ul className="mt-3 grid gap-3">
            {d.conversations.map((v) => (
              <li key={v.id}>
                <Link href={`/conversaciones?c=${v.id}`} className="link">{v.lastMessageAt ? dayTime(v.lastMessageAt) : day(v.createdAt)} · {CONVERSATION_STATUS_LABEL[v.status] ?? v.status}</Link>
                {v.lastBody && <p className="muted mt-1 text-[14px]">{v.lastBody}</p>}
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="card-light" style={{ padding: 24 }}>
        <h3 className="text-[18px]">Pedidos</h3>
        {d.orders.length === 0 ? <p className="muted mt-2 text-[14px]">Sin pedidos.</p> : (
          <ul className="mt-3 grid gap-3">
            {d.orders.map((o) => (
              <li key={o.id} className="text-[15px]">
                <strong>#{o.number}</strong> · {day(o.createdAt)} · {ORDER_STATUS[o.status] ?? o.status} · {formatMoney(o.totalMinor, o.currency)}
                {o.items && <p className="muted text-[14px]">{o.items}</p>}
              </li>
            ))}
          </ul>
        )}
        <p className="mt-3"><Link href="/pedidos" className="link text-[14px]">Ir a Pedidos</Link></p>
      </div>

      <div className="card-light" style={{ padding: 24 }}>
        <h3 className="text-[18px]">Citas</h3>
        {d.appointments.length === 0 ? <p className="muted mt-2 text-[14px]">Sin citas.</p> : (
          <ul className="mt-3 grid gap-2">
            {d.appointments.map((a) => (
              <li key={a.id} className="text-[15px]">{dayTime(a.startsAt)} · {a.service} · {APPT_STATUS[a.status] ?? a.status}</li>
            ))}
          </ul>
        )}
        <p className="mt-3"><Link href="/agenda" className="link text-[14px]">Ir a Agenda</Link></p>
      </div>
    </div>
  );
}
