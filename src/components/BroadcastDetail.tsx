"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useId, useState } from "react";
import { AudienceSummary, STATUS_TEXT } from "@/components/BroadcastsManager";
import { postJson } from "@/lib/client";

interface Person { id: string; contactId: string; name: string; status: string; reason: string | null; sentAt: string | null; delivery: string | null }
interface Detail {
  broadcast: { id: string; name: string; status: string; pauseReason: string | null; total: number; templateId: string | null; templateName: string; text: string; params: unknown[]; audience: Record<string, unknown> };
  stats: { total: number; pending: number; sent: number; failed: number; omitted: number; delivered: number; read: number; not_delivered: number; replied: number };
  sentToday: number; dailyCap: number; people: Person[];
}
interface Preview { matched: number; eligible: number; excluded: Record<string, number>; sample: string[]; max: number }

const OMIT: Record<string, string> = { baja: "Pidió la baja", sin_permiso: "Sin permiso", personal: "Contacto personal", con_persona: "Lo atendía una persona", cancelada: "Cancelada", negocio_inactivo: "Negocio inactivo" };
const DELIVERY: Record<string, string> = { sent: "Enviado", delivered: "Entregado", read: "Leído", failed: "No se pudo entregar" };
const pct = (n: number, d: number) => (d > 0 ? `${Math.round((n / d) * 100)}%` : "–");

