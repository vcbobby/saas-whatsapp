"use client";

import { useCallback, useEffect, useId, useState, type FormEvent } from "react";
import { COMMON_TIMEZONES, NOTICE_OPTIONS, STEP_OPTIONS, WEEKDAYS } from "@/lib/agenda/labels";
import { addDays, formatHm, localToUtc, parseHm } from "@/lib/agenda/tz";

interface Settings { timezone: string; minNoticeMinutes: number; maxDaysAhead: number; slotStepMinutes: number }
interface Service { id: string; name: string; durationMinutes: number; priceText: string | null; active: boolean }
interface Off { id: string; startsAt: string; endsAt: string; reason: string | null }
interface Config { settings: Settings; hours: { weekday: number; startMin: number; endMin: number }[]; services: Service[]; timeOff: Off[]; canManage: boolean }
type Ranges = { start: string; end: string }[];

async function call(url: string, method: string, body?: unknown): Promise<{ ok: boolean; data: Record<string, unknown> }> {
  try {
    const res = await fetch(url, { method, headers: body !== undefined ? { "content-type": "application/json" } : undefined, body: body !== undefined ? JSON.stringify(body) : undefined, cache: "no-store" });
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    return { ok: res.ok, data };
  } catch {
    return { ok: false, data: { message: "No hay conexión con el servidor. Revisa tu internet e intenta de nuevo." } };
  }
}
const msg = (d: Record<string, unknown>, fallback: string) => (typeof d.message === "string" ? d.message : fallback);

function Section({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <section className="card-light" style={{ maxWidth: 820 }}>
      <h2 className="text-[24px]">{title}</h2>
      {hint && <p className="muted mt-2 text-[14px]">{hint}</p>}
      <div className="mt-5 flex flex-col gap-5">{children}</div>
    </section>
  );
}

function Feedback({ error, saved }: { error: string | null; saved: boolean }) {
  return (
    <>
      <div role="alert" aria-live="assertive">{error && <p className="alert-error">{error}</p>}</div>
      <div role="status" aria-live="polite">{saved && <p className="muted">Guardado.</p>}</div>
    </>
  );
}

export function AgendaConfig() {
  const uid = useId();
  const [cfg, setCfg] = useState<Config | null>(null);
  const [loadError, setLoadError] = useState(false);

  const load = useCallback(async () => {
    const r = await call("/api/agenda/config", "GET");
    if (r.ok) setCfg(r.data as unknown as Config);
    else setLoadError(true);
  }, []);
  useEffect(() => {
    const t = setTimeout(() => void load(), 0);
    return () => clearTimeout(t);
  }, [load]);

  if (loadError) return <p className="alert-error" role="alert">No se pudo cargar la agenda. Recarga la página.</p>;
  if (!cfg) return <p className="muted-dark" role="status">Cargando…</p>;
  const dis = !cfg.canManage;

  return (
    <div className="flex flex-col gap-8">
      {dis && <p className="alert-warn" style={{ maxWidth: 820 }} role="note">Solo dueños y administradores pueden cambiar la agenda. Tú puedes verla y probar los horarios libres.</p>}
      <Rules uid={uid} settings={cfg.settings} disabled={dis} onSaved={load} />
      <Services uid={uid} services={cfg.services} disabled={dis} onChanged={load} />
      <Hours uid={uid} hours={cfg.hours} disabled={dis} onSaved={load} />
      <TimeOff uid={uid} off={cfg.timeOff} tz={cfg.settings.timezone} disabled={dis} onChanged={load} />
      <Tester uid={uid} services={cfg.services.filter((s) => s.active)} />
    </div>
  );
}

