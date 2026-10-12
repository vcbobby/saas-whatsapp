"use client";

import Link from "next/link";
import { useCallback, useEffect, useId, useRef, useState, type FormEvent } from "react";
import { addDays, localDate, localToUtc } from "@/lib/agenda/tz";

type Status = "pendiente" | "confirmada" | "cancelada" | "completada" | "no_asistio";
interface Appt { id: string; serviceId: string; serviceName: string; customerName: string; customerPhone: string | null; notes: string | null; startsAt: string; endsAt: string; status: Status; source: "manual" | "agente" }
interface Service { id: string; name: string; durationMinutes: number; active: boolean }
interface Slot { startsAt: string; time: string; date: string }

const STATUS_LABEL: Record<Status, string> = { pendiente: "Por confirmar", confirmada: "Confirmada", cancelada: "Cancelada", completada: "Completada", no_asistio: "No asistió" };
const POLL_MS = 15_000;

async function call(url: string, method = "GET", body?: unknown): Promise<{ ok: boolean; data: Record<string, unknown> }> {
  try {
    const res = await fetch(url, { method, headers: body !== undefined ? { "content-type": "application/json" } : undefined, body: body !== undefined ? JSON.stringify(body) : undefined, cache: "no-store" });
    return { ok: res.ok, data: (await res.json().catch(() => ({}))) as Record<string, unknown> };
  } catch {
    return { ok: false, data: { message: "No hay conexión con el servidor. Revisa tu internet e intenta de nuevo." } };
  }
}
const msg = (d: Record<string, unknown>, f: string) => (typeof d.message === "string" ? d.message : f);

function Slots({ serviceId, date, tz, value, onPick, label }: { serviceId: string; date: string; tz: string; value: string | null; onPick: (s: Slot) => void; label: string }) {
  const [slots, setSlots] = useState<Slot[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    const t = setTimeout(async () => {
      if (!serviceId || !date) return;
      setSlots(null); setErr(null);
      const r = await call(`/api/agenda/slots?serviceId=${serviceId}&date=${date}&days=1`);
      if (!alive) return;
      if (r.ok) setSlots(r.data.slots as Slot[]);
      else setErr(msg(r.data, "No se pudieron calcular los horarios."));
    }, 0);
    return () => { alive = false; clearTimeout(t); };
  }, [serviceId, date, tz]);
  if (!serviceId || !date) return <p className="muted text-[14px]">Elige servicio y fecha para ver los horarios.</p>;
  if (err) return <p className="alert-error" role="alert">{err}</p>;
  if (slots === null) return <p className="muted text-[14px]" role="status">Buscando horarios…</p>;
  if (slots.length === 0) return <p className="muted text-[14px]" role="status">No hay horarios libres ese día.</p>;
  return (
    <ul className="flex flex-wrap gap-2" aria-label={label}>
      {slots.map((s) => (
        <li key={s.startsAt}>
          <button type="button" aria-pressed={value === s.startsAt} className={`btn btn-sm ${value === s.startsAt ? "btn-primary" : "btn-ghost-light"}`} onClick={() => onPick(s)}>{s.time}</button>
        </li>
      ))}
    </ul>
  );
}