export function BroadcastDetail({ id }: { id: string }) {
  const uid = useId();
  const router = useRouter();
  const [d, setD] = useState<Detail | null>(null);
  const [state, setState] = useState<"loading" | "ok" | "missing" | "error">("loading");
  const [preview, setPreview] = useState<Preview | null>(null);
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/broadcasts/detail?id=${encodeURIComponent(id)}`, { cache: "no-store" });
      if (res.status === 404 || res.status === 400) return setState("missing");
      if (!res.ok) return setState("error");
      setD((await res.json()) as Detail); setState("ok");
    } catch { setState("error"); }
  }, [id]);
  useEffect(() => {
    const t = setTimeout(() => void load(), 0);
    return () => clearTimeout(t);
  }, [load]);
  const status = d?.broadcast.status;
  useEffect(() => {
    if (status !== "enviando") return;
    const t = setInterval(() => { if (document.visibilityState === "visible") void load(); }, 5000);
    return () => clearInterval(t);
  }, [status, load]);

  const audience = d?.broadcast.audience;
  useEffect(() => {
    if (status !== "borrador" || !audience) return;
    const t = setTimeout(async () => {
      const r = await postJson<Preview>("/api/broadcasts/preview", { audience });
      if (r.ok) setPreview(r.data);
    }, 0);
    return () => clearTimeout(t);
  }, [status, audience]);

  async function act(action: string, extra: object = {}, okText = "Listo.") {
    if (busy) return;
    setBusy(true); setMsg(null);
    const r = await postJson("/api/broadcasts/update", { id, action, ...extra });
    setBusy(false);
    if (!r.ok) return setMsg({ ok: false, text: r.data.message ?? "No se pudo completar." });
    if (action === "delete") return router.push("/difusiones");
    setMsg({ ok: true, text: okText });
    setConsent(false);
    await load();
  }

  async function resend() {
    if (!d || busy) return;
    if (!d.broadcast.templateId) return setMsg({ ok: false, text: "La plantilla de esta difusión ya no existe." });
    setBusy(true); setMsg(null);
    const r = await postJson<{ id: string }>("/api/broadcasts", {
      name: `${d.broadcast.name} (reenvío)`.slice(0, 80), templateId: d.broadcast.templateId, params: d.broadcast.params,
      audience: { from: { broadcastId: id, who: "no_leyeron" } },
    });
    setBusy(false);
    if (!r.ok) return setMsg({ ok: false, text: r.data.message ?? "No se pudo crear el reenvío." });
    router.push(`/difusiones/${r.data.id}`);
  }

  if (state === "loading") return <p className="muted-dark" role="status">Cargando…</p>;
  if (state === "missing") return (
    <div className="card-light" style={{ padding: 24 }}>
      <h2 className="text-[22px]">No encontramos esa difusión</h2>
      <Link href="/difusiones" className="btn btn-sm btn-ghost-light mt-4">Volver a difusiones</Link>
    </div>
  );
  if (state === "error" || !d) return <p className="alert-error" role="alert">No pudimos cargar la difusión. <button type="button" className="link" onClick={() => void load()}>Reintentar</button></p>;

  const b = d.broadcast; const s = d.stats;
  const done = s.sent + s.failed + s.omitted;
  const tile = (label: string, value: string | number, hint?: string) => (
    <div className="rounded-[16px] p-4" style={{ background: "var(--color-pure-white)", border: "1px solid var(--color-fog-border)" }}>
      <p className="text-[28px] font-medium">{value}</p>
      <p className="text-[14px]">{label}</p>
      {hint && <p className="muted text-[12px]">{hint}</p>}
    </div>
  );

  return (
    <div className="grid gap-6">
      <div className="card-light" style={{ padding: 24 }}>
        <div className="flex flex-wrap items-baseline justify-between gap-3">
          <h2 className="text-[24px]">{b.name}</h2>
          <span className="badge" style={{ background: "var(--color-pure-white)", color: "var(--color-ink)", border: "1px solid var(--color-field-border)" }}>{STATUS_TEXT[b.status] ?? b.status}</span>
        </div>
        <p className="mt-3 rounded-[14px] p-4 text-[15px]" style={{ background: "var(--color-mint-frost)", whiteSpace: "pre-wrap" }}>{b.text}</p>
        <p className="muted mt-2 text-[13px]">Plantilla «{b.templateName}». Cada persona recibe su nombre donde corresponda.</p>
        {b.pauseReason && <p className="alert-warn mt-4" role="alert">{b.pauseReason}</p>}
        {msg && <p className={`${msg.ok ? "alert-ok" : "alert-error"} mt-4`} role={msg.ok ? "status" : "alert"}>{msg.text}</p>}
      </div>

      {b.status === "borrador" && (
        <div className="card-light" style={{ padding: 24 }}>
          <h3 className="text-[18px]">Antes de enviar</h3>
          {preview ? <AudienceSummary p={preview} /> : <p className="muted mt-2 text-[14px]" role="status">Calculando a quién llegaría…</p>}
          <label className="mt-4 flex items-start gap-3 text-[15px]">
            <input type="checkbox" className="mt-1" checked={consent} onChange={(e) => setConsent(e.target.checked)} />
            <span>Confirmo que estas personas aceptaron recibir promociones de mi negocio por WhatsApp.</span>
          </label>
          <div className="mt-4 flex flex-wrap gap-3">
            <button type="button" className="btn btn-primary" disabled={busy || !consent || !preview || preview.eligible === 0} onClick={() => void act("start", { confirmConsent: true }, "El envío empezó. Va por tandas; puedes cerrar esta página.")}>Iniciar envío</button>
            <button type="button" className="btn btn-ghost-light" disabled={busy} onClick={() => { if (confirm("¿Borrar este borrador?")) void act("delete"); }}>Borrar borrador</button>
          </div>
        </div>
      )}

      {b.status !== "borrador" && (
        <div className="card-light" style={{ padding: 24 }}>
          <h3 className="text-[18px]">Resultados</h3>
          <div className="mt-3 h-3 w-full overflow-hidden rounded-full" style={{ background: "var(--color-fog-border)" }} role="progressbar" aria-valuemin={0} aria-valuemax={s.total} aria-valuenow={done} aria-label="Avance del envío">
            <div className="h-full" style={{ width: `${s.total ? (done / s.total) * 100 : 0}%`, background: "var(--color-ink)" }} />
          </div>
          <p className="muted mt-2 text-[14px]">{done} de {s.total} procesados{b.status === "enviando" ? ` · hoy van ${d.sentToday} de ${d.dailyCap} permitidos` : ""}</p>
          <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-3">
            {tile("Enviados", s.sent)}
            {tile("Entregados", s.delivered, pct(s.delivered, s.sent) + " de los enviados")}
            {tile("Leídos", s.read, pct(s.read, s.sent) + " de los enviados")}
            {tile("Respondieron", s.replied, pct(s.replied, s.sent) + " de los enviados")}
            {tile("Fallidos", s.failed + s.not_delivered, s.not_delivered ? `${s.not_delivered} no se entregaron` : undefined)}
            {tile("Pendientes", s.pending, s.omitted ? `${s.omitted} omitidos` : undefined)}
          </div>
          <p className="muted mt-3 text-[13px]">«Leídos» solo cuenta a quienes tienen activados los acuses de lectura en WhatsApp, así que la cifra real es mayor.</p>
        </div>
      )}

      <div className="flex flex-wrap gap-3">
        {b.status === "enviando" && <button type="button" className="btn btn-ghost-light" disabled={busy} onClick={() => void act("pause", {}, "Pausada. Los pendientes no se envían hasta que la reanudes.")}>Pausar</button>}
        {b.status === "pausada" && <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void act("resume", {}, "Reanudada.")}>Reanudar</button>}
        {["enviando", "pausada"].includes(b.status) && <button type="button" className="btn btn-ghost-light" disabled={busy} onClick={() => { if (confirm("¿Cancelar? Los mensajes pendientes no se enviarán.")) void act("cancel", {}, "Cancelada."); }}>Cancelar envío</button>}
        {["terminada", "pausada"].includes(b.status) && s.sent - s.read > 0 && <button type="button" className="btn btn-ghost-light" disabled={busy} onClick={() => void resend()}>Reenviar a quienes no la leyeron</button>}
        <Link href="/difusiones" className="btn btn-text" style={{ color: "#fff", textDecoration: "underline" }}>Todas las difusiones</Link>
      </div>

      {d.people.length > 0 && (
        <div className="card-light" style={{ padding: 24 }}>
          <h3 className="text-[18px]">Personas {s.total > d.people.length ? `(primeras ${d.people.length} de ${s.total})` : ""}</h3>
          <table className="mt-3 w-full text-left text-[14px]">
            <caption className="sr-only">Estado del envío por persona</caption>
            <thead><tr><th scope="col" className="py-2">Cliente</th><th scope="col">Estado</th></tr></thead>
            <tbody>
              {d.people.map((p) => (
                <tr key={p.id} style={{ borderTop: "1px solid var(--color-fog-border)" }}>
                  <td className="py-2"><Link href={`/clientes/${p.contactId}`} className="link">{p.name}</Link></td>
                  <td>
                    {p.status === "enviado" ? (p.delivery ? DELIVERY[p.delivery] : "Enviado")
                      : p.status === "omitido" ? `Omitido: ${OMIT[p.reason ?? ""] ?? p.reason ?? ""}`
                      : p.status === "fallido" ? `Falló: ${p.reason ?? ""}`
                      : "Pendiente"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <span id={`${uid}-end`} />
    </div>
  );
}