// ------------------------------------------------------------------ reglas
function Rules({ uid, settings, disabled, onSaved }: { uid: string; settings: Settings; disabled: boolean; onSaved: () => Promise<void> }) {
  const [s, setS] = useState(settings);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const known = COMMON_TIMEZONES.some((z) => z.id === s.timezone);
  async function save(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    setBusy(true); setError(null); setSaved(false);
    const r = await call("/api/agenda/settings", "PUT", s);
    if (r.ok) { setSaved(true); await onSaved(); } else setError(msg(r.data, "No se pudo guardar."));
    setBusy(false);
  }
  return (
    <Section title="Zona horaria y reglas" hint="Todos los horarios se entienden en la zona horaria de tu negocio.">
      <form onSubmit={save} className="flex flex-col gap-5">
        <div className="grid gap-5 sm:grid-cols-2">
          <div className="field">
            <label htmlFor={`${uid}-tz`}>Zona horaria</label>
            <select id={`${uid}-tz`} className="input" value={s.timezone} disabled={disabled} onChange={(e) => setS({ ...s, timezone: e.target.value })}>
              {!known && <option value={s.timezone}>{s.timezone}</option>}
              {COMMON_TIMEZONES.map((z) => <option key={z.id} value={z.id}>{z.label}</option>)}
            </select>
          </div>
          <div className="field">
            <label htmlFor={`${uid}-step`}>Una cita puede empezar cada</label>
            <select id={`${uid}-step`} className="input" value={s.slotStepMinutes} disabled={disabled} onChange={(e) => setS({ ...s, slotStepMinutes: Number(e.target.value) })}>
              {STEP_OPTIONS.map((m) => <option key={m} value={m}>{m} minutos</option>)}
            </select>
          </div>
          <div className="field">
            <label htmlFor={`${uid}-notice`}>Preaviso mínimo</label>
            <select id={`${uid}-notice`} className="input" value={s.minNoticeMinutes} disabled={disabled} onChange={(e) => setS({ ...s, minNoticeMinutes: Number(e.target.value) })}>
              {!NOTICE_OPTIONS.some((o) => o.minutes === s.minNoticeMinutes) && <option value={s.minNoticeMinutes}>{s.minNoticeMinutes} minutos</option>}
              {NOTICE_OPTIONS.map((o) => <option key={o.minutes} value={o.minutes}>{o.label}</option>)}
            </select>
          </div>
          <div className="field">
            <label htmlFor={`${uid}-days`}>Se puede reservar hasta (días)</label>
            <input id={`${uid}-days`} type="number" min={1} max={365} className="input" value={s.maxDaysAhead} disabled={disabled} onChange={(e) => setS({ ...s, maxDaysAhead: Number(e.target.value) })} />
          </div>
        </div>
        <Feedback error={error} saved={saved} />
        {!disabled && <button type="submit" className="btn btn-primary btn-sm" style={{ alignSelf: "flex-start" }} disabled={busy}>{busy ? "Guardando…" : "Guardar reglas"}</button>}
      </form>
    </Section>
  );
}

