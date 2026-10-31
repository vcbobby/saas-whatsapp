"use client";

import { useState } from "react";
import { formatMoney, type Currency } from "@/lib/catalog/money";
import { orderText, waLink } from "@/lib/storefront/pure";

interface P { id: string; name: string; description: string | null; unit: string | null; priceMinor: number; soldOut: boolean }

export function StoreCart({ business, phone, currency, products }: { business: string; phone: string; currency: Currency; products: P[] }) {
  const [qty, setQty] = useState<Record<string, number>>({});
  const set = (id: string, n: number) => setQty((q) => ({ ...q, [id]: Math.max(0, Math.min(99, n)) }));
  const lines = products.map((p) => ({ name: p.name, unitMinor: p.priceMinor, qty: qty[p.id] ?? 0 }));
  const count = lines.reduce((s, l) => s + l.qty, 0);
  const total = lines.reduce((s, l) => s + l.qty * l.unitMinor, 0);

  return (
    <div>
      {products.length === 0 ? <p className="muted-dark">Pronto habrá productos aquí.</p> : (
        <ul className="grid gap-4 sm:grid-cols-2">
          {products.map((p) => {
            const n = qty[p.id] ?? 0;
            return (
              <li key={p.id} className="card flex flex-col gap-2 p-4">
                <p className="text-[17px] font-medium">{p.name}</p>
                {p.description && <p className="muted-dark text-[14px]">{p.description}</p>}
                <p className="text-[16px]">{formatMoney(p.priceMinor, currency)}{p.unit ? <span className="muted-dark text-[14px]"> / {p.unit}</span> : null}</p>
                {p.soldOut ? <p className="text-[14px] muted-dark">Agotado</p> : (
                  <div className="mt-auto flex items-center gap-3">
                    <button type="button" className="btn btn-sm btn-ghost-light" aria-label={`Quitar uno de ${p.name}`} disabled={n === 0} onClick={() => set(p.id, n - 1)}>−</button>
                    <span aria-live="polite" className="min-w-6 text-center">{n}</span>
                    <button type="button" className="btn btn-sm btn-ghost-light" aria-label={`Agregar uno de ${p.name}`} onClick={() => set(p.id, n + 1)}>+</button>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
      <div className="sticky bottom-0 mt-8 flex flex-wrap items-center justify-between gap-3 border-t py-4" style={{ background: "var(--color-bg, inherit)" }}>
        <p className="text-[15px]">{count === 0 ? "Elige lo que quieras y pídelo por WhatsApp." : `${count} ${count === 1 ? "producto" : "productos"} · ${formatMoney(total, currency)}`}</p>
        <a className="btn btn-primary" href={waLink(phone, orderText(business, lines, currency))} target="_blank" rel="noopener noreferrer">
          {count === 0 ? "Escribir por WhatsApp" : "Pedir por WhatsApp"}
        </a>
      </div>
    </div>
  );
}
