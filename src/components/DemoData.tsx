"use client";

import { useEffect, useState } from "react";
import { postJson } from "@/lib/client";

interface State { present: boolean; contacts: number; products: number; services: number; orders: number }

export function DemoData() {
  const [s, setS] = useState<State | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [confirm, setConfirm] = useState(false);

  async function refresh() {
    try {
      const res = await fetch("/api/demo", { cache: "no-store" });
      if (res.ok) setS((await res.json()) as State);
    } catch { /* se queda como estaba */ }
  }
  useEffect(() => { const t = setTimeout(() => void refresh(), 0); return () => clearTimeout(t); }, []);

  async function run(action: "load" | "clear") {
    setBusy(true); setMsg(null); setConfirm(false);
    const r = await postJson("/api/demo", { action });
    setBusy(false);
    if (r.ok) { setMsg({ ok: true, text: action === "load" ? "Listo: ya puedes recorrer el panel con datos de ejemplo." : "Datos de ejemplo borrados." }); await refresh(); }
    else setMsg({ ok: false, text: "No se pudo completar. Intenta de nuevo." });
  }

  return (
    <section className="card p-5" aria-labelledby="demo-h">
      <h2 id="demo-h" className="text-[20px]">Datos de ejemplo</h2>
      <p className="muted-dark mt-1 max-w-[620px] text-[14px]">
        Para ver cómo se ve todo con movimiento: 4 clientes con sus conversaciones, 3 productos, pedidos y citas. Se marcan «(ejemplo)», usan números inventados y no reciben avisos. Los puedes borrar cuando quieras sin tocar tus datos reales.
      </p>
      {s && (
        <div className="mt-4 flex flex-wrap items-center gap-3">
          {!s.present
            ? <button type="button" className="btn btn-primary btn-sm" disabled={busy} onClick={() => void run("load")}>{busy ? "Cargando…" : "Cargar datos de ejemplo"}</button>
            : !confirm
              ? <button type="button" className="btn btn-secondary btn-sm" disabled={busy} onClick={() => setConfirm(true)}>Borrar datos de ejemplo</button>
              : <>
                  <span className="text-[14px]">Se borrarán {s.contacts} clientes, {s.products} productos y {s.orders} pedidos de ejemplo.</span>
                  <button type="button" className="btn btn-primary btn-sm" disabled={busy} onClick={() => void run("clear")}>Sí, borrar</button>
                  <button type="button" className="btn btn-sm btn-ghost-light" onClick={() => setConfirm(false)}>Cancelar</button>
                </>}
        </div>
      )}
      {msg && <p role={msg.ok ? "status" : "alert"} className="mt-3 text-[14px]">{msg.text}</p>}
    </section>
  );
}
