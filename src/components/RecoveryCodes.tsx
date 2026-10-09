"use client";

import { useState } from "react";

/** Muestra los códigos de recuperación UNA vez, con copiar y descargar. */
export function RecoveryCodes({ codes, onDone }: { codes: string[]; onDone: () => void }) {
  const [saved, setSaved] = useState(false);
  const [copied, setCopied] = useState(false);
  const text = codes.join("\n");

  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }

  function download() {
    const url = URL.createObjectURL(new Blob([text + "\n"], { type: "text/plain" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = "codigos-de-recuperacion.txt";
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="flex flex-col gap-5">
      <p className="alert-warn" role="status">
        Guarda estos códigos ahora. No volverán a mostrarse. Cada uno sirve una sola vez si pierdes tu teléfono.
      </p>
      <ul className="grid grid-cols-1 gap-2 sm:grid-cols-2" aria-label="Códigos de recuperación">
        {codes.map((c) => (
          <li key={c} className="input" style={{ fontFamily: "ui-monospace, monospace", letterSpacing: "0.06em" }}>
            {c}
          </li>
        ))}
      </ul>
      <div className="flex flex-wrap gap-3">
        <button type="button" className="btn btn-ghost-light btn-sm" onClick={copy}>
          {copied ? "Copiados" : "Copiar"}
        </button>
        <button type="button" className="btn btn-ghost-light btn-sm" onClick={download}>
          Descargar .txt
        </button>
      </div>
      <label className="flex items-start gap-3 text-sm">
        <input type="checkbox" checked={saved} onChange={(e) => setSaved(e.target.checked)} className="mt-1" />
        <span>Ya guardé mis códigos en un lugar seguro.</span>
      </label>
      <button type="button" className="btn btn-primary" disabled={!saved} onClick={onDone}>
        Listo
      </button>
    </div>
  );
}
