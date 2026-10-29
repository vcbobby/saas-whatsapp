"use client";

import { useId, useRef, useState } from "react";
import { postJson } from "@/lib/client";

type Action = "crear" | "actualizar" | "sin_cambios" | "error";
interface PreviewRow { line: number; name: string; action: Action; errors: string[]; changes: string[] }
interface Preview { counts: Record<Action, number> & { total: number }; rows: PreviewRow[]; truncated: boolean; ignoredColumns: string[] }
interface Applied { created: number; updated: number; unchanged: number; skipped: { line: number; name: string; errors: string[] }[] }

const ACTION: Record<Action, { label: string; cls: string }> = {
  crear: { label: "Se creará", cls: "badge" },
  actualizar: { label: "Se actualizará", cls: "badge" },
  sin_cambios: { label: "Sin cambios", cls: "badge" },
  error: { label: "Con error", cls: "alert-error" },
};

export function DataTransfer({ agenda, catalogo }: { agenda: boolean; catalogo: boolean }) {
  const uid = useId();
  const fileRef = useRef<HTMLInputElement>(null);
  const [format, setFormat] = useState<"excel" | "csv">("excel");
  const [desde, setDesde] = useState("");
  const [hasta, setHasta] = useState("");
  const [csv, setCsv] = useState<string | null>(null);
  const [fileName, setFileName] = useState("");
  const [preview, setPreview] = useState<Preview | null>(null);
  const [applied, setApplied] = useState<Applied | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const dl = (que: string, range = false) => {
    const p = new URLSearchParams({ que, formato: format });
    if (range && desde) p.set("desde", desde);
    if (range && hasta) p.set("hasta", hasta);
    return `/api/export?${p.toString()}`;
  };

  async function onFile(f: File | undefined) {
    setPreview(null); setApplied(null); setMsg(null); setCsv(null);
    if (!f) return;
    setFileName(f.name);
    if (/\.xlsx?$/i.test(f.name)) return setMsg({ ok: false, text: "Ese es un archivo de Excel. En Excel elige Archivo → Guardar como → «CSV (delimitado por comas)» y sube el archivo .csv." });
    if (f.size > 1_000_000) return setMsg({ ok: false, text: "El archivo es demasiado grande (máximo 1 MB, unas 2.000 filas)." });
    const text = await f.text();
    setCsv(text);
    setBusy(true);
    const r = await postJson<Preview>("/api/import/productos", { csv: text, aplicar: false });
    setBusy(false);
    if (!r.ok) return setMsg({ ok: false, text: r.data.message ?? "No se pudo leer el archivo." });
    setPreview(r.data);
  }

  async function apply() {
    if (!csv) return;
    setBusy(true); setMsg(null);
    const r = await postJson<Applied>("/api/import/productos", { csv, aplicar: true });
    setBusy(false);
    if (!r.ok) return setMsg({ ok: false, text: r.data.message ?? "No se pudo importar." });
    setApplied(r.data); setPreview(null); setCsv(null);
    if (fileRef.current) fileRef.current.value = "";
  }

  const n = preview?.counts;
  const canApply = !!n && n.crear + n.actualizar > 0;

  return (
    <div className="grid gap-10" style={{ maxWidth: 860 }}>
      <div role="status" aria-live="polite">{msg && <p className={msg.ok ? "alert-ok" : "alert-error"}>{msg.text}</p>}</div>

      <section className="card-light" aria-labelledby={`${uid}-i`}>
        <h2 id={`${uid}-i`} className="text-[24px]">Importar productos</h2>
        {!catalogo ? <p className="muted mt-2">Tu plan no incluye el catálogo.</p> : (
          <>
            <ol className="muted mt-2 list-decimal pl-5">
              <li>Descarga la plantilla: <a className="link" href="/api/import/plantilla">plantilla para Excel</a> · <a className="link" href="/api/import/plantilla?formato=csv">plantilla CSV</a>. Para empezar con lo que ya tienes, descarga tus productos abajo.</li>
              <li>Llénala en Excel (una fila por producto). Obligatorios: <strong>Nombre</strong> y <strong>Precio</strong> (10 o 10,50). Stock vacío = sin control de inventario.</li>
              <li>Guárdala como <strong>CSV</strong> y súbela aquí. Verás qué pasará con cada fila <strong>antes</strong> de cambiar nada.</li>
            </ol>
            <p className="hint mt-2">Si un producto con ese nombre ya existe, se <strong>actualiza</strong> (solo con las columnas que llenes; una celda vacía no borra nada). Los productos nunca se borran con una importación.</p>
            <div className="field mt-4">
              <label htmlFor={`${uid}-f`}>Archivo CSV</label>
              <input id={`${uid}-f`} ref={fileRef} type="file" accept=".csv,.txt,text/csv" className="input" onChange={(e) => void onFile(e.target.files?.[0])} />
            </div>
            {busy && !preview && <p className="muted mt-3" role="status">Leyendo el archivo…</p>}

            {preview && n && (
              <div className="mt-5">
                <h3 className="text-[18px]">Vista previa de «{fileName}»</h3>
                <p className="mt-2">
                  <strong>{n.crear}</strong> nuevos · <strong>{n.actualizar}</strong> a actualizar · <strong>{n.sin_cambios}</strong> sin cambios · <strong className={n.error ? "text-red-700" : ""}>{n.error}</strong> con error (de {n.total} filas)
                </p>
                {preview.ignoredColumns.length > 0 && <p className="hint mt-1">Columnas que no se usan: {preview.ignoredColumns.join(", ")}.</p>}
                <ul className="mt-3 grid gap-2">
                  {preview.rows.map((r) => (
                    <li key={r.line} className="flex flex-wrap items-baseline gap-2 text-[15px]">
                      <span className="muted w-16 shrink-0">Fila {r.line}</span>
                      <strong>{r.name || "(sin nombre)"}</strong>
                      <span className={ACTION[r.action].cls}>{ACTION[r.action].label}</span>
                      {r.changes.length > 0 && <span className="muted">cambia: {r.changes.join(", ")}</span>}
                      {r.errors.map((e) => <span key={e} className="text-red-700">{e}</span>)}
                    </li>
                  ))}
                </ul>
                {preview.truncated && <p className="hint mt-2">Se muestran solo las primeras 300 filas (primero las que tienen error).</p>}
                {n.error > 0 && <p className="alert-warn mt-3">Las filas con error se <strong>omitirán</strong>; las demás sí se importan. Puedes corregir el archivo y subirlo de nuevo.</p>}
                <div className="mt-4 flex flex-wrap gap-3">
                  <button className="btn btn-primary" disabled={!canApply || busy} onClick={() => void apply()}>{busy ? "Importando…" : `Importar ${n.crear + n.actualizar} producto${n.crear + n.actualizar === 1 ? "" : "s"}`}</button>
                  <button className="btn btn-ghost-light" onClick={() => { setPreview(null); setCsv(null); if (fileRef.current) fileRef.current.value = ""; }}>Cancelar</button>
                </div>
              </div>
            )}

            {applied && (
              <div className="alert-ok mt-5">
                <p><strong>Listo.</strong> {applied.created} creados, {applied.updated} actualizados, {applied.unchanged} sin cambios{applied.skipped.length ? `, ${applied.skipped.length} omitidos` : ""}.</p>
                {applied.skipped.length > 0 && (
                  <ul className="mt-2">{applied.skipped.map((s) => <li key={s.line}>Fila {s.line} ({s.name || "sin nombre"}): {s.errors.join(" ")}</li>)}</ul>
                )}
              </div>
            )}
          </>
        )}
      </section>

      <section className="card-light" aria-labelledby={`${uid}-e`}>
        <h2 id={`${uid}-e`} className="text-[24px]">Exportar</h2>
        <p className="muted mt-2">Descarga tus datos en un archivo que abre Excel o Google Sheets. Cada descarga queda anotada en el registro de actividad.</p>
        <fieldset className="mt-4">
          <legend className="font-medium">Formato</legend>
          <label className="mr-5 inline-flex items-center gap-2"><input type="radio" name={`${uid}-fmt`} checked={format === "excel"} onChange={() => setFormat("excel")} /> Excel en español (punto y coma)</label>
          <label className="inline-flex items-center gap-2"><input type="radio" name={`${uid}-fmt`} checked={format === "csv"} onChange={() => setFormat("csv")} /> CSV estándar (coma)</label>
          <p className="hint mt-1">Si al abrirlo en Excel todo queda en una sola columna, descarga el otro formato.</p>
        </fieldset>
        <div className="mt-4 flex flex-wrap items-end gap-3">
          <div className="field"><label htmlFor={`${uid}-d`}>Desde (pedidos y citas)</label><input id={`${uid}-d`} type="date" className="input" value={desde} onChange={(e) => setDesde(e.target.value)} /></div>
          <div className="field"><label htmlFor={`${uid}-h`}>Hasta</label><input id={`${uid}-h`} type="date" className="input" value={hasta} onChange={(e) => setHasta(e.target.value)} /></div>
        </div>
        <ul className="mt-5 flex flex-wrap gap-3">
          <li><a className="btn btn-sm btn-ghost-light" href={dl("clientes")}>Clientes</a></li>
          {catalogo && <li><a className="btn btn-sm btn-ghost-light" href={dl("pedidos", true)}>Pedidos</a></li>}
          {agenda && <li><a className="btn btn-sm btn-ghost-light" href={dl("citas", true)}>Citas</a></li>}
          {catalogo && <li><a className="btn btn-sm btn-ghost-light" href={dl("productos")}>Productos</a></li>}
        </ul>
        {catalogo && <p className="hint mt-3">El inventario (existencias y movimientos) se descarga desde <a className="link" href="/catalogo/inventario">Catálogo → Inventario</a>.</p>}
      </section>
    </div>
  );
}
