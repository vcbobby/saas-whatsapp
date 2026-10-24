"use client";

import { useRouter } from "next/navigation";
import { useId, useState, type FormEvent } from "react";
import { postJson } from "@/lib/client";

function fmt(iso: string) {
  return new Intl.DateTimeFormat("es", { dateStyle: "long", timeStyle: "short" }).format(new Date(iso));
}

/** «Tus datos»: descargar todo y pedir la eliminación del negocio (solo la persona dueña). */
export function PrivacyPanel({ businessName, mfaEnabled, scheduledFor }: { businessName: string; mfaEnabled: boolean; scheduledFor: string | null }) {
  const router = useRouter();
  const uid = useId();
  const [busy, setBusy] = useState<null | "export" | "delete" | "cancel">(null);
  const [error, setError] = useState<string | null>(null);
  const [okMsg, setOkMsg] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);

  async function download(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (busy) return;
    const f = new FormData(e.currentTarget);
    setBusy("export"); setError(null); setOkMsg(null);
    try {
      const res = await fetch("/api/privacy/export", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password: String(f.get("password") ?? ""), ...(mfaEnabled ? { code: String(f.get("code") ?? "") } : {}) }),
      });
      if (!res.ok) {
        const d = (await res.json().catch(() => ({}))) as { message?: string };
        setError(d.message ?? "No se pudo preparar la descarga.");
        return;
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = /filename="([^"]+)"/.exec(res.headers.get("content-disposition") ?? "")?.[1] ?? "mis-datos.json";
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
      setOkMsg("Descarga lista. Guarda el archivo en un lugar seguro: contiene datos de tus clientes.");
      e.currentTarget.reset();
    } catch {
      setError("No hay conexión con el servidor. Revisa tu internet e intenta de nuevo.");
    } finally {
      setBusy(null);
    }
  }

  async function requestDelete(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (busy) return;
    const f = new FormData(e.currentTarget);
    setBusy("delete"); setError(null); setOkMsg(null);
    const r = await postJson("/api/privacy/delete", { confirmName: String(f.get("confirmName") ?? ""), password: String(f.get("password") ?? ""), ...(mfaEnabled ? { code: String(f.get("code") ?? "") } : {}) });
    setBusy(null);
    if (!r.ok) return setError(r.data.message ?? "No se pudo pedir la eliminación.");
    setConfirming(false);
    router.refresh();
  }

  async function cancel() {
    if (busy) return;
    setBusy("cancel"); setError(null);
    const r = await postJson("/api/privacy/cancel", {});
    setBusy(null);
    if (!r.ok) return setError(r.data.message ?? "No se pudo cancelar.");
    router.refresh();
  }

  return (
    <section className="card-light" style={{ maxWidth: 640 }} aria-labelledby={`${uid}-t`}>
      <p className="eyebrow">Tus datos</p>
      <h2 id={`${uid}-t`} className="mt-3 text-[28px]">Descargar o eliminar todo</h2>

      {scheduledFor ? (
        <div className="mt-4">
          <p className="alert-warn" role="status">
            Este negocio se eliminará <strong>definitivamente el {fmt(scheduledFor)}</strong>. Hasta entonces puedes cancelarlo y todo sigue igual.
          </p>
          <div className="mt-4"><button type="button" className="btn btn-primary" disabled={busy !== null} onClick={() => void cancel()}>{busy === "cancel" ? "Cancelando…" : "Cancelar la eliminación"}</button></div>
        </div>
      ) : null}

      <h3 className="mt-6 text-[20px]">Descargar mis datos</h3>
      <p className="muted mt-2 text-[15px]">Un archivo con todo lo de tu negocio: contactos, conversaciones, citas, pedidos, catálogo, documentos y más. Por seguridad te pedimos la contraseña.</p>
      <form onSubmit={download} className="mt-4 grid gap-4">
        <div className="field"><label htmlFor={`${uid}-p1`}>Tu contraseña</label><input id={`${uid}-p1`} name="password" type="password" className="input" autoComplete="current-password" required maxLength={128} /></div>
        {mfaEnabled && <div className="field"><label htmlFor={`${uid}-c1`}>Código de verificación en dos pasos</label><input id={`${uid}-c1`} name="code" className="input" inputMode="text" autoComplete="one-time-code" required maxLength={20} /></div>}
        <div><button type="submit" className="btn btn-primary" disabled={busy !== null}>{busy === "export" ? "Preparando…" : "Descargar mis datos"}</button></div>
      </form>

      {!scheduledFor && (
        <>
          <h3 className="mt-8 text-[20px]">Eliminar mi negocio</h3>
          <p className="muted mt-2 text-[15px]">
            Se borran el negocio, sus conversaciones, contactos, citas, pedidos y las cuentas de quienes solo pertenecían a él. Tienes 7 días para arrepentirte; después no se puede recuperar. Descarga tus datos antes.
          </p>
          {!confirming ? (
            <div className="mt-4"><button type="button" className="btn btn-ghost-light" onClick={() => { setConfirming(true); setError(null); }}>Quiero eliminar mi negocio</button></div>
          ) : (
            <form onSubmit={requestDelete} className="mt-4 grid gap-4">
              <div className="field"><label htmlFor={`${uid}-n`}>Escribe el nombre del negocio: <strong style={{ overflowWrap: "anywhere" }}>{businessName}</strong></label><input id={`${uid}-n`} name="confirmName" className="input" autoComplete="off" required maxLength={200} /></div>
              <div className="field"><label htmlFor={`${uid}-p2`}>Tu contraseña</label><input id={`${uid}-p2`} name="password" type="password" className="input" autoComplete="current-password" required maxLength={128} /></div>
              {mfaEnabled && <div className="field"><label htmlFor={`${uid}-c2`}>Código de verificación en dos pasos</label><input id={`${uid}-c2`} name="code" className="input" autoComplete="one-time-code" required maxLength={20} /></div>}
              <div className="flex flex-wrap gap-3">
                <button type="submit" className="btn btn-primary" disabled={busy !== null}>{busy === "delete" ? "Enviando…" : "Eliminar en 7 días"}</button>
                <button type="button" className="btn btn-ghost-light" onClick={() => setConfirming(false)}>No, volver</button>
              </div>
            </form>
          )}
        </>
      )}
      {error && <p className="alert-error mt-4" role="alert">{error}</p>}
      {okMsg && <p className="alert-ok mt-4" role="status">{okMsg}</p>}
    </section>
  );
}
