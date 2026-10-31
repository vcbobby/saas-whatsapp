"use client";

import { useEffect, useId, useState, type FormEvent } from "react";

interface Data { enabled: boolean; phone: string; intro: string; products: number; url: string }

export function StorefrontSettings() {
  const [data, setData] = useState<Data | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    const t = setTimeout(async () => {
      try {
        const res = await fetch("/api/public-catalog", { cache: "no-store" });
        if (!res.ok) return setFailed(true);
        setData((await res.json()) as Data);
      } catch { setFailed(true); }
    }, 0);
    return () => clearTimeout(t);
  }, []);
  if (failed) return <p role="alert">No se pudo cargar. Recarga la página.</p>;
  if (!data) return <p className="muted-dark" role="status">Cargando…</p>;
  return <Form data={data} />;
}

function Form({ data }: { data: Data }) {
  const uid = useId();
  const [enabled, setEnabled] = useState(data.enabled);
  const [phone, setPhone] = useState(data.phone);
  const [intro, setIntro] = useState(data.intro);
  const [saved, setSaved] = useState(data.enabled);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [copied, setCopied] = useState(false);

  async function save(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    setBusy(true); setMsg(null);
    try {
      const res = await fetch("/api/public-catalog", { method: "PUT", headers: { "content-type": "application/json" }, cache: "no-store", body: JSON.stringify({ enabled, phone, intro }) });
      const j = (await res.json().catch(() => ({}))) as { message?: string };
      if (res.ok) { setSaved(enabled); setMsg({ ok: true, text: "Guardado." }); } else setMsg({ ok: false, text: j.message ?? "No se pudo guardar." });
    } catch { setMsg({ ok: false, text: "No hay conexión con el servidor." }); }
    setBusy(false);
  }
  async function copy() {
    try { await navigator.clipboard.writeText(data.url); setCopied(true); setTimeout(() => setCopied(false), 2000); } catch { /* el enlace está a la vista para copiarlo a mano */ }
  }

  return (
    <div className="flex max-w-[760px] flex-col gap-8">
      <form onSubmit={save} className="flex flex-col gap-5">
        <label className="flex items-center gap-2 text-[16px]">
          <input type="checkbox" checked={enabled} onChange={(e) => { setEnabled(e.target.checked); setMsg(null); }} />
          Mostrar mi catálogo en una página pública
        </label>
        <div>
          <label htmlFor={`${uid}-p`} className="block font-medium">WhatsApp al que te escriben</label>
          <input id={`${uid}-p`} className="input mt-1" inputMode="tel" value={phone} onChange={(e) => { setPhone(e.target.value); setMsg(null); }} placeholder="58 412 1234567" />
          <p className="muted-dark mt-1 text-[13px]">Con código de país y sin el 0 inicial. Los pedidos llegan a este número.</p>
        </div>
        <div>
          <label htmlFor={`${uid}-i`} className="block font-medium">Presentación (opcional)</label>
          <textarea id={`${uid}-i`} className="input mt-1" rows={3} maxLength={300} value={intro} onChange={(e) => { setIntro(e.target.value); setMsg(null); }} placeholder="Entregas en toda la ciudad. Atendemos de lunes a sábado." />
        </div>
        {data.products === 0 && <p className="muted-dark text-[14px]">Todavía no tienes productos activos en el catálogo: la página saldría vacía.</p>}
        {msg && <p role={msg.ok ? "status" : "alert"} className="text-[14px]">{msg.text}</p>}
        <button type="submit" className="btn btn-primary" style={{ alignSelf: "flex-start" }} disabled={busy}>{busy ? "Guardando…" : "Guardar"}</button>
      </form>
      {saved ? (
        <section className="card flex flex-col gap-3 p-5" aria-labelledby={`${uid}-s`}>
          <h2 id={`${uid}-s`} className="text-[20px]">Tu enlace y código QR</h2>
          <p className="break-all text-[15px]"><a className="underline" href={data.url} target="_blank" rel="noopener noreferrer">{data.url}</a></p>
          <div className="flex flex-wrap gap-3">
            <button type="button" className="btn btn-secondary btn-sm" onClick={() => void copy()}>{copied ? "¡Copiado!" : "Copiar enlace"}</button>
            <a className="btn btn-secondary btn-sm" href="/api/public-catalog/qr" download="catalogo-qr.svg">Descargar QR</a>
          </div>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/api/public-catalog/qr" alt="Código QR del catálogo" width={180} height={180} style={{ background: "#fff", padding: 8 }} />
          <p className="muted-dark text-[13px]">Imprímelo en tu local, empaques o tarjetas. Quien lo escanee ve tu catálogo y te pide por WhatsApp.</p>
        </section>
      ) : <p className="muted-dark text-[14px]">Cuando lo publiques, aquí verás tu enlace y tu código QR.</p>}
    </div>
  );
}