// ------------------------------------------------------------------ servicios
function Services({ uid, services, disabled, onChanged }: { uid: string; services: Service[]; disabled: boolean; onChanged: () => Promise<void> }) {
  const [name, setName] = useState("");
  const [minutes, setMinutes] = useState(30);
  const [price, setPrice] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function add(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    setBusy(true); setError(null);
    const r = await call("/api/agenda/services", "POST", { name, durationMinutes: minutes, ...(price.trim() ? { priceText: price } : {}) });
    if (r.ok) { setName(""); setPrice(""); await onChanged(); } else setError(msg(r.data, "No se pudo crear el servicio."));
    setBusy(false);
  }
  async function patch(id: string, body: Record<string, unknown>) {
    if (busy) return;
    setBusy(true); setError(null);
    const r = await call("/api/agenda/services/update", "POST", { id, ...body });
    if (!r.ok) setError(msg(r.data, "No se pudo cambiar el servicio."));
    await onChanged();
    setBusy(false);
  }
  return (
    <Section title="Servicios" hint="Lo que tus clientes pueden agendar. La duración decide cuánto espacio ocupa cada cita.">
      {services.length === 0 && <p className="muted">Todavía no tienes servicios. Agrega el primero abajo.</p>}
      <ul className="flex flex-col gap-3">
        {services.map((s) => (
          <li key={s.id} className="flex flex-wrap items-center justify-between gap-3 rounded-[16px] p-4" style={{ background: "var(--color-pure-white)", border: "1px solid var(--color-field-border)", opacity: s.active ? 1 : 0.7 }}>
            <div>
              <p className="font-medium">{s.name}{!s.active && " (desactivado)"}</p>
              <p className="muted text-[14px]">{s.durationMinutes} min{s.priceText ? ` · ${s.priceText}` : ""}</p>
            </div>
            {!disabled && (
              <div className="flex flex-wrap items-center gap-2">
                <label className="sr-only" htmlFor={`${uid}-d-${s.id}`}>Duración de {s.name}</label>
                <select id={`${uid}-d-${s.id}`} className="input" style={{ width: 130 }} value={s.durationMinutes} disabled={busy} onChange={(e) => void patch(s.id, { durationMinutes: Number(e.target.value) })}>
                  {[...new Set([5, 10, 15, 20, 30, 45, 60, 75, 90, 120, 150, 180, 240, 300, 360, 480, s.durationMinutes])].sort((a, b) => a - b).map((m) => <option key={m} value={m}>{m} min</option>)}
                </select>
                <button type="button" className="btn btn-sm btn-ghost-light" disabled={busy} onClick={() => void patch(s.id, { active: !s.active })}>{s.active ? "Desactivar" : "Activar"}</button>
              </div>
            )}
          </li>
        ))}
      </ul>
      <div role="alert" aria-live="assertive">{error && <p className="alert-error">{error}</p>}</div>
      {!disabled && (
        <form onSubmit={add} className="grid gap-4 sm:grid-cols-[2fr_1fr_1fr_auto] sm:items-end">
          <div className="field">
            <label htmlFor={`${uid}-sn`}>Nuevo servicio</label>
            <input id={`${uid}-sn`} className="input" value={name} maxLength={80} required onChange={(e) => setName(e.target.value)} placeholder="Corte de cabello" />
          </div>
          <div className="field">
            <label htmlFor={`${uid}-sm`}>Duración (min)</label>
            <input id={`${uid}-sm`} type="number" min={5} max={480} className="input" value={minutes} onChange={(e) => setMinutes(Number(e.target.value))} />
          </div>
          <div className="field">
            <label htmlFor={`${uid}-sp`}>Precio (opcional)</label>
            <input id={`${uid}-sp`} className="input" value={price} maxLength={40} onChange={(e) => setPrice(e.target.value)} placeholder="$8" />
          </div>
          <button type="submit" className="btn btn-primary btn-sm" disabled={busy}>Agregar</button>
        </form>
      )}
    </Section>
  );
}

// ------------------------------------------------------------------ horario
function toRanges(hours: Config["hours"]): Record<number, Ranges> {
  const out: Record<number, Ranges> = {};
  for (const h of hours) (out[h.weekday] ??= []).push({ start: formatHm(h.startMin), end: h.endMin === 1440 ? "24:00" : formatHm(h.endMin) });
  return out;
}

