"use client";

import Link from "next/link";
import { useCallback, useEffect, useId, useState, type FormEvent } from "react";
import { dueInfo, relativeTime } from "@/lib/work/time";
import { MANUAL_WORK_TYPES, PRIORITY_LABEL, WORK_STATUS_LABEL, WORK_TYPE_LABEL, WORK_TYPES, type WorkType } from "@/lib/work/labels";

interface Item {
  id: string;
  type: WorkType;
  status: "abierto" | "en_proceso" | "resuelto" | "descartado";
  priority: 1 | 2 | 3;
  title: string;
  detail: string | null;
  dueAt: string | null;
  conversationId: string | null;
  source: "agente" | "sistema" | "manual";
  assignedToMe: boolean;
  assigned: boolean;
  contactName: string | null;
  createdAt: string;
  resolvedAt: string | null;
}

type Action = "start" | "resolve" | "dismiss" | "reopen" | "take" | "release";
const REFRESH_MS = 15_000;
const chip = { background: "var(--color-pure-white)", color: "var(--color-ink)", border: "1px solid var(--color-field-border)" } as const;
const urgent = { background: "var(--color-signal-yellow)", color: "var(--color-ink)" } as const;

export function WorkQueue() {
  const uid = useId();
  const [scope, setScope] = useState<"open" | "done">("open");
  const [items, setItems] = useState<Item[] | null>(null);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [filter, setFilter] = useState<WorkType | "todo">("todo");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [formOpen, setFormOpen] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/work?scope=${scope}`, { cache: "no-store" });
      if (!res.ok) return;
      const d = (await res.json()) as { items: Item[]; counts: Record<string, number> };
      setItems(d.items);
      setCounts(d.counts);
      setNow(Date.now());
    } catch {
      /* sin conexión: se reintenta en el siguiente ciclo */
    }
  }, [scope]);

  useEffect(() => {
    const first = setTimeout(() => void load(), 0);
    const t = setInterval(() => void load(), REFRESH_MS);
    return () => {
      clearTimeout(first);
      clearInterval(t);
    };
  }, [load]);

  async function act(id: string, action: Action) {
    if (busy) return;
    setBusy(id);
    setError(null);
    try {
      const res = await fetch("/api/work/update", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id, action }) });
      if (!res.ok) {
        const d = (await res.json().catch(() => ({}))) as { message?: string };
        setError(d.message ?? "No se pudo completar la acción.");
      }
      await load();
    } catch {
      setError("No hay conexión con el servidor. Revisa tu internet e intenta de nuevo.");
    } finally {
      setBusy(null);
    }
  }

  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  const shown = (items ?? []).filter((i) => scope === "done" || filter === "todo" || i.type === filter);

  return (
    <div>
      <div className="flex flex-wrap items-center gap-3" role="tablist" aria-label="Qué mostrar">
        {(["open", "done"] as const).map((s) => (
          <button
            key={s}
            type="button"
            role="tab"
            aria-selected={scope === s}
            className={`btn btn-sm ${scope === s ? "btn-primary" : "btn-ghost-dark"}`}
            onClick={() => {
              setItems(null);
              setScope(s);
            }}
          >
            {s === "open" ? `Pendientes${scope === "open" || total ? ` (${total})` : ""}` : "Resueltas"}
          </button>
        ))}
        <button type="button" className="btn btn-sm btn-ghost-dark ml-auto" aria-expanded={formOpen} aria-controls={`${uid}-form`} onClick={() => setFormOpen((v) => !v)}>
          {formOpen ? "Cerrar formulario" : "Nueva tarea"}
        </button>
      </div>

      {formOpen && (
        <div id={`${uid}-form`} className="mt-6">
          <NewTask
            onCreated={() => {
              setFormOpen(false);
              setScope("open");
              void load();
            }}
          />
        </div>
      )}

      {scope === "open" && total > 0 && (
        <div className="mt-6 flex flex-wrap gap-2" role="group" aria-label="Filtrar por tipo">
          <button type="button" className={`btn btn-sm ${filter === "todo" ? "btn-primary" : "btn-ghost-dark"}`} aria-pressed={filter === "todo"} onClick={() => setFilter("todo")}>
            Todo ({total})
          </button>
          {WORK_TYPES.filter((t) => counts[t]).map((t) => (
            <button key={t} type="button" className={`btn btn-sm ${filter === t ? "btn-primary" : "btn-ghost-dark"}`} aria-pressed={filter === t} onClick={() => setFilter(t)}>
              {WORK_TYPE_LABEL[t]} ({counts[t]})
            </button>
          ))}
        </div>
      )}

      <div aria-live="assertive" role="alert" className="mt-4">
        {error && <p className="alert-error">{error}</p>}
      </div>

      {items === null ? (
        <p className="muted-dark mt-8" role="status">Cargando…</p>
      ) : shown.length === 0 ? (
        <section className="card-light mt-8" style={{ maxWidth: 640 }}>
          <p className="eyebrow">{scope === "open" ? "Todo al día" : "Sin historial"}</p>
          <h2 className="mt-3 text-[24px]">{scope === "open" ? "No tienes nada pendiente" : "Aún no hay tareas resueltas"}</h2>
          <p className="muted mt-3">
            {scope === "open"
              ? "Cuando el asistente pase una conversación a una persona, o crees una tarea, aparecerá aquí ordenada por urgencia."
              : "Las tareas que resuelvas o descartes se guardan aquí."}
          </p>
        </section>
      ) : (
        <ul className="mt-8 flex flex-col gap-4">
          {shown.map((i) => (
            <li key={i.id} className="card-light" style={{ padding: 24 }}>
              <div className="flex flex-wrap items-center gap-2">
                <span className="badge" style={chip}>{WORK_TYPE_LABEL[i.type]}</span>
                {i.priority === 1 && scope === "open" && <span className="badge" style={urgent}>Prioridad alta</span>}
                {i.priority === 3 && scope === "open" && <span className="badge" style={chip}>{PRIORITY_LABEL[3]}</span>}
                {i.status === "en_proceso" && <span className="badge" style={chip}>{WORK_STATUS_LABEL.en_proceso}{i.assignedToMe ? " · tú" : i.assigned ? " · otra persona" : ""}</span>}
                {scope === "done" && <span className="badge" style={chip}>{WORK_STATUS_LABEL[i.status]}</span>}
              </div>
              <h2 className="mt-3 text-[20px]">{i.title}</h2>
              {i.detail && <p className="muted mt-1 text-[15px]">{i.detail}</p>}
              <p className="muted mt-2 text-[14px]">
                {[i.contactName, scope === "done" ? `Resuelta ${relativeTime(i.resolvedAt, now)}` : relativeTime(i.createdAt, now)].filter(Boolean).join(" · ")}
                {scope === "open" && dueInfo(i.dueAt, now) && (
                  <>
                    {" · "}
                    <strong>{dueInfo(i.dueAt, now)!.text}</strong>
                  </>
                )}
              </p>
              <div className="mt-4 flex flex-wrap items-center gap-2">
                {i.conversationId && (
                  <Link href={`/conversaciones?c=${i.conversationId}`} className="btn btn-sm btn-ghost-light">
                    Abrir conversación
                  </Link>
                )}
                {scope === "open" ? (
                  <>
                    {i.status === "abierto" && <Btn disabled={busy === i.id} onClick={() => act(i.id, "start")}>Empezar</Btn>}
                    <Btn primary disabled={busy === i.id} onClick={() => act(i.id, "resolve")}>Resolver</Btn>
                    {!i.assignedToMe && <Btn disabled={busy === i.id} onClick={() => act(i.id, "take")}>Tomar</Btn>}
                    {i.assignedToMe && <Btn disabled={busy === i.id} onClick={() => act(i.id, "release")}>Soltar</Btn>}
                    <Btn disabled={busy === i.id} onClick={() => act(i.id, "dismiss")}>Descartar</Btn>
                  </>
                ) : (
                  <Btn disabled={busy === i.id} onClick={() => act(i.id, "reopen")}>Reabrir</Btn>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function Btn({ children, onClick, disabled, primary }: { children: React.ReactNode; onClick: () => void; disabled?: boolean; primary?: boolean }) {
  return (
    <button type="button" className={`btn btn-sm ${primary ? "btn-primary" : "btn-text"}`} style={primary ? undefined : { color: "var(--color-ink)", textDecoration: "underline" }} disabled={disabled} onClick={onClick}>
      {children}
    </button>
  );
}

function NewTask({ onCreated }: { onCreated: () => void }) {
  const uid = useId();
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (pending) return;
    const f = new FormData(e.currentTarget);
    const due = String(f.get("due") ?? "");
    const body: Record<string, unknown> = {
      type: String(f.get("type")),
      title: String(f.get("title") ?? ""),
      priority: Number(f.get("priority")),
    };
    const detail = String(f.get("detail") ?? "").trim();
    if (detail) body.detail = detail;
    if (due) body.dueAt = new Date(due).toISOString();
    setPending(true);
    setError(null);
    try {
      const res = await fetch("/api/work", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      if (res.ok) {
        onCreated();
        return;
      }
      const d = (await res.json().catch(() => ({}))) as { message?: string };
      setError(d.message ?? "No se pudo crear la tarea.");
    } catch {
      setError("No hay conexión con el servidor. Revisa tu internet e intenta de nuevo.");
    } finally {
      setPending(false);
    }
  }

  return (
    <form onSubmit={submit} className="card-light flex flex-col gap-5" style={{ padding: 24 }} aria-label="Nueva tarea">
      <div className="field">
        <label htmlFor={`${uid}-title`}>¿Qué hay que hacer?</label>
        <input id={`${uid}-title`} name="title" className="input" required maxLength={200} placeholder="Ej.: Confirmar el pago de María" />
      </div>
      <div className="field">
        <label htmlFor={`${uid}-detail`}>Detalles (opcional)</label>
        <textarea id={`${uid}-detail`} name="detail" className="input" rows={3} maxLength={2000} />
      </div>
      <div className="grid gap-5 sm:grid-cols-3">
        <div className="field">
          <label htmlFor={`${uid}-type`}>Tipo</label>
          <select id={`${uid}-type`} name="type" className="input" defaultValue="tarea">
            {MANUAL_WORK_TYPES.map((t) => (
              <option key={t} value={t}>{WORK_TYPE_LABEL[t]}</option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor={`${uid}-prio`}>Prioridad</label>
          <select id={`${uid}-prio`} name="priority" className="input" defaultValue="2">
            <option value="1">{PRIORITY_LABEL[1]}</option>
            <option value="2">{PRIORITY_LABEL[2]}</option>
            <option value="3">{PRIORITY_LABEL[3]}</option>
          </select>
        </div>
        <div className="field">
          <label htmlFor={`${uid}-due`}>Para cuándo (opcional)</label>
          <input id={`${uid}-due`} name="due" type="datetime-local" className="input" />
        </div>
      </div>
      <div role="alert" aria-live="assertive">{error && <p className="alert-error">{error}</p>}</div>
      <div>
        <button type="submit" className="btn btn-primary" disabled={pending}>{pending ? "Guardando…" : "Crear tarea"}</button>
      </div>
    </form>
  );
}
