import { DayChart } from "@/components/DayChart";
import { adoptionPct, formatTokens, healthItems, safetyItems, type AdminUsage } from "@/lib/admin/usage";
import { TENANT_STATUS_LABEL } from "@/lib/admin/overview";

function Tile({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <div className="card-dark" style={{ minWidth: 0 }}>
      <p className="muted-dark text-[13px]">{label}</p>
      <p className="mt-1 text-[30px] font-semibold leading-none">{value}</p>
      {note && <p className="muted-dark mt-2 text-[13px]">{note}</p>}
    </div>
  );
}

export function AdminUsageView({ u }: { u: AdminUsage }) {
  const t = u.totals30;
  const health = healthItems(u.health7);
  const safety = safetyItems(u.health7);
  const days = u.daily.map((d) => d.day);
  const bad = health.filter((h) => h.level === "warn").length;
  return (
    <div className="mt-8 grid gap-6">
      <section className="card-dark" aria-label="Salud" style={{ minWidth: 0 }}>
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <p className="eyebrow eyebrow--dark">Salud · últimos 7 días</p>
          <p className="text-[13px]" style={{ color: bad ? "var(--color-signal-yellow)" : "var(--color-neon-pulse)" }}>{bad ? `${bad} ${bad === 1 ? "cosa por revisar" : "cosas por revisar"}` : "Todo en orden"}</p>
        </div>
        <ul className="mt-4 grid gap-3" style={{ listStyle: "none", padding: 0 }}>
          {health.map((h) => (
            <li key={h.key} className="flex items-start gap-3">
              <span aria-hidden="true" style={{ flex: "none", width: 22, height: 22, borderRadius: 22, display: "inline-flex", alignItems: "center", justifyContent: "center", fontSize: 13, background: h.level === "ok" ? "var(--color-neon-pulse)" : "var(--color-signal-yellow)", color: "#070f0f" }}>{h.level === "ok" ? "✓" : "!"}</span>
              <span>
                <strong style={{ fontWeight: 500 }}>{h.n.toLocaleString("es")}</strong> {h.label}
                <span className="sr-only">{h.level === "ok" ? " (sin problemas)" : " (requiere revisión)"}</span>
                {h.level === "warn" && <span className="muted-dark block text-[13px]">{h.hint}</span>}
              </span>
            </li>
          ))}
        </ul>
        <p className="eyebrow eyebrow--dark mt-6">Frenos de seguridad del asistente</p>
        <ul className="mt-3 flex flex-wrap gap-3" style={{ listStyle: "none", padding: 0 }}>
          {safety.map((s) => <li key={s.key} className="badge badge-neutral" style={{ whiteSpace: "normal" }}><strong>{s.n.toLocaleString("es")}</strong>&nbsp;{s.label}</li>)}
        </ul>
      </section>

      <section aria-label="Uso" className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Tile label="Negocios con actividad (30 días)" value={t.activeTenants.toLocaleString("es")} note={`de ${t.liveTenants.toLocaleString("es")} en prueba o con plan activo`} />
        <Tile label="Mensajes recibidos (30 días)" value={t.messagesIn.toLocaleString("es")} note={`${t.messagesOut.toLocaleString("es")} enviados`} />
        <Tile label="Respuestas del asistente (30 días)" value={t.agentReplies.toLocaleString("es")} note={`${t.copilotQuestions.toLocaleString("es")} preguntas al copiloto`} />
        <Tile label="Tokens de IA (30 días)" value={formatTokens(t.agentTokens + t.copilotTokens)} note={`Asistente ${formatTokens(t.agentTokens)} · Copiloto ${formatTokens(t.copilotTokens)}`} />
      </section>

      <div className="grid gap-6 lg:grid-cols-2">
        <DayChart title="Mensajes recibidos y respuestas del asistente" days={days} series={[
          { name: "Mensajes recibidos", color: "#6ea8ff", kind: "line", values: u.daily.map((d) => d.messagesIn) },
          { name: "Respuestas del asistente", color: "#3ddc91", kind: "bar", values: u.daily.map((d) => d.replies) },
        ]} />
        <DayChart title="Fallos de la IA por día" days={days} series={[{ name: "Fallos", color: "#3ddc91", kind: "bar", values: u.daily.map((d) => d.errors) }]} />
      </div>

      <section className="card-dark" aria-label="Módulos usados" style={{ minWidth: 0 }}>
        <p className="eyebrow eyebrow--dark">Módulos usados por los negocios</p>
        <ul className="mt-4 grid gap-3" style={{ listStyle: "none", padding: 0 }}>
          {u.modules.map((m) => {
            const pct = adoptionPct(m.tenants, t.liveTenants);
            return (
              <li key={m.key}>
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <span>{m.label}</span>
                  <span className="muted-dark text-[13px]">{m.tenants.toLocaleString("es")} {m.tenants === 1 ? "negocio" : "negocios"} · {pct} %</span>
                </div>
                <div role="progressbar" aria-label={m.label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct} className="mt-1" style={{ height: 8, borderRadius: 8, background: "rgba(255,255,255,0.15)" }}>
                  <div style={{ width: `${pct}%`, height: 8, borderRadius: 8, background: "var(--color-neon-pulse)" }} />
                </div>
              </li>
            );
          })}
        </ul>
      </section>

      <section className="card-dark" aria-label="Consumo de IA por negocio" style={{ minWidth: 0 }}>
        <p className="eyebrow eyebrow--dark">Quién más IA consume (30 días)</p>
        {u.top.length === 0 ? <p className="muted-dark mt-2">Todavía no hay consumo de IA.</p> : (
          <div className="mt-3" style={{ overflowX: "auto" }}>
            <table className="w-full text-left text-[14px]">
              <thead><tr><th className="py-1 pr-4 font-medium">Negocio</th><th className="py-1 pr-4 font-medium">Respuestas</th><th className="py-1 pr-4 font-medium">Preguntas copiloto</th><th className="py-1 pr-4 font-medium">Tokens</th><th className="py-1 font-medium">Fallos</th></tr></thead>
              <tbody>
                {u.top.map((r, i) => (
                  <tr key={r.name + i} style={{ borderTop: "1px solid rgba(255,255,255,0.08)" }}>
                    <td className="py-2 pr-4">{r.name} <span className="badge badge-neutral">{TENANT_STATUS_LABEL[r.status] ?? r.status}</span></td>
                    <td className="py-2 pr-4">{r.replies.toLocaleString("es")}</td>
                    <td className="py-2 pr-4">{r.questions.toLocaleString("es")}</td>
                    <td className="py-2 pr-4">{formatTokens(r.tokens)}</td>
                    <td className="py-2">{r.errors.toLocaleString("es")}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="muted-dark mt-4 text-[13px]">Los tokens solo se cuentan cuando la respuesta se envía; un intento que falla después de llamar a la IA todavía no suma (se corrige en la protección de costos).</p>
      </section>
    </div>
  );
}
