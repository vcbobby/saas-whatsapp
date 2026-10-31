"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useId, useMemo, useState, type FormEvent } from "react";
import { EmptyState } from "@/components/EmptyState";
import { postJson } from "@/lib/client";
import { hasOptOut } from "@/lib/broadcasts/template";
import { variablesOf } from "@/lib/whatsapp/templates";
import { WHY_TEXT } from "@/lib/broadcasts/audience";

interface Row { id: string; name: string; status: string; pauseReason: string | null; total: number; sent: number; failed: number; pending: number; createdAt: string }
interface Tpl { id: string; name: string; language: string; category: string; body: string; sendable: boolean; status: string }
interface Preview { matched: number; eligible: number; excluded: Record<string, number>; sample: string[]; max: number }
type ParamDraft = { kind: "nombre" | "texto"; value: string };

export const STATUS_TEXT: Record<string, string> = { borrador: "Borrador", enviando: "Enviando", pausada: "Pausada", terminada: "Terminada", cancelada: "Cancelada" };
const day = (iso: string) => new Intl.DateTimeFormat("es-VE", { day: "numeric", month: "short", year: "numeric" }).format(new Date(iso));

export function BroadcastsManager() {
  const uid = useId();
  const router = useRouter();
  const [rows, setRows] = useState<Row[] | null>(null);
  const [templates, setTemplates] = useState<Tpl[] | null>(null);
  const [tags, setTags] = useState<string[]>([]);
  const [failed, setFailed] = useState(false);
  const [open, setOpen] = useState(false);

  const [name, setName] = useState("");
  const [tplId, setTplId] = useState("");
  const [params, setParams] = useState<ParamDraft[]>([]);
  const [tag, setTag] = useState("");
  const [label, setLabel] = useState("");
  const [preview, setPreview] = useState<Preview | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [b, t, c] = await Promise.all([
        fetch("/api/broadcasts", { cache: "no-store" }),
        fetch("/api/whatsapp/templates", { cache: "no-store" }),
        fetch("/api/customers", { cache: "no-store" }),
      ]);
      if (!b.ok) return setFailed(true);
      setRows(((await b.json()) as { broadcasts: Row[] }).broadcasts);
      if (t.ok) setTemplates(((await t.json()) as { templates: Tpl[] }).templates);
      if (c.ok) setTags(((await c.json()) as { tags: { tag: string }[] }).tags.map((x) => x.tag));
    } catch { setFailed(true); }
  }, []);
  useEffect(() => {
    const t = setTimeout(() => void load(), 0);
    return () => clearTimeout(t);
  }, [load]);

  const usable = useMemo(() => (templates ?? []).filter((t) => t.status === "APPROVED" && t.sendable && hasOptOut(t.body)), [templates]);
  const tpl = usable.find((t) => t.id === tplId);
  const nVars = tpl ? variablesOf(tpl.body).length : 0;
  const audience = useMemo(() => ({ ...(tag ? { tag } : {}), ...(label ? { label } : {}) }), [tag, label]);

  function pickTemplate(id: string) {
    setTplId(id);
    const t = usable.find((x) => x.id === id);
    setParams(t ? variablesOf(t.body).map((_, i) => (i === 0 ? { kind: "nombre" as const, value: "" } : { kind: "texto" as const, value: "" })) : []);
  }

  async function runPreview() {
    setBusy(true); setError(null);
    const r = await postJson<Preview>("/api/broadcasts/preview", { audience });
    setBusy(false);
    if (!r.ok) return setError(r.data.message ?? "No se pudo calcular.");
    setPreview(r.data);
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    setBusy(true); setError(null);
    const r = await postJson<{ id: string }>("/api/broadcasts", {
      name, templateId: tplId, audience,
      params: params.map((p) => (p.kind === "nombre" ? { kind: "nombre" } : { kind: "texto", value: p.value })),
    });
    setBusy(false);
    if (!r.ok) return setError(r.data.message ?? "No se pudo crear la difusión.");
    router.push(`/difusiones/${r.data.id}`);
  }

  if (failed) return <p className="alert-error" role="alert">No pudimos cargar las difusiones. <button type="button" className="link" onClick={() => void load()}>Reintentar</button></p>;
  if (!rows || !templates) return <p className="muted-dark" role="status">Cargando…</p>;

  return (
    <div className="grid gap-8">
      {usable.length === 0 && (
        <div className="card-light" style={{ padding: 24, maxWidth: 820 }}>
          <h2 className="text-[20px]">Primero necesitas una plantilla de promoción</h2>
          <p className="muted mt-2 text-[15px]">WhatsApp solo deja escribirle primero a un cliente con una plantilla aprobada. Debe incluir cómo darse de baja, por ejemplo: «Hola {"{{1}}"}, esta semana 20% de descuento. Responde BAJA para no recibir más promociones.»</p>
          <p className="mt-3"><Link href="/whatsapp" className="btn btn-sm btn-primary">Crear una plantilla</Link></p>
          {templates.some((t) => t.status === "APPROVED" && !hasOptOut(t.body)) && <p className="muted mt-3 text-[14px]">Tienes plantillas aprobadas, pero ninguna menciona la baja.</p>}
        </div>
      )}

      {!open ? (
        <p><button type="button" className="btn btn-primary" disabled={usable.length === 0} onClick={() => setOpen(true)}>Nueva difusión</button></p>
      ) : (
        <form className="card-light grid gap-5" style={{ padding: 24, maxWidth: 820 }} onSubmit={submit} aria-label="Nueva difusión">
          <h2 className="text-[22px]">Nueva difusión</h2>
          <div className="field">
            <label htmlFor={`${uid}-n`}>Nombre (solo lo ves tú)</label>
            <input id={`${uid}-n`} className="input" value={name} maxLength={80} onChange={(e) => setName(e.target.value)} placeholder="Ej. Promo fin de semana" required />
          </div>
          <div className="field">
            <label htmlFor={`${uid}-t`}>Plantilla</label>
            <select id={`${uid}-t`} className="input" value={tplId} onChange={(e) => pickTemplate(e.target.value)} required>
              <option value="">Elige una plantilla aprobada…</option>
              {usable.map((t) => <option key={t.id} value={t.id}>{t.name} ({t.language})</option>)}
            </select>
          </div>
          {tpl && <p className="rounded-[14px] p-4 text-[15px]" style={{ background: "var(--color-mint-frost)", whiteSpace: "pre-wrap" }}>{tpl.body}</p>}
          {tpl && nVars > 0 && (
            <fieldset className="grid gap-3">
              <legend className="text-[15px] font-medium">¿Qué va en cada variable?</legend>
              {params.map((p, i) => (
                <div key={i} className="flex flex-wrap items-end gap-3">
                  <div className="field">
                    <label htmlFor={`${uid}-pk${i}`}>{`{{${i + 1}}}`}</label>
                    <select id={`${uid}-pk${i}`} className="input" value={p.kind} onChange={(e) => setParams(params.map((x, j) => (j === i ? { ...x, kind: e.target.value as ParamDraft["kind"] } : x)))}>
                      <option value="nombre">Nombre del cliente</option>
                      <option value="texto">Un texto fijo</option>
                    </select>
                  </div>
                  {p.kind === "texto" && (
                    <div className="field">
                      <label htmlFor={`${uid}-pv${i}`}>Texto</label>
                      <input id={`${uid}-pv${i}`} className="input" value={p.value} maxLength={100} required onChange={(e) => setParams(params.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)))} />
                    </div>
                  )}
                </div>
              ))}
            </fieldset>
          )}
          <fieldset className="grid gap-3 sm:grid-cols-2">
            <legend className="text-[15px] font-medium">¿A quién?</legend>
            <div className="field">
              <label htmlFor={`${uid}-tag`}>Etiqueta</label>
              <select id={`${uid}-tag`} className="input" value={tag} onChange={(e) => { setTag(e.target.value); setPreview(null); }}>
                <option value="">Todas las personas</option>
                {tags.map((t) => <option key={t} value={t}>{t}</option>)}
              </select>
            </div>
            <div className="field">
              <label htmlFor={`${uid}-lab`}>Tipo de contacto</label>
              <select id={`${uid}-lab`} className="input" value={label} onChange={(e) => { setLabel(e.target.value); setPreview(null); }}>
                <option value="">Todos</option><option value="cliente">Clientes</option><option value="prospecto">Prospectos</option><option value="sin_clasificar">Sin clasificar</option>
              </select>
            </div>
          </fieldset>
          <div>
            <button type="button" className="btn btn-sm btn-ghost-light" disabled={busy} onClick={() => void runPreview()}>Ver a cuántas personas llegaría</button>
            {preview && <AudienceSummary p={preview} />}
          </div>
          {error && <p className="alert-error" role="alert">{error}</p>}
          <div className="flex flex-wrap gap-3">
            <button type="submit" className="btn btn-primary" disabled={busy || !tpl}>Crear borrador</button>
            <button type="button" className="btn btn-ghost-light" onClick={() => setOpen(false)}>Cancelar</button>
          </div>
          <p className="muted text-[14px]">Crear el borrador no envía nada: en el siguiente paso lo revisas y confirmas.</p>
        </form>
      )}

      {rows.length === 0 ? (
        usable.length > 0 && <EmptyState tone="dark" title="Todavía no has hecho difusiones" text="Crea tu primera promoción: eliges la plantilla y a quién, revisas la vista previa y la envías cuando quieras." help="difusiones" />
      ) : (
        <ul className="grid gap-3" style={{ maxWidth: 820 }}>
          {rows.map((b) => (
            <li key={b.id}>
              <Link href={`/difusiones/${b.id}`} className="card-light block" style={{ padding: 16 }}>
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <strong className="text-[18px]">{b.name}</strong>
                  <span className="badge" style={{ background: "var(--color-pure-white)", color: "var(--color-ink)", border: "1px solid var(--color-field-border)" }}>{STATUS_TEXT[b.status] ?? b.status}</span>
                </div>
                <p className="muted mt-1 text-[14px]">
                  {b.status === "borrador" ? "Sin enviar" : `${b.sent} de ${b.total} enviados${b.failed ? ` · ${b.failed} fallidos` : ""}${b.pending ? ` · ${b.pending} pendientes` : ""}`} · {day(b.createdAt)}
                </p>
                {b.pauseReason && <p className="alert-warn mt-2 text-[14px]">{b.pauseReason}</p>}
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function AudienceSummary({ p }: { p: Preview }) {
  const out = Object.entries(p.excluded);
  return (
    <div className="mt-3 text-[15px]" role="status">
      <p><strong>{p.eligible}</strong> {p.eligible === 1 ? "persona recibiría" : "personas recibirían"} la difusión (de {p.matched} que coinciden).</p>
      {p.sample.length > 0 && <p className="muted text-[14px]">Por ejemplo: {p.sample.join(", ")}.</p>}
      {out.length > 0 && (
        <ul className="muted mt-2 list-disc pl-5 text-[14px]">
          {out.map(([k, n]) => <li key={k}>{n} {n === 1 ? "queda fuera: " : "quedan fuera: "}{WHY_TEXT[k] ?? k}</li>)}
        </ul>
      )}
      {p.eligible > p.max && <p className="alert-warn mt-2">Son más de {p.max}: filtra por una etiqueta para enviarlo por partes.</p>}
    </div>
  );
}
