"use client";

import { useEffect, useRef, useState } from "react";

export interface ChartSeries { name: string; color: string; values: number[]; kind: "bar" | "line" }

const H = 200, PL = 34, PR = 8, PT = 10, PB = 26;

/** Tope «redondo» del eje (1, 2, 5, 10, 20, 50…) y marcas enteras. */
export function niceMax(max: number): number {
  if (max <= 4) return 4;
  const p = 10 ** Math.floor(Math.log10(max));
  for (const m of [1, 2, 5, 10]) if (m * p >= max) return m * p;
  return 10 * p;
}

export function shortDay(ymd: string): string {
  const [, m, d] = ymd.split("-");
  return `${Number(d)}/${Number(m)}`;
}
function longDay(ymd: string): string {
  const [y, m, d] = ymd.split("-").map(Number);
  return new Intl.DateTimeFormat("es", { timeZone: "UTC", weekday: "short", day: "numeric", month: "short" }).format(new Date(Date.UTC(y!, m! - 1, d!)));
}

/** Gráfico por día: barras y/o línea, con leyenda, ayuda al pasar el cursor y vista de tabla (no depende solo del color). */
export function DayChart({ title, days, series }: { title: string; days: string[]; series: ChartSeries[] }) {
  const [hover, setHover] = useState<number | null>(null);
  const [table, setTable] = useState(false);
  const [W, setW] = useState(640);
  const box = useRef<HTMLDivElement>(null);
  // El dibujo usa el ancho real de la tarjeta: así los textos se ven del mismo tamaño en el teléfono y en el computador.
  useEffect(() => {
    const el = box.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(([e]) => { const w = Math.round(e?.contentRect.width ?? 0); if (w >= 200) setW(w); });
    ro.observe(el);
    return () => ro.disconnect();
  }, [table]);
  const n = days.length;
  const top = niceMax(Math.max(0, ...series.flatMap((s) => s.values)));
  const plotW = W - PL - PR, plotH = H - PT - PB;
  const slot = plotW / n;
  const cx = (i: number) => PL + slot * i + slot / 2;
  const y = (v: number) => PT + plotH - (v / top) * plotH;
  const ticks = [0, top / 2, top];
  const total = series.reduce((s, x) => s + x.values.reduce((a, b) => a + b, 0), 0);
  const label = `${title}. ${series.map((s) => `${s.name}: ${s.values.reduce((a, b) => a + b, 0)} en total`).join("; ")}.`;

  return (
    <figure className="card-dark" style={{ margin: 0, minWidth: 0 }}>
      <figcaption className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-[15px] font-medium">{title}</span>
        <span className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[13px] muted-dark">
          {series.map((s) => (
            <span key={s.name} className="inline-flex items-center gap-2">
              <span aria-hidden="true" style={{ width: 10, height: s.kind === "bar" ? 10 : 3, borderRadius: s.kind === "bar" ? 3 : 2, background: s.color, display: "inline-block" }} />
              {s.name}
            </span>
          ))}
        </span>
      </figcaption>

      {table ? (
        <div className="mt-3" style={{ maxHeight: 260, overflow: "auto" }}>
          <table className="w-full text-left text-[13px]">
            <thead>
              <tr><th className="py-1 pr-3 font-medium">Día</th>{series.map((s) => <th key={s.name} className="py-1 pr-3 font-medium">{s.name}</th>)}</tr>
            </thead>
            <tbody>
              {days.map((d, i) => (
                <tr key={d} style={{ borderTop: "1px solid rgba(255,255,255,0.08)" }}>
                  <td className="py-1 pr-3">{longDay(d)}</td>
                  {series.map((s) => <td key={s.name} className="py-1 pr-3">{s.values[i]}</td>)}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div ref={box} className="mt-3" style={{ position: "relative" }}>
          <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={label} width={W} height={H} style={{ width: "100%", height: "auto", display: "block" }} onPointerLeave={() => setHover(null)}>
            {ticks.map((t) => (
              <g key={t}>
                <line x1={PL} x2={W - PR} y1={y(t)} y2={y(t)} stroke="rgba(255,255,255,0.12)" strokeWidth={1} />
                <text x={PL - 6} y={y(t) + 4} textAnchor="end" fontSize={11} fill="rgba(255,255,255,0.7)">{Number.isInteger(t) ? t : ""}</text>
              </g>
            ))}
            {days.map((d, i) => ((W < 480 ? i % 3 === (n - 1) % 3 : i % 2 === (n - 1) % 2) ? <text key={d} x={cx(i)} y={H - 8} textAnchor="middle" fontSize={11} fill="rgba(255,255,255,0.7)">{shortDay(d)}</text> : null))}
            {series.filter((s) => s.kind === "bar").map((s) =>
              s.values.map((v, i) => {
                const bw = Math.min(slot * 0.6, 26);
                const h = Math.max(0, y(0) - y(v));
                return v > 0 ? <path key={i} d={`M${cx(i) - bw / 2},${y(0)} v${-Math.max(h - 4, 0)} a4,4 0 0 1 4,-4 h${bw - 8} a4,4 0 0 1 4,4 v${Math.max(h - 4, 0)} z`} fill={s.color} opacity={hover === null || hover === i ? 1 : 0.55} /> : null;
              }),
            )}
            {series.filter((s) => s.kind === "line").map((s) => (
              <g key={s.name}>
                <polyline fill="none" stroke={s.color} strokeWidth={2} strokeLinejoin="round" points={s.values.map((v, i) => `${cx(i)},${y(v)}`).join(" ")} />
                {s.values.map((v, i) => <circle key={i} cx={cx(i)} cy={y(v)} r={hover === i ? 5 : 4} fill={s.color} stroke="#0e1a19" strokeWidth={2} />)}
              </g>
            ))}
            {hover !== null && <line x1={cx(hover)} x2={cx(hover)} y1={PT} y2={PT + plotH} stroke="rgba(255,255,255,0.35)" strokeWidth={1} strokeDasharray="3 3" />}
            {days.map((d, i) => <rect key={d} data-hit="1" x={PL + slot * i} y={PT} width={slot} height={plotH + PB} fill="transparent" onPointerEnter={() => setHover(i)} onPointerMove={() => setHover(i)} />)}
          </svg>
          {total === 0 && <p className="muted-dark text-[13px]" style={{ position: "absolute", left: 0, right: 0, top: "38%", textAlign: "center" }}>Todavía no hay datos en estos días.</p>}
          {hover !== null && (
            <div role="status" style={{ position: "absolute", top: 0, left: `${Math.min(88, Math.max(12, (cx(hover) / W) * 100))}%`, transform: "translateX(-50%)", background: "#070f0f", border: "1px solid rgba(255,255,255,0.2)", borderRadius: 10, padding: "6px 10px", fontSize: 13, pointerEvents: "none", whiteSpace: "nowrap", zIndex: 2 }}>
              <strong style={{ fontWeight: 500 }}>{longDay(days[hover]!)}</strong>
              {series.map((s) => <div key={s.name}>{s.name}: {s.values[hover]}</div>)}
            </div>
          )}
        </div>
      )}
      <button type="button" className="link mt-2 text-[13px]" style={{ background: "none", border: 0, padding: 0, cursor: "pointer", textDecoration: "underline" }} onClick={() => setTable((t) => !t)} aria-pressed={table}>
        {table ? "Ver gráfico" : "Ver como tabla"}
      </button>
    </figure>
  );
}
