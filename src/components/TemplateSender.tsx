"use client";

import { useEffect, useId, useRef, useState } from "react";
import { postJson } from "@/lib/client";
import { renderBody, variablesOf } from "@/lib/whatsapp/templates";

interface Tpl { id: string; name: string; language: string; body: string; sendable: boolean; status: string }

/** Cuando pasaron más de 24 h: elegir una plantilla aprobada, llenar sus datos y enviarla. */
export function TemplateSender({ conversationId, onSent }: { conversationId: string; onSent: () => void }) {
  const uid = useId();
  const [tpls, setTpls] = useState<Tpl[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [pick, setPick] = useState("");
  const [params, setParams] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const key = useRef<string | null>(null);

  useEffect(() => {
    let alive = true;
    void fetch("/api/whatsapp/templates")
      .then(async (r) => {
        if (!alive) return;
        if (!r.ok) return setFailed(true);
        const d = (await r.json()) as { templates: Tpl[] };
        setTpls(d.templates.filter((t) => t.status === "APPROVED" && t.sendable));
      })
      .catch(() => alive && setFailed(true));
    return () => { alive = false; };
  }, []);

  const t = tpls?.find((x) => x.id === pick);
  const n = t ? variablesOf(t.body).length : 0;

  function choose(id: string) {
    setPick(id); setDone(false); setError(null); key.current = null;
    const x = tpls?.find((y) => y.id === id);
    setParams(Array(x ? variablesOf(x.body).length : 0).fill(""));
  }
  async function send() {
    if (!t || busy) return;
    setBusy(true); setError(null);
    key.current ??= crypto.randomUUID();
    const r = await postJson("/api/conversations/template", { id: conversationId, clientKey: key.current, templateId: t.id, params });
    setBusy(false);
    if (r.ok) { setDone(true); key.current = null; setPick(""); setParams([]); onSent(); return; }
    setError(r.data.message ?? "No se pudo enviar.");
    if ((r.data as { error?: string }).error !== "envio_en_curso" && r.status !== 0) key.current = null;
  }

  return (
    <div className="alert-warn mt-4" role="group" aria-labelledby={`${uid}-t`}>
      <p id={`${uid}-t`}>
        Pasaron más de 24 horas desde el último mensaje del cliente: WhatsApp solo permite escribirle con una <strong>plantilla aprobada</strong>. Cuando el cliente responda, podrás escribir libremente.
      </p>
      {failed && <p className="mt-2">No se pudieron cargar tus plantillas.</p>}
      {tpls && tpls.length === 0 && <p className="mt-2">No tienes plantillas aprobadas todavía. <a className="link" href="/whatsapp/plantillas">Crea una aquí</a>.</p>}
      {tpls && tpls.length > 0 && (
        <div className="mt-3 grid gap-3">
          <div className="field">
            <label htmlFor={`${uid}-s`}>Plantilla</label>
            <select id={`${uid}-s`} className="input" value={pick} onChange={(e) => choose(e.target.value)}>
              <option value="">Elige una…</option>
              {tpls.map((x) => <option key={x.id} value={x.id}>{x.name} ({x.language})</option>)}
            </select>
          </div>
          {t && Array.from({ length: n }, (_, i) => (
            <div className="field" key={i}>
              <label htmlFor={`${uid}-p${i}`}>Dato {`{{${i + 1}}}`}</label>
              <input id={`${uid}-p${i}`} className="input" value={params[i] ?? ""} maxLength={200} onChange={(e) => setParams((p) => p.map((v, j) => (j === i ? e.target.value : v)))} />
            </div>
          ))}
          {t && <p className="whitespace-pre-wrap rounded border p-3 text-sm" aria-label="Vista previa">{renderBody(t.body, params.map((p, i) => p || `{{${i + 1}}}`))}</p>}
          {t && <button type="button" className="btn btn-sm btn-primary self-start" disabled={busy || params.some((p) => !p.trim())} onClick={() => void send()}>{busy ? "Enviando…" : "Enviar plantilla"}</button>}
        </div>
      )}
      <div role="alert" aria-live="assertive">{error && <p className="alert-error mt-3">{error}</p>}</div>
      {done && <p className="alert-ok mt-3" role="status">Plantilla enviada.</p>}
    </div>
  );
}