function Hours({ uid, hours, disabled, onSaved }: { uid: string; hours: Config["hours"]; disabled: boolean; onSaved: () => Promise<void> }) {
  const [days, setDays] = useState<Record<number, Ranges>>(() => toRanges(hours));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const set = (n: number, r: Ranges) => { setDays((d) => ({ ...d, [n]: r })); setSaved(false); };

  async function save(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    for (const w of WEEKDAYS) for (const r of days[w.n] ?? []) {
      const a = parseHm(r.start), b = parseHm(r.end, true);
      if (a === null || b === null) return setError(`${w.label}: completa las horas.`);
      if (a >= b) return setError(`${w.label}: la hora de cierre debe ser después de la de apertura.`);
    }
    setBusy(true); setError(null); setSaved(false);
    const r = await call("/api/agenda/hours", "PUT", { days: WEEKDAYS.map((w) => ({ weekday: w.n, ranges: days[w.n] ?? [] })).filter((d) => d.ranges.length > 0) });
    if (r.ok) { setSaved(true); await onSaved(); } else setError(msg(r.data, "No se pudo guardar el horario."));
    setBusy(false);
  }
  return (
    <Section title="Horario semanal" hint="Los días sin horario quedan cerrados. Puedes poner hasta 3 tramos por día (por ejemplo, mañana y tarde).">
      <form onSubmit={save} className="flex flex-col gap-4">
        {WEEKDAYS.map((w) => {
          const rs = days[w.n] ?? [];
          return (
            <div key={w.n} className="flex flex-wrap items-center gap-3">
              <span className="font-medium" style={{ width: 96 }}>{w.label}</span>
              {rs.length === 0 && <span className="muted">Cerrado</span>}
              {rs.map((r, i) => (
                <span key={i} className="flex flex-wrap items-center gap-2">
                  <label className="sr-only" htmlFor={`${uid}-${w.n}-${i}-a`}>{w.label}, abre</label>
                  <input id={`${uid}-${w.n}-${i}-a`} type="time" className="input" style={{ width: 160 }} value={r.start} disabled={disabled} onChange={(e) => set(w.n, rs.map((x, j) => (j === i ? { ...x, start: e.target.value } : x)))} />
                  <span aria-hidden>a</span>
                  <label className="sr-only" htmlFor={`${uid}-${w.n}-${i}-b`}>{w.label}, cierra</label>
                  <input id={`${uid}-${w.n}-${i}-b`} type="time" className="input" style={{ width: 160 }} value={r.end === "24:00" ? "23:59" : r.end} disabled={disabled} onChange={(e) => set(w.n, rs.map((x, j) => (j === i ? { ...x, end: e.target.value } : x)))} />
                  {!disabled && <button type="button" className="btn btn-sm btn-text" style={{ color: "var(--color-ink)", textDecoration: "underline" }} onClick={() => set(w.n, rs.filter((_, j) => j !== i))}>Quitar</button>}
                </span>
              ))}
              {!disabled && rs.length < 3 && (
                <button type="button" className="btn btn-sm btn-ghost-light" onClick={() => set(w.n, [...rs, rs.length === 0 ? { start: "09:00", end: "17:00" } : { start: rs[rs.length - 1]!.end, end: "18:00" }])}>
                  {rs.length === 0 ? "Abrir" : "Agregar tramo"}
                </button>
              )}
            </div>
          );
        })}
        {!disabled && (
          <div>
            <button type="button" className="btn btn-sm btn-text" style={{ color: "var(--color-ink)", textDecoration: "underline" }} onClick={() => { const mon = days[1] ?? []; setDays((d) => ({ ...d, 2: mon, 3: mon, 4: mon, 5: mon })); setSaved(false); }}>
              Copiar el horario del lunes a martes–viernes
            </button>
          </div>
        )}
        <Feedback error={error} saved={saved} />
        {!disabled && <button type="submit" className="btn btn-primary btn-sm" style={{ alignSelf: "flex-start" }} disabled={busy}>{busy ? "Guardando…" : "Guardar horario"}</button>}
      </form>
    </Section>
  );
}

// ------------------------------------------------------------------ bloqueos
function TimeOff({ uid, off, tz, disabled, onChanged }: { uid: string; off: Off[]; tz: string; disabled: boolean; onChanged: () => Promise<void> }) {
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const fmt = (iso: string) => new Intl.DateTimeFormat("es-VE", { timeZone: tz, day: "numeric", month: "short", year: "numeric", hour: "numeric", minute: "2-digit" }).format(new Date(iso));

  async function add(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    setError(null); setNotice(null);
    const start = localToUtc(from, 0, tz);
    const end = localToUtc(addDays(to || from, 1), 0, tz);
    if (start === null || end === null) return setError("Elige las fechas.");
    if (end <= start) return setError("La fecha final no puede ser antes de la inicial.");
    setBusy(true);
    const r = await call("/api/agenda/time-off", "POST", { startsAt: new Date(start).toISOString(), endsAt: new Date(end).toISOString(), ...(reason.trim() ? { reason } : {}) });
    if (r.ok) {
      setFrom(""); setTo(""); setReason("");
      const n = Number(r.data.appointmentsInside ?? 0);
      if (n > 0) setNotice(`Ojo: ya hay ${n} cita(s) dentro de ese periodo. No se cancelaron; habrá que reprogramarlas.`);
      await onChanged();
    } else setError(msg(r.data, "No se pudo crear el bloqueo."));
    setBusy(false);
  }
  async function remove(id: string) {
    if (busy) return;
    setBusy(true); setError(null);
    const r = await call("/api/agenda/time-off/delete", "POST", { id });
    if (!r.ok) setError(msg(r.data, "No se pudo quitar el bloqueo."));
    await onChanged();
    setBusy(false);
  }
  return (
    <Section title="Días bloqueados" hint="Vacaciones, feriados o descansos: en esas fechas no se ofrecen horarios. Se bloquean días completos.">
      {off.length === 0 && <p className="muted">No tienes bloqueos próximos.</p>}
      <ul className="flex flex-col gap-3">
        {off.map((o) => (
          <li key={o.id} className="flex flex-wrap items-center justify-between gap-3 rounded-[16px] p-4" style={{ background: "var(--color-pure-white)", border: "1px solid var(--color-field-border)" }}>
            <div>
              <p className="font-medium">{fmt(o.startsAt)} → {fmt(o.endsAt)}</p>
              {o.reason && <p className="muted text-[14px]">{o.reason}</p>}
            </div>
            {!disabled && <button type="button" className="btn btn-sm btn-ghost-light" disabled={busy} onClick={() => void remove(o.id)}>Quitar</button>}
          </li>
        ))}
      </ul>
      <div role="alert" aria-live="assertive">{error && <p className="alert-error">{error}</p>}</div>
      {notice && <p className="alert-warn" role="status">{notice}</p>}
      {!disabled && (
        <form onSubmit={add} className="grid gap-4 sm:grid-cols-[1fr_1fr_2fr_auto] sm:items-end">
          <div className="field">
            <label htmlFor={`${uid}-of`}>Desde</label>
            <input id={`${uid}-of`} type="date" className="input" value={from} required onChange={(e) => setFrom(e.target.value)} />
          </div>
          <div className="field">
            <label htmlFor={`${uid}-ot`}>Hasta (inclusive)</label>
            <input id={`${uid}-ot`} type="date" className="input" value={to} min={from || undefined} onChange={(e) => setTo(e.target.value)} />
          </div>
          <div className="field">
            <label htmlFor={`${uid}-or`}>Motivo (opcional)</label>
            <input id={`${uid}-or`} className="input" value={reason} maxLength={200} onChange={(e) => setReason(e.target.value)} placeholder="Vacaciones" />
          </div>
          <button type="submit" className="btn btn-primary btn-sm" disabled={busy}>Bloquear</button>
        </form>
      )}
    </Section>
  );
}

