"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useId, useState } from "react";
import { postJson } from "@/lib/client";

/** Aviso para quien ya tiene cuenta y todavía no aceptó la versión vigente de los documentos legales. */
export function LegalReaccept({ version, first }: { version: string; first: boolean }) {
  const router = useRouter();
  const uid = useId();
  const [checked, setChecked] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function accept() {
    if (!checked || busy) return;
    setBusy(true);
    setError(null);
    const r = await postJson("/api/legal/accept", { version });
    setBusy(false);
    if (r.ok) { router.refresh(); return; }
    setError(r.data.message ?? "No se pudo guardar. Intenta de nuevo.");
  }

  return (
    <section className="card-light mb-8" style={{ maxWidth: 720 }} aria-labelledby={`${uid}-t`} role="region">
      <p className="eyebrow">Documentos legales</p>
      <h2 id={`${uid}-t`} className="mt-3 text-[24px]">{first ? "Confirma que aceptas los términos" : "Actualizamos nuestros documentos legales"}</h2>
      <p className="muted mt-2">
        {first ? "Para seguir usando el servicio necesitamos que aceptes los términos y la política de privacidad." : "Cambiamos los términos o la política de privacidad. Léelos y acéptalos para seguir usando el servicio."}
      </p>
      <div className="mt-4 flex items-start gap-3">
        <input id={`${uid}-c`} type="checkbox" checked={checked} onChange={(e) => setChecked(e.target.checked)} style={{ marginTop: 4, width: 18, height: 18, flex: "none" }} />
        <label htmlFor={`${uid}-c`} className="text-[15px]" style={{ lineHeight: 1.5 }}>
          He leído y acepto los <Link href="/legal/terminos" target="_blank" rel="noopener" className="link">términos y condiciones</Link>, la{" "}
          <Link href="/legal/privacidad" target="_blank" rel="noopener" className="link">política de privacidad</Link> y la{" "}
          <Link href="/legal/uso-aceptable" target="_blank" rel="noopener" className="link">política de uso aceptable</Link>.
        </label>
      </div>
      {error && <p className="alert-error mt-4" role="alert">{error}</p>}
      <div className="mt-4"><button type="button" className="btn btn-primary" disabled={!checked || busy} onClick={() => void accept()}>{busy ? "Guardando…" : "Aceptar"}</button></div>
    </section>
  );
}
