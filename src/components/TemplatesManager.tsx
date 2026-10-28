"use client";

import { useCallback, useEffect, useId, useState, type FormEvent } from "react";
import { postJson } from "@/lib/client";
import { LANGUAGES, PRESETS, bodyError, suggestName, variablesOf } from "@/lib/whatsapp/templates";

interface Tpl { id: string; name: string; language: string; category: string; body: string; sendable: boolean; status: string; reason: string | null; variables: number }
interface Data { connected: boolean; wabaSet: boolean; templates: Tpl[] }

const STATUS: Record<string, { label: string; cls: string; help: string }> = {
  APPROVED: { label: "Aprobada", cls: "badge", help: "Lista para usar en la bandeja." },
  PENDING: { label: "En revisión", cls: "badge", help: "Meta la está revisando (de minutos a unas horas). Pulsa «Actualizar desde Meta»." },
  REJECTED: { label: "Rechazada", cls: "alert-error", help: "Meta no la aprobó. Borra esta y crea otra con el texto corregido." },
  PAUSED: { label: "Pausada", cls: "alert-warn", help: "Meta la pausó por quejas o baja calidad." },
  DISABLED: { label: "Deshabilitada", cls: "alert-error", help: "Meta la deshabilitó." },
  IN_APPEAL: { label: "En apelación", cls: "badge", help: "Meta está revisando una apelación." },
  OTHER: { label: "Otro estado", cls: "badge", help: "" },
};
const CATEGORY: Record<string, string> = { UTILITY: "Utilidad", MARKETING: "Marketing", AUTHENTICATION: "Autenticación" };

