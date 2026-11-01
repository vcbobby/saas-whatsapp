"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { postJson } from "@/lib/client";

export type PaymentState = "sin_pago" | "por_verificar" | "pagado";

const LABEL: Record<PaymentState, string> = { sin_pago: "Sin pagar", por_verificar: "Pago por verificar", pagado: "Pagado" };
const METHODS = ["Pago móvil", "Transferencia", "Efectivo", "Zelle", "Punto de venta", "Otro"];

/** Estado de pago de un pedido, comprobante enviado por el cliente y acciones para quien atiende. */
export function OrderPayment({ id, state, hasProof, method, cancelled, onChanged }: { id: string; state: PaymentState; hasProof: boolean; method: string | null; cancelled: boolean; onChanged: () => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const [proofSrc, setProofSrc] = useState<string | null>(null);
  const [proofFailed, setProofFailed] = useState<string | null>(null);
  const [pick, setPick] = useState(false);
  const [methodSel, setMethodSel] = useState(METHODS[0]!);
  const [error, setError] = useState<string | null>(null);

  async function act(action: "pagado" | "rechazar" | "reabrir") {
    setBusy(true); setError(null);
    const r = await postJson("/api/orders/payment", { id, action, ...(action === "pagado" ? { method: methodSel } : {}) });
    if (!r.ok) setError(typeof r.data.message === "string" ? r.data.message : "No se pudo completar.");
    else { setPick(false); setProofSrc(null); }
    await onChanged();
    setBusy(false);
  }

  useEffect(() => () => { if (proofSrc) URL.revokeObjectURL(proofSrc); }, [proofSrc]);
  async function openProof() {
    setBusy(true); setProofFailed(null);
    try {
      const res = await fetch(`/api/orders/proof?id=${id}`, { cache: "no-store" });
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { message?: string };
        setProofFailed(j.message ?? "No se pudo cargar el comprobante.");
      } else setProofSrc(URL.createObjectURL(await res.blob()));
    } catch { setProofFailed("No hay conexión con el servidor."); }
    setBusy(false);
  }

  return (
    <div className="mt-3 flex flex-col gap-2 border-t pt-3" style={{ borderColor: "var(--color-fog-border)" }}>
      <p className="text-[14px]">
        <span className="font-medium">{LABEL[state]}</span>
        {state === "pagado" && method ? ` · ${method}` : ""}
      </p>
      {hasProof && state === "por_verificar" && (
        <div>
          {proofSrc ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={proofSrc} alt="Comprobante enviado por el cliente" style={{ maxWidth: "100%", maxHeight: 420, borderRadius: 8 }} />
          ) : (
            <button type="button" className="btn btn-sm btn-ghost-light" disabled={busy} onClick={() => void openProof()}>Ver comprobante</button>
          )}
          {proofFailed && <p role="alert" className="mt-1 text-[14px]">{proofFailed}</p>}
        </div>
      )}
      {!cancelled && (
        <div className="flex flex-wrap items-center gap-2">
          {state !== "pagado" && !pick && <button type="button" className="btn btn-sm btn-primary" disabled={busy} onClick={() => setPick(true)}>Marcar como pagado</button>}
          {state !== "pagado" && pick && (
            <span className="flex flex-wrap items-center gap-2" role="group" aria-label="Confirmar pago">
              <label className="sr-only" htmlFor={`m-${id}`}>Forma de pago</label>
              <select id={`m-${id}`} className="input" style={{ width: 180 }} value={methodSel} onChange={(e) => setMethodSel(e.target.value)}>
                {METHODS.map((m) => <option key={m}>{m}</option>)}
              </select>
              <button type="button" className="btn btn-sm btn-primary" disabled={busy} onClick={() => void act("pagado")}>Confirmar pago</button>
              <button type="button" className="btn btn-sm btn-ghost-light" onClick={() => setPick(false)}>Cancelar</button>
              <span className="muted w-full text-[13px]">¿Quieres que el cliente reciba un aviso al pagar? Activa la receta «Avisar que recibimos el pago» en <Link href="/automatizaciones" className="link">Automatizaciones</Link>.</span>
            </span>
          )}
          {state === "por_verificar" && <button type="button" className="btn btn-sm btn-ghost-light" disabled={busy} onClick={() => void act("rechazar")}>No es un pago válido</button>}
          {state === "pagado" && <button type="button" className="btn btn-sm btn-text" style={{ textDecoration: "underline" }} disabled={busy} onClick={() => void act("reabrir")}>Marcado por error</button>}
        </div>
      )}
      {error && <p role="alert" className="text-[14px]">{error}</p>}
    </div>
  );
}
