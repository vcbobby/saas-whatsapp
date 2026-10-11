"use client";

import { useCallback, useEffect, useId, useRef, useState, type FormEvent } from "react";

interface Doc {
  id: string;
  title: string;
  status: "pending" | "indexing" | "ready" | "failed";
  error: string | null;
  chunk_count: number;
  chars: number;
}

const STATUS: Record<Doc["status"], string> = {
  pending: "En cola",
  indexing: "Indexando…",
  ready: "Listo",
  failed: "Con error",
};

const MAX_CHARS = 50_000;
const MAX_FILE_BYTES = 200_000;
const neutralBadge = { background: "var(--color-pure-white)", color: "var(--color-deep-abyss)", border: "1px solid var(--color-stone-border)" } as const;

export function KnowledgeBase({ canManage, fakeEmbeddings }: { canManage: boolean; fakeEmbeddings: boolean }) {
  const uid = useId();
  const [docs, setDocs] = useState<Doc[] | null>(null);
  const [max, setMax] = useState(50);
  const [editing, setEditing] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/kb", { cache: "no-store" });
      if (!res.ok) return;
      const d = (await res.json()) as { documents: Doc[]; maxDocuments: number };
      setDocs(d.documents);
      setMax(d.maxDocuments);
    } catch {
      /* sin conexión: se reintenta en el siguiente ciclo */
    }
  }, []);

  useEffect(() => {
    const t = setTimeout(() => void load(), 0);
    return () => clearTimeout(t);
  }, [load]);

  // Mientras haya documentos en proceso, se consulta cada 2,5 s.
  const working = docs?.some((d) => d.status === "pending" || d.status === "indexing") ?? false;
  useEffect(() => {
    if (!working) return;
    const t = setInterval(() => void load(), 2500);
    return () => clearInterval(t);
  }, [working, load]);

  async function post(body: unknown) {
    const res = await fetch("/api/kb", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const d = (await res.json().catch(() => ({}))) as { message?: string; documents?: number };
    if (!res.ok) throw new Error(d.message ?? "No se pudo completar la acción.");
    return d;
  }

  function reset() {
    setEditing(null);
    setTitle("");
    setContent("");
    if (fileRef.current) fileRef.current.value = "";
  }

  async function save(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    setInfo(null);
    try {
      await post(editing ? { action: "update", id: editing, title, content } : { action: "create", title, content });
      reset();
      setInfo("Guardado. El asistente podrá usarlo en cuanto termine de indexarse.");
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo guardar.");
    } finally {
      setBusy(false);
    }
  }

  async function edit(id: string) {
    setError(null);
    setInfo(null);
    try {
      const res = await fetch(`/api/kb?id=${encodeURIComponent(id)}`, { cache: "no-store" });
      const d = (await res.json()) as { document?: { title: string; content: string } };
      if (!res.ok || !d.document) throw new Error();
      setEditing(id);
      setTitle(d.document.title);
      setContent(d.document.content);
      document.getElementById(`${uid}-title`)?.focus();
    } catch {
      setError("No se pudo abrir el documento.");
    }
  }

  async function remove(d: Doc) {
    if (!window.confirm(`¿Borrar «${d.title}»? El asistente dejará de usarlo.`)) return;
    setError(null);
    setInfo(null);
    try {
      await post({ action: "delete", id: d.id });
      if (editing === d.id) reset();
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo borrar.");
    }
  }

  async function reindex() {
    setError(null);
    setInfo(null);
    try {
      const d = await post({ action: "reindex" });
      setInfo(`Se volverán a indexar ${d.documents ?? 0} documento(s).`);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo reindexar.");
    }
  }

  async function onFile(file: File | undefined) {
    setError(null);
    if (!file) return;
    if (!/\.(txt|md)$/i.test(file.name)) return setError("Por ahora solo se aceptan archivos .txt o .md. Para un PDF, copia el texto y pégalo aquí.");
    if (file.size > MAX_FILE_BYTES) return setError("El archivo es muy grande (máximo 200 KB de texto).");
    const text = await file.text();
    if (text.length > MAX_CHARS) return setError(`El texto pasa de ${MAX_CHARS.toLocaleString("es")} caracteres. Divídelo en varios documentos.`);
    setContent(text);
    if (!title) setTitle(file.name.replace(/\.(txt|md)$/i, "").slice(0, 120));
  }

  return (
    <section className="card-light" style={{ maxWidth: 820 }}>
      <p className="eyebrow">Conocimiento</p>
      <h2 className="mt-3 text-[28px]">Documentos para tu asistente</h2>
      <p className="muted mt-3">
        Agrega catálogos, políticas, preguntas frecuentes o cualquier texto largo. Cuando un cliente pregunte, el asistente buscará los fragmentos
        más parecidos y responderá con ellos. Lo corto e importante (horarios, dirección) va mejor en la información de tu negocio.
      </p>
      {fakeEmbeddings && (
        <p className="alert-warn mt-4" role="status">
          Modo de prueba: la búsqueda solo encuentra palabras iguales, no entiende sinónimos. Activa el modelo local para producción.
        </p>
      )}

      <div className="mt-6" aria-live="polite">
        {docs === null ? (
          <p className="muted" role="status">Cargando…</p>
        ) : docs.length === 0 ? (
          <p className="muted">Aún no hay documentos.</p>
        ) : (
          <ul className="flex flex-col gap-3" style={{ listStyle: "none", padding: 0 }}>
            {docs.map((d) => (
              <li key={d.id} className="flex flex-wrap items-center justify-between gap-3" style={{ border: "1px solid rgba(18,32,30,0.2)", borderRadius: 16, padding: "12px 16px" }}>
                <div style={{ minWidth: 0 }}>
                  <p style={{ fontWeight: 500, overflowWrap: "anywhere" }}>{d.title}</p>
                  <p className="muted" style={{ fontSize: 14 }}>
                    {d.chars.toLocaleString("es")} caracteres{d.status === "ready" ? ` · ${d.chunk_count} fragmentos` : ""}
                  </p>
                  {d.error && <p className="muted" style={{ fontSize: 14 }}>{d.error}</p>}
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <span className="badge" style={neutralBadge}>{STATUS[d.status]}</span>
                  {canManage && (
                    <>
                      <button type="button" className="btn btn-secondary btn-sm" onClick={() => void edit(d.id)}>Editar</button>
                      <button type="button" className="btn btn-secondary btn-sm" onClick={() => void remove(d)}>Borrar</button>
                    </>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
        {docs && <p className="muted mt-3" style={{ fontSize: 14 }}>{docs.length} de {max} documentos.</p>}
      </div>

      {canManage ? (
        <form onSubmit={save} className="mt-8 flex flex-col gap-5">
          <h3 className="text-[20px]">{editing ? "Editar documento" : "Agregar documento"}</h3>
          <div className="field">
            <label htmlFor={`${uid}-title`}>Título</label>
            <input id={`${uid}-title`} className="input" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={120} required />
          </div>
          <div className="field">
            <label htmlFor={`${uid}-content`}>Texto</label>
            <textarea id={`${uid}-content`} className="input" style={{ minHeight: 220, resize: "vertical" }} value={content} onChange={(e) => setContent(e.target.value)} maxLength={MAX_CHARS} required aria-describedby={`${uid}-hint`} />
            <p id={`${uid}-hint`} className="hint">
              {content.length.toLocaleString("es")} de {MAX_CHARS.toLocaleString("es")} caracteres. No pegues contraseñas ni datos privados de clientes.
            </p>
          </div>
          <div className="field">
            <label htmlFor={`${uid}-file`}>O sube un archivo de texto (.txt o .md)</label>
            <input id={`${uid}-file`} ref={fileRef} type="file" accept=".txt,.md,text/plain,text/markdown" onChange={(e) => void onFile(e.target.files?.[0])} />
          </div>
          <div role="alert" aria-live="assertive">{error && <p className="alert-error">{error}</p>}</div>
          <div role="status" aria-live="polite">{info && <p className="muted">{info}</p>}</div>
          <div className="flex flex-wrap gap-3">
            <button type="submit" className="btn btn-primary" disabled={busy}>{busy ? "Guardando…" : editing ? "Guardar cambios" : "Agregar"}</button>
            {editing && <button type="button" className="btn btn-secondary" onClick={reset}>Cancelar</button>}
          </div>
          {docs && docs.length > 0 && (
            <p className="muted" style={{ fontSize: 14 }}>
              ¿Cambiaste el modelo de búsqueda? <button type="button" className="link" onClick={() => void reindex()}>Volver a indexar todo</button>
            </p>
          )}
        </form>
      ) : (
        <p className="muted mt-6">Solo dueños y administradores pueden cambiar los documentos.</p>
      )}
    </section>
  );
}
