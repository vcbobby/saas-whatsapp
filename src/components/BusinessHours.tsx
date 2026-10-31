"use client";

import { useEffect, useId, useState, type FormEvent } from "react";
import { COMMON_TIMEZONES, WEEKDAYS } from "@/lib/agenda/labels";
import { formatHm, parseHm } from "@/lib/agenda/tz";

interface Data { enabled: boolean; timezone: string; closedNote: string | null; ranges: { weekday: number; startMin: number; endMin: number }[]; openNow: boolean; sample: string }
type Ranges = { start: string; end: string }[];

const toDays = (r: Data["ranges"]) => {
  const out: Record<number, Ranges> = {};
  for (const h of r) (out[h.weekday] ??= []).push({ start: formatHm(h.startMin), end: h.endMin === 1440 ? "24:00" : formatHm(h.endMin) });
  return out;
};

export function BusinessHours() {
  const [data, setData] = useState<Data | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    const t = setTimeout(async () => {
      try {
        const res = await fetch("/api/hours", { cache: "no-store" });
        if (!res.ok) return setFailed(true);
        setData((await res.json()) as Data);
      } catch { setFailed(true); }
    }, 0);
    return () => clearTimeout(t);
  }, []);
  if (failed) return <p role="alert">No se pudo cargar el horario. Recarga la página.</p>;
  if (!data) return <p className="muted-dark" role="status">Cargando…</p>;
  return <Form data={data} />;
}

function Form({ data }: { data: Data }) {
  const uid = useId();
  const [enabled, setEnabled] = useState(data.enabled);
  const [tz, setTz] = useState(data.timezone);
  const [note, setNote] = useState(data.closedNote ?? "");
  const [days, setDays] = useState<Record<number, Ranges>>(() => toDays(data.ranges));
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const set = (n: number, r: Ranges) => { setDays((d) => ({ ...d, [n]: r })); setMsg(null); };
  const known = COMMON_TIMEZONES.some((z) => z.id === tz);

  async function save(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    for (const w of WEEKDAYS) for (const r of days[w.n] ?? []) {
      const a = parseHm(r.start), b = parseHm(r.end, true);
      if (a === null || b === null) return setMsg({ ok: false, text: `${w.label}: completa las horas.` });
      if (a >= b) return setMsg({ ok: false, text: `${w.label}: la hora de cierre debe ser después de la de apertura.` });
    }
    setBusy(true); setMsg(null);
    try {
      const res = await fetch("/api/hours", {
        method: "PUT", headers: { "content-type": "application/json" }, cache: "no-store",
        body: JSON.stringify({ enabled, timezone: tz, closedNote: note.trim() || null, days: WEEKDAYS.map((w) => ({ weekday: w.n, ranges: days[w.n] ?? [] })).filter((d) => d.ranges.length > 0) }),
      });
      const j = (await res.json().catch(() => ({}))) as { message?: string };
      setMsg(res.ok ? { ok: true, text: "Guardado." } : { ok: false, text: j.message ?? "No se pudo guardar." });
    } catch { setMsg({ ok: false, text: "No hay conexión con el servidor." }); }
    setBusy(false);
  }

  return (
    <form onSubmit={save} className="flex max-w-[760px] flex-col gap-6">
      <label className="flex items-center gap-2 text-[16px]">
        <input type="checkbox" checked={enabled} onChange={(e) => { setEnabled(e.target.checked); setMsg(null); }} />
        Avisar a mis clientes cuando pidan una persona fuera de horario
      </label>
      <div>
        <label htmlFor={`${uid}-tz`} className="block font-medium">Zona horaria</label>
        <select id={`${uid}-tz`} className="input mt-1" value={tz} onChange={(e) => { setTz(e.target.value); setMsg(null); }}>
          {!known && <option value={tz}>{tz}</option>}
          {COMMON_TIMEZONES.map((z) => <option key={z.id} value={z.id}>{z.label}</option>)}
        </select>
        <p className="muted-dark mt-1 text-[13px]">Es la misma que usa tu agenda.</p>
      </div>
      <fieldset className="flex flex-col gap-3">
        <legend className="font-medium">¿Cuándo hay personas atendiendo?</legend>
        {WEEKDAYS.map((w) => {
          const rs = days[w.n] ?? [];
          return (
            <div key={w.n} className="flex flex-wrap items-center gap-3">
              <span className="font-medium" style={{ width: 96 }}>{w.label}</span>
              {rs.length === 0 && <span className="muted-dark">Cerrado</span>}
              {rs.map((r, i) => (
                <span key={i} className="flex flex-wrap items-center gap-2">
                  <label className="sr-only" htmlFor={`${uid}-${w.n}-${i}-a`}>{w.label}, abre</label>
                  <input id={`${uid}-${w.n}-${i}-a`} type="time" className="input" style={{ width: 150 }} value={r.start} onChange={(e) => set(w.n, rs.map((x, j) => (j === i ? { ...x, start: e.target.value } : x)))} />
                  <span aria-hidden>a</span>
                  <label className="sr-only" htmlFor={`${uid}-${w.n}-${i}-b`}>{w.label}, cierra</label>
                  <input id={`${uid}-${w.n}-${i}-b`} type="time" className="input" style={{ width: 150 }} value={r.end === "24:00" ? "23:59" : r.end} onChange={(e) => set(w.n, rs.map((x, j) => (j === i ? { ...x, end: e.target.value } : x)))} />
                  <button type="button" className="btn btn-sm btn-text" style={{ textDecoration: "underline" }} onClick={() => set(w.n, rs.filter((_, j) => j !== i))}>Quitar</button>
                </span>
              ))}
              {rs.length < 3 && (
                <button type="button" className="btn btn-sm btn-ghost-light" onClick={() => set(w.n, [...rs, rs.length === 0 ? { start: "09:00", end: "17:00" } : { start: rs[rs.length - 1]!.end, end: "18:00" }])}>
                  {rs.length === 0 ? "Abrir" : "Agregar tramo"}
                </button>
              )}
            </div>
          );
        })}
        <div>
          <button type="button" className="btn btn-sm btn-text" style={{ textDecoration: "underline" }} onClick={() => { const mon = days[1] ?? []; setDays((d) => ({ ...d, 2: mon, 3: mon, 4: mon, 5: mon })); setMsg(null); }}>
            Copiar el horario del lunes a martes–viernes
          </button>
        </div>
      </fieldset>
      <div>
        <label htmlFor={`${uid}-note`} className="block font-medium">Texto extra (opcional)</label>
        <textarea id={`${uid}-note`} className="input mt-1" rows={2} maxLength={300} value={note} onChange={(e) => { setNote(e.target.value); setMsg(null); }} placeholder="Para urgencias escríbenos a …" />
        <p className="muted-dark mt-1 text-[13px]">Se añade al final del aviso. Máximo 300 letras.</p>
      </div>
      {data.sample && (
        <p className="muted-dark text-[14px]">Ahora mismo {data.openNow ? "estás en horario de atención" : "estás fuera de horario"}. Así sonaría el aviso: <em>«{data.sample}»</em></p>
      )}
      {msg && <p role={msg.ok ? "status" : "alert"} className="text-[14px]">{msg.text}</p>}
      <button type="submit" className="btn btn-primary" style={{ alignSelf: "flex-start" }} disabled={busy}>{busy ? "Guardando…" : "Guardar horario"}</button>
    </form>
  );
}
