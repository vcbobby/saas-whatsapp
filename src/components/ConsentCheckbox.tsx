"use client";

import Link from "next/link";

/** Casilla «Acepto…» de los formularios de registro. Los enlaces abren en otra pestaña para no perder lo que ya escribiste. */
export function ConsentCheckbox({ id, checked, onChange, invalid }: { id: string; checked: boolean; onChange: (v: boolean) => void; invalid?: boolean }) {
  return (
    <div className="flex items-start gap-3">
      <input id={id} type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} aria-invalid={invalid || undefined} required style={{ marginTop: 4, width: 18, height: 18, flex: "none" }} />
      <label htmlFor={id} className="text-[15px]" style={{ lineHeight: 1.5 }}>
        He leído y acepto los{" "}
        <Link href="/legal/terminos" target="_blank" rel="noopener" className="link">términos y condiciones</Link>,{" "}
        la <Link href="/legal/privacidad" target="_blank" rel="noopener" className="link">política de privacidad</Link> y la{" "}
        <Link href="/legal/uso-aceptable" target="_blank" rel="noopener" className="link">política de uso aceptable</Link>.
      </label>
    </div>
  );
}