export function AgendaDay() {
  const uid = useId();
  const [tz, setTz] = useState<string | null>(null);
  const [services, setServices] = useState<Service[]>([]);
  const [canManage, setCanManage] = useState(false);
  const [date, setDate] = useState<string | null>(null);
  const [appts, setAppts] = useState<Appt[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const [cancelId, setCancelId] = useState<string | null>(null);
  const [moveId, setMoveId] = useState<string | null>(null);
  const [moveDate, setMoveDate] = useState("");
  const [moveSlot, setMoveSlot] = useState<string | null>(null);
  const [showNew, setShowNew] = useState(false);
  const [nSvc, setNSvc] = useState("");
  const [nDate, setNDate] = useState("");
  const [nSlot, setNSlot] = useState<string | null>(null);
  const [nName, setNName] = useState("");
  const [nPhone, setNPhone] = useState("");
  const [nNotes, setNNotes] = useState("");
  const [nErr, setNErr] = useState<string | null>(null);
  const dateRef = useRef<string | null>(null);

  useEffect(() => {
    let alive = true;
    const t = setTimeout(async () => {
      const r = await call("/api/agenda/config");
      if (!alive) return;
      if (!r.ok) return setError("No se pudo cargar la agenda. Recarga la página.");
      const zone = (r.data.settings as { timezone: string }).timezone;
      setTz(zone);
      setServices((r.data.services as Service[]).filter((s) => s.active));
      setCanManage(r.data.canManage === true);
      setDate(localDate(Date.now(), zone));
    }, 0);
    return () => { alive = false; clearTimeout(t); };
  }, []);

  const load = useCallback(async () => {
    const d = dateRef.current;
    if (!d) return;
    const r = await call(`/api/agenda/appointments?date=${d}&days=7`);
    if (r.ok && dateRef.current === d) { setAppts(r.data.appointments as Appt[]); setNow(Date.now()); }
  }, []);

  useEffect(() => {
    dateRef.current = date;
    if (!date) return;
    const t0 = setTimeout(() => void load(), 0);
    const t = setInterval(() => void load(), POLL_MS);
    return () => { clearTimeout(t0); clearInterval(t); };
  }, [date, load]);

  if (error) return <p className="alert-error" role="alert">{error}</p>;
  if (!tz || !date) return <p className="muted-dark" role="status">Cargando…</p>;

  const today = localDate(now, tz);
  const dayLabel = (ymd: string, opts: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat("es-VE", { timeZone: tz, ...opts }).format(localToUtc(ymd, 12 * 60, tz)!);
  const hm = (iso: string) => new Intl.DateTimeFormat("es-VE", { timeZone: tz, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(iso));
  const active = (a: Appt) => a.status === "pendiente" || a.status === "confirmada";
  const rawTitle = dayLabel(date, { weekday: "long", day: "numeric", month: "long" });
  const title = rawTitle.charAt(0).toUpperCase() + rawTitle.slice(1);
  const week = Array.from({ length: 7 }, (_, i) => addDays(date, i));
  const countOf = (ymd: string) => (appts ?? []).filter((a) => active(a) && localDate(Date.parse(a.startsAt), tz) === ymd).length;
  const dayList = (appts ?? []).filter((a) => localDate(Date.parse(a.startsAt), tz) === date);
  const pendingN = (appts ?? []).filter((a) => a.status === "pendiente").length;

  async function doAction(id: string, body: Record<string, unknown>) {
    if (busy) return;
    setBusy(true); setError(null);
    const r = await call("/api/agenda/appointments/update", "POST", { id, ...body });
    if (!r.ok) setError(msg(r.data, "No se pudo completar la acción."));
    else { setCancelId(null); setMoveId(null); setMoveSlot(null); }
    await load();
    setBusy(false);
  }

  async function create(e: FormEvent) {
    e.preventDefault();
    if (busy || !nSlot) return;
    setBusy(true); setNErr(null);
    const r = await call("/api/agenda/appointments", "POST", { serviceId: nSvc, startsAt: nSlot, customerName: nName, ...(nPhone.trim() ? { customerPhone: nPhone } : {}), ...(nNotes.trim() ? { notes: nNotes } : {}) });
    if (r.ok) {
      setShowNew(false); setNSlot(null); setNName(""); setNPhone(""); setNNotes("");
      setDate(nDate);
      dateRef.current = nDate;
      await load();
    } else { setNErr(msg(r.data, "No se pudo crear la cita.")); if (r.data.error === "horario_no_disponible") setNSlot(null); }
    setBusy(false);
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center gap-3">
        <button type="button" className="btn btn-sm btn-ghost-dark" aria-label="Día anterior" onClick={() => setDate(addDays(date, -1))}>←</button>
        <button type="button" className="btn btn-sm btn-ghost-dark" onClick={() => setDate(today)}>Hoy</button>
        <button type="button" className="btn btn-sm btn-ghost-dark" aria-label="Día siguiente" onClick={() => setDate(addDays(date, 1))}>→</button>
        <label className="sr-only" htmlFor={`${uid}-fecha`}>Ir a la fecha</label>
        <input id={`${uid}-fecha`} type="date" className="input" style={{ width: 180 }} value={date} onChange={(e) => e.target.value && setDate(e.target.value)} />
        <button type="button" className="btn btn-sm btn-primary" onClick={() => { setShowNew((v) => !v); setNDate(date); setNSlot(null); setNErr(null); setNSvc((s) => s || services[0]?.id || ""); }}>
          {showNew ? "Cerrar" : "Nueva cita"}
        </button>
        {canManage && <Link href="/agenda/configuracion" className="btn btn-sm btn-text">Configurar agenda</Link>}
      </div>

      {pendingN > 0 && <p className="alert-warn" role="status">Tienes {pendingN} cita(s) por confirmar en los próximos 7 días.</p>}

      {showNew && (
        <section className="card-light" style={{ maxWidth: 820 }} aria-label="Nueva cita">
          <h2 className="text-[22px]">Nueva cita</h2>
          {services.length === 0 ? (
            <p className="muted mt-3">Primero crea un servicio en <Link href="/agenda/configuracion" className="link">Configurar agenda</Link>.</p>
          ) : (
            <form onSubmit={create} className="mt-4 flex flex-col gap-4">
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="field">
                  <label htmlFor={`${uid}-ns`}>Servicio</label>
                  <select id={`${uid}-ns`} className="input" value={nSvc} onChange={(e) => { setNSvc(e.target.value); setNSlot(null); }}>
                    {services.map((s) => <option key={s.id} value={s.id}>{s.name} ({s.durationMinutes} min)</option>)}
                  </select>
                </div>
                <div className="field">
                  <label htmlFor={`${uid}-nd`}>Fecha</label>
                  <input id={`${uid}-nd`} type="date" className="input" value={nDate} required onChange={(e) => { setNDate(e.target.value); setNSlot(null); }} />
                </div>
              </div>
              <div>
                <p className="mb-2 text-[14px] font-medium">Horario</p>
                <Slots serviceId={nSvc} date={nDate} tz={tz} value={nSlot} onPick={(s) => setNSlot(s.startsAt)} label="Horarios libres para la nueva cita" />
              </div>
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="field">
                  <label htmlFor={`${uid}-nn`}>Nombre del cliente</label>
                  <input id={`${uid}-nn`} className="input" value={nName} maxLength={120} required onChange={(e) => setNName(e.target.value)} />
                </div>
                <div className="field">
                  <label htmlFor={`${uid}-np`}>Teléfono (opcional)</label>
                  <input id={`${uid}-np`} className="input" value={nPhone} maxLength={32} inputMode="tel" onChange={(e) => setNPhone(e.target.value)} />
                </div>
              </div>
              <div className="field">
                <label htmlFor={`${uid}-no`}>Notas (opcional)</label>
                <input id={`${uid}-no`} className="input" value={nNotes} maxLength={1000} onChange={(e) => setNNotes(e.target.value)} />
              </div>
              <div role="alert" aria-live="assertive">{nErr && <p className="alert-error">{nErr}</p>}</div>
              <button type="submit" className="btn btn-primary btn-sm" style={{ alignSelf: "flex-start" }} disabled={busy || !nSlot || !nName.trim()}>{busy ? "Guardando…" : "Agendar"}</button>
            </form>
          )}
        </section>
      )}

      <div role="group" aria-label="Próximos 7 días" className="flex flex-wrap gap-2">
        {week.map((d) => (
          <button key={d} type="button" aria-pressed={d === date} className={`btn btn-sm ${d === date ? "btn-primary" : "btn-ghost-dark"}`} onClick={() => setDate(d)}>
            {dayLabel(d, { weekday: "short", day: "numeric" })} · {countOf(d)}
          </button>
        ))}
      </div>

      <h2 className="text-[24px]">{title}{date === today ? " (hoy)" : ""}</h2>
      <div role="alert" aria-live="assertive">{error && <p className="alert-error">{error}</p>}</div>

      {appts === null ? (
        <p className="muted-dark" role="status">Cargando citas…</p>
      ) : dayList.length === 0 ? (
        <div className="card-light" style={{ maxWidth: 820 }}><p className="muted">No hay citas este día.</p></div>
      ) : (
        <ul className="flex flex-col gap-4" style={{ maxWidth: 820 }} aria-label="Citas del día">
          {dayList.map((a) => {
            const started = Date.parse(a.startsAt) <= now;
            const svc = services.find((s) => s.id === a.serviceId);
            return (
              <li key={a.id} className="card-light" style={{ padding: 20, opacity: active(a) || a.status === "completada" ? 1 : 0.75 }}>
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <p className="text-[20px] font-medium">{hm(a.startsAt)} – {hm(a.endsAt)} · {a.serviceName}</p>
                    <p className="mt-1">{a.customerName}{a.customerPhone ? ` · ${a.customerPhone}` : ""}</p>
                    {a.notes && <p className="muted mt-1 text-[14px]">{a.notes}</p>}
                  </div>
                  <div className="flex flex-col items-end gap-1">
                    <span className="rounded-full px-3 py-1 text-[12px] font-medium" style={a.status === "pendiente" ? { background: "var(--color-signal-yellow)", color: "var(--color-ink)" } : { background: "var(--color-pure-white)", color: "var(--color-ink)", border: "1px solid var(--color-field-border)" }}>{STATUS_LABEL[a.status]}</span>
                    {a.source === "agente" && <span className="muted text-[12px]">Pedida por el asistente</span>}
                  </div>
                </div>

                {active(a) && (
                  <div className="mt-4 flex flex-wrap items-center gap-2">
                    {a.status === "pendiente" && <button type="button" className="btn btn-sm btn-primary" disabled={busy} onClick={() => void doAction(a.id, { action: "confirm" })}>Confirmar</button>}
                    {a.status === "confirmada" && started && (
                      <>
                        <button type="button" className="btn btn-sm btn-primary" disabled={busy} onClick={() => void doAction(a.id, { action: "complete" })}>Marcar completada</button>
                        <button type="button" className="btn btn-sm btn-ghost-light" disabled={busy} onClick={() => void doAction(a.id, { action: "no_show" })}>No asistió</button>
                      </>
                    )}
                    <button type="button" className="btn btn-sm btn-ghost-light" disabled={busy} onClick={() => { setMoveId(moveId === a.id ? null : a.id); setMoveDate(date); setMoveSlot(null); setCancelId(null); }}>Reprogramar</button>
                    {cancelId === a.id ? (
                      <>
                        <span className="text-[14px]">¿Cancelar esta cita?</span>
                        <button type="button" className="btn btn-sm btn-ghost-light" disabled={busy} onClick={() => void doAction(a.id, { action: "cancel" })}>Sí, cancelar</button>
                        <button type="button" className="btn btn-sm btn-text" style={{ color: "var(--color-ink)", textDecoration: "underline" }} onClick={() => setCancelId(null)}>No</button>
                      </>
                    ) : (
                      <button type="button" className="btn btn-sm btn-text" style={{ color: "var(--color-ink)", textDecoration: "underline" }} disabled={busy} onClick={() => { setCancelId(a.id); setMoveId(null); }}>Cancelar cita</button>
                    )}
                  </div>
                )}

                {moveId === a.id && (
                  <div className="mt-4 flex flex-col gap-3 rounded-[16px] p-4" style={{ background: "var(--color-pure-white)", border: "1px solid var(--color-field-border)" }}>
                    {!svc ? (
                      <p className="muted text-[14px]">El servicio «{a.serviceName}» está desactivado. Actívalo en Configurar agenda para reprogramar.</p>
                    ) : (
                      <>
                        <div className="field" style={{ maxWidth: 220 }}>
                          <label htmlFor={`${uid}-md-${a.id}`}>Nueva fecha</label>
                          <input id={`${uid}-md-${a.id}`} type="date" className="input" value={moveDate} onChange={(e) => { setMoveDate(e.target.value); setMoveSlot(null); }} />
                        </div>
                        <Slots serviceId={a.serviceId} date={moveDate} tz={tz} value={moveSlot} onPick={(s) => setMoveSlot(s.startsAt)} label="Horarios libres para reprogramar" />
                        <button type="button" className="btn btn-sm btn-primary" style={{ alignSelf: "flex-start" }} disabled={busy || !moveSlot} onClick={() => void doAction(a.id, { action: "reschedule", startsAt: moveSlot })}>Mover aquí</button>
                      </>
                    )}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
