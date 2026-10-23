import Link from "next/link";
import { DayChart } from "@/components/DayChart";
import { TENANT_STATUS_LABEL, type AdminOverview } from "@/lib/admin/overview";
import { pctChange } from "@/lib/dashboard/pure";

function Tile({ label, value, note, href }: { label: string; value: number; note?: string; href?: string }) {
  const body = (
    <>
      <p className="muted-dark text-[13px]">{label}</p>
      <p className="mt-1 text-[30px] font-semibold leading-none">{value.toLocaleString("es")}</p>
      {note && <p className="muted-dark mt-2 text-[13px]">{note}</p>}
    </>
  );
  return href
    ? <Link href={href} className="card-dark block" style={{ textDecoration: "none", color: "inherit", minWidth: 0 }}>{body}</Link>
    : <div className="card-dark" style={{ minWidth: 0 }}>{body}</div>;
}

export function signupsNote(s: AdminOverview["signups"]): string {
  const p = pctChange({ current: s.last7, previous: s.prev7 });
  if (p === null) return s.last7 > 0 ? "Primera semana con registros" : "Sin registros todavía";
  if (p === 0) return "= igual que la semana anterior";
  return `${p > 0 ? "▲" : "▼"} ${Math.abs(p)} % vs. semana anterior`;
}

/** Lo que pide atención del súper admin: solo lo que tiene cifra > 0. */
export function adminAttention(o: AdminOverview): { n: number; text: string; href: string }[] {
  const t = o.tenants;
  return [
    { n: o.paymentsToReview, text: o.paymentsToReview === 1 ? "pago por revisar" : "pagos por revisar", href: "/admin/cobros" },
    { n: o.supportOpen, text: o.supportOpen === 1 ? "consulta de soporte por responder" : "consultas de soporte por responder", href: "/admin/soporte" },
    { n: t.expiringSoon, text: t.expiringSoon === 1 ? "plan vence en 7 días" : "planes vencen en 7 días", href: "/admin/negocios" },
    { n: t.trialExpired, text: t.trialExpired === 1 ? "prueba vencida sin pagar" : "pruebas vencidas sin pagar", href: "/admin/negocios" },
    { n: t.pastDue, text: t.pastDue === 1 ? "negocio con pago pendiente" : "negocios con pago pendiente", href: "/admin/negocios" },
  ].filter((i) => i.n > 0);
}

export function AdminOverviewView({ o, ai }: { o: AdminOverview; ai?: { n: number; text: string; href: string } | null }) {
  const t = o.tenants;
  const attention = [...adminAttention(o), ...(ai ? [ai] : [])];
  const fmt = new Intl.DateTimeFormat("es-VE", { dateStyle: "medium", timeZone: o.tz });
  return (
    <div className="mt-8 grid gap-6">
      <section className="card-dark" aria-label="Requiere tu atención">
        <p className="eyebrow eyebrow--dark">Requiere tu atención</p>
        {attention.length === 0 ? (
          <p className="mt-2">Todo al día. No hay pagos ni vencimientos pendientes.</p>
        ) : (
          <ul className="mt-3 flex flex-wrap gap-3" style={{ listStyle: "none", padding: 0 }}>
            {attention.map((i) => (
              <li key={i.text}><Link href={i.href} className="badge" style={{ textDecoration: "none" }}><strong>{i.n}</strong>&nbsp;{i.text}</Link></li>
            ))}
          </ul>
        )}
      </section>

      <section aria-label="Negocios" className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Tile label="Registros (7 días)" value={o.signups.last7} note={signupsNote(o.signups)} />
        <Tile label="Negocios en total" value={t.total} note={`${o.users.toLocaleString("es")} ${o.users === 1 ? "persona registrada" : "personas registradas"}`} href="/admin/negocios" />
        <Tile label="En prueba" value={t.trial} note={t.trialExpired > 0 ? `${t.trialExpired} con la prueba vencida` : "Ninguna prueba vencida"} href="/admin/negocios" />
        <Tile label="Con plan activo" value={t.active} note={t.expiringSoon > 0 ? `${t.expiringSoon} vencen esta semana` : "Ninguno vence esta semana"} href="/admin/negocios" />
      </section>

      <section aria-label="Estados" className="grid gap-4 sm:grid-cols-3">
        <Tile label="Pago pendiente" value={t.pastDue} href="/admin/negocios" />
        <Tile label="Suspendidas" value={t.suspended} href="/admin/negocios" />
        <Tile label="Pagos por revisar" value={o.paymentsToReview} href="/admin/cobros" />
      </section>

      <DayChart title="Registros por día (últimas 2 semanas)" days={o.daily.map((d) => d.day)} series={[{ name: "Negocios nuevos", color: "#3ddc91", kind: "bar", values: o.daily.map((d) => d.n) }]} />

      <section className="card-dark" aria-label="Últimos registros">
        <p className="eyebrow eyebrow--dark">Últimos registros</p>
        {o.recent.length === 0 ? <p className="muted-dark mt-2">Todavía no hay negocios.</p> : (
          <ul className="mt-3 grid gap-2" style={{ listStyle: "none", padding: 0 }}>
            {o.recent.map((r) => (
              <li key={r.createdAt + r.name} className="flex flex-wrap items-center justify-between gap-2">
                <span>{r.name}</span>
                <span className="muted-dark text-[13px]">{fmt.format(new Date(r.createdAt))} · <span className="badge">{TENANT_STATUS_LABEL[r.status] ?? r.status}</span></span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