export function TemplatesManager({ canManage }: { canManage: boolean }) {
  const uid = useId();
  const [data, setData] = useState<Data | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const reload = useCallback(() => setTick((n) => n + 1), []);

  // formulario
  const [title, setTitle] = useState("");
  const [language, setLanguage] = useState("es");
  const [category, setCategory] = useState<"UTILITY" | "MARKETING">("UTILITY");
  const [body, setBody] = useState("");
  const [examples, setExamples] = useState<string[]>([]);
  const [waba, setWaba] = useState("");

  useEffect(() => {
    let alive = true;
    void fetch("/api/whatsapp/templates")
      .then(async (r) => {
        if (!alive) return;
        if (!r.ok) return setLoadError("No se pudieron cargar las plantillas.");
        setLoadError(null);
        setData((await r.json()) as Data);
      })
      .catch(() => alive && setLoadError("No hay conexión con el servidor."));
    return () => { alive = false; };
  }, [tick]);

  const vars = variablesOf(body).length;
  const name = suggestName(title);
  const formError = body.trim() ? bodyError(body, examples.slice(0, vars).concat(Array(Math.max(0, vars - examples.length)).fill(""))) : null;

  function setBodyText(v: string) {
    setBody(v);
    setExamples((e) => Array.from({ length: variablesOf(v).length }, (_, i) => e[i] ?? ""));
  }
  function applyPreset(i: number) {
    const p = PRESETS[i]!;
    setTitle(p.title); setCategory(p.category); setBody(p.body); setExamples([...p.examples]);
  }
  async function act(key: string, fn: () => Promise<{ ok: boolean; data: { message?: string } }>, okText: string) {
    setBusy(key); setMsg(null);
    const r = await fn();
    setBusy(null);
    setMsg({ ok: r.ok, text: r.ok ? okText : r.data.message ?? "No se pudo completar." });
    if (r.ok) reload();
    return r.ok;
  }
  async function create(e: FormEvent) {
    e.preventDefault();
    if (formError || !name) return;
    const ok = await act("create", () => postJson("/api/whatsapp/templates", { name, language, category, body, examples }), "Enviada a Meta para revisión. Pulsa «Actualizar desde Meta» en unos minutos para ver si la aprobó.");
    if (ok) { setTitle(""); setBody(""); setExamples([]); }
  }

  if (loadError) return <p className="alert-error" role="alert">{loadError}</p>;
  if (!data) return <p className="muted-dark" role="status">Cargando…</p>;
  if (!data.connected) return <p className="alert-warn">Primero conecta tu número en la pantalla de WhatsApp.</p>;

  return (
    <div className="grid gap-10" style={{ maxWidth: 860 }}>
      <div role="status" aria-live="polite">{msg && <p className={msg.ok ? "alert-ok" : "alert-error"}>{msg.text}</p>}</div>

      {!data.wabaSet && (
        <section className="card-light" aria-labelledby={`${uid}-w`}>
          <h2 id={`${uid}-w`} className="text-[24px]">Paso 1: ID de tu cuenta de WhatsApp Business</h2>
          <p className="muted mt-2">Meta guarda las plantillas en tu cuenta de WhatsApp Business (WABA). Cópiala en <strong>Meta → WhatsApp → Configuración de la API</strong>: aparece junto a «WhatsApp Business Account ID» (solo dígitos).</p>
          {canManage ? (
            <form className="mt-4 flex flex-wrap items-end gap-3" onSubmit={(e) => { e.preventDefault(); void act("waba", () => postJson("/api/whatsapp/waba", { wabaId: waba }), "Cuenta enlazada.").then((ok) => ok && setWaba("")); }}>
              <div className="field" style={{ minWidth: 260 }}>
                <label htmlFor={`${uid}-wi`}>ID de la cuenta (WABA)</label>
                <input id={`${uid}-wi`} className="input" inputMode="numeric" value={waba} onChange={(e) => setWaba(e.target.value)} maxLength={40} required />
              </div>
              <button className="btn btn-primary" disabled={busy === "waba"}>{busy === "waba" ? "Comprobando…" : "Guardar"}</button>
            </form>
          ) : <p className="muted mt-2">Pídele a quien administra el negocio que lo agregue.</p>}
        </section>
      )}

      <section aria-labelledby={`${uid}-l`}>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 id={`${uid}-l`} className="text-[24px]">Tus plantillas</h2>
          {canManage && data.wabaSet && <button className="btn btn-sm btn-ghost-light" disabled={busy === "sync"} onClick={() => void act("sync", () => postJson("/api/whatsapp/templates/sync"), "Lista actualizada con lo que dice Meta.")}>{busy === "sync" ? "Actualizando…" : "Actualizar desde Meta"}</button>}
        </div>
        {data.templates.length === 0 ? <p className="muted-dark mt-4">Todavía no hay plantillas. Crea una abajo o pulsa «Actualizar desde Meta» si ya tienes en tu cuenta.</p> : (
          <ul className="mt-4 grid gap-3">
            {data.templates.map((t) => {
              const s = STATUS[t.status] ?? STATUS.OTHER!;
              return (
                <li key={t.id} className="card-light">
                  <div className="flex flex-wrap items-center gap-2">
                    <strong>{t.name}</strong>
                    <span className="muted text-sm">{t.language} · {CATEGORY[t.category] ?? t.category}</span>
                    <span className={s.cls}>{s.label}</span>
                    {!t.sendable && <span className="badge">Solo se envía desde Meta</span>}
                  </div>
                  <p className="mt-2 whitespace-pre-wrap">{t.body}</p>
                  <p className="muted mt-2 text-sm">{s.help}{t.reason ? ` Motivo: ${t.reason}` : ""}</p>
                  {canManage && <button className="btn btn-sm btn-text mt-2" disabled={busy === t.id} onClick={() => { if (confirm(`¿Borrar la plantilla «${t.name}»? También se borra en Meta.`)) void act(t.id, () => postJson("/api/whatsapp/templates/delete", { id: t.id }), "Plantilla borrada."); }}>Borrar</button>}
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {canManage && data.wabaSet && (
        <section className="card-light" aria-labelledby={`${uid}-c`}>
          <h2 id={`${uid}-c`} className="text-[24px]">Crear una plantilla</h2>
          <p className="muted mt-2">Empieza con un ejemplo o escribe la tuya. Las partes que cambian por cliente van como {"{{1}}"}, {"{{2}}"}… Meta la revisa antes de poder usarla.</p>
          <div className="mt-3 flex flex-wrap gap-2">
            {PRESETS.map((p, i) => <button key={p.name} type="button" className="btn btn-sm btn-ghost-light" onClick={() => applyPreset(i)}>{p.title}</button>)}
          </div>
          <form className="mt-5 grid gap-5" onSubmit={create}>
            <div className="field">
              <label htmlFor={`${uid}-n`}>Nombre (solo para ti)</label>
              <input id={`${uid}-n`} className="input" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={80} required />
              <p className="hint">Se guardará como: <code>{name || "…"}</code></p>
            </div>
            <div className="grid gap-5 sm:grid-cols-2">
              <div className="field">
                <label htmlFor={`${uid}-i`}>Idioma</label>
                <select id={`${uid}-i`} className="input" value={language} onChange={(e) => setLanguage(e.target.value)}>{LANGUAGES.map((l) => <option key={l.code} value={l.code}>{l.label}</option>)}</select>
              </div>
              <div className="field">
                <label htmlFor={`${uid}-k`}>Tipo</label>
                <select id={`${uid}-k`} className="input" value={category} onChange={(e) => setCategory(e.target.value as "UTILITY" | "MARKETING")}>
                  <option value="UTILITY">Utilidad (citas, pedidos, avisos)</option>
                  <option value="MARKETING">Marketing (ofertas, promociones)</option>
                </select>
                <p className="hint">Si es promoción, elige Marketing: Meta la reclasifica si no coincide y cuesta más.</p>
              </div>
            </div>
            <div className="field">
              <label htmlFor={`${uid}-b`}>Texto del mensaje</label>
              <textarea id={`${uid}-b`} className="input" rows={5} value={body} onChange={(e) => setBodyText(e.target.value)} maxLength={1024} required />
            </div>
            {vars > 0 && (
              <fieldset className="grid gap-3">
                <legend className="font-medium">Un ejemplo para cada variable (Meta los pide)</legend>
                {Array.from({ length: vars }, (_, i) => (
                  <div className="field" key={i}>
                    <label htmlFor={`${uid}-e${i}`}>Ejemplo de {`{{${i + 1}}}`}</label>
                    <input id={`${uid}-e${i}`} className="input" value={examples[i] ?? ""} maxLength={100} onChange={(e) => setExamples((x) => x.map((v, j) => (j === i ? e.target.value : v)))} />
                  </div>
                ))}
              </fieldset>
            )}
            <div aria-live="polite">{formError && body.trim() && <p className="alert-warn">{formError}</p>}</div>
            <button className="btn btn-primary self-start" disabled={!!formError || !name || busy === "create"}>{busy === "create" ? "Enviando a Meta…" : "Enviar a revisión"}</button>
          </form>
        </section>
      )}
    </div>
  );
}