// ------------------------------------------------------------------ probar huecos
function Tester({ uid, services }: { uid: string; services: Service[] }) {
  const [serviceId, setServiceId] = useState(services[0]?.id ?? "");
  const [date, setDate] = useState("");
  const [result, setResult] = useState<{ time: string; date: string }[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const sel = services.some((s) => s.id === serviceId) ? serviceId : services[0]?.id ?? "";

  async function run(e: FormEvent) {
    e.preventDefault();
    if (busy || !sel) return;
    setBusy(true); setError(null); setResult(null);
    const r = await call(`/api/agenda/slots?serviceId=${sel}&date=${date}&days=1`, "GET");
    if (r.ok) setResult((r.data.slots as { time: string; date: string }[]) ?? []);
    else setError(msg(r.data, "No se pudo calcular."));
    setBusy(false);
  }
  return (
    <Section title="Probar horarios libres" hint="Comprueba qué horarios vería un cliente. Es el mismo cálculo que usará el asistente.">
      {services.length === 0 ? (
        <p className="muted">Crea un servicio para poder probar.</p>
      ) : (
        <form onSubmit={run} className="grid gap-4 sm:grid-cols-[2fr_1fr_auto] sm:items-end">
          <div className="field">
            <label htmlFor={`${uid}-ts`}>Servicio</label>
            <select id={`${uid}-ts`} className="input" value={sel} onChange={(e) => setServiceId(e.target.value)}>
              {services.map((s) => <option key={s.id} value={s.id}>{s.name} ({s.durationMinutes} min)</option>)}
            </select>
          </div>
          <div className="field">
            <label htmlFor={`${uid}-td`}>Fecha</label>
            <input id={`${uid}-td`} type="date" className="input" value={date} required onChange={(e) => setDate(e.target.value)} />
          </div>
          <button type="submit" className="btn btn-primary btn-sm" disabled={busy}>Ver horarios</button>
        </form>
      )}
      <div role="alert" aria-live="assertive">{error && <p className="alert-error">{error}</p>}</div>
      <div role="status" aria-live="polite">
        {result && (result.length === 0 ? <p className="muted">No hay horarios libres ese día.</p> : (
          <ul className="flex flex-wrap gap-2" aria-label="Horarios libres">
            {result.map((s) => <li key={s.time} className="rounded-full px-3 py-1 text-[14px]" style={{ background: "var(--color-pure-white)", border: "1px solid var(--color-field-border)" }}>{s.time}</li>)}
          </ul>
        ))}
      </div>
    </Section>
  );
}
