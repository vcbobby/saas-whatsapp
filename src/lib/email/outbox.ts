import { getPool } from "@/lib/db";
import { getEnv } from "@/lib/env";
import { getEmailProvider, type EmailProvider } from "./provider";
import { emailTemplates, type Rendered } from "./templates";

/** Segundos de espera tras el intento n. Total: 6 intentos en unas 8 horas. */
export const EMAIL_BACKOFF = [60, 300, 1_800, 7_200, 21_600] as const;
export const EMAIL_MAX_ATTEMPTS = EMAIL_BACKOFF.length + 1;
const LOCK_SECONDS = 90;

/** Dirección absoluta dentro de la app, SIEMPRE con el dominio configurado (nunca el de la petición). */
export const appLink = (path: string) => `${new URL(getEnv().APP_URL).origin}${path}`;

/** Pone un correo en la cola de salida. Nunca lanza: si falla, la acción que lo pidió (registrarse, invitar…) sigue. Devuelve si quedó en cola. */
export async function enqueueEmail(to: string, msg: Rendered, opts: { tenantId?: string | null; dedupeKey?: string | null } = {}): Promise<boolean> {
  try {
    const r = await getPool().query<{ id: string | null }>("SELECT email_enqueue($1, $2, $3, $4, $5, $6, $7) AS id", [opts.tenantId ?? null, to, msg.template, msg.subject, msg.text, msg.html, opts.dedupeKey ?? null]);
    return r.rows[0]?.id != null;
  } catch (err) {
    console.error("[correo] no se pudo poner en cola:", err instanceof Error ? err.message : err);
    return false;
  }
}

export interface SendDeps { provider?: EmailProvider }
export type EmailOutcome = "sent" | "retry" | "failed";

/** Toma hasta `max` correos vencidos y los envía. Devuelve cuántos hubo de cada resultado. */
export async function sendDueEmails(max = 5, deps: SendDeps = {}): Promise<Record<EmailOutcome, number>> {
  const provider = deps.provider ?? getEmailProvider();
  const pool = getPool();
  const claimed = await pool.query<{ out_id: string; out_to: string; out_subject: string; out_text: string | null; out_html: string | null; out_attempts: number }>("SELECT * FROM email_claim($1, $2)", [max, LOCK_SECONDS]);
  const counts: Record<EmailOutcome, number> = { sent: 0, retry: 0, failed: 0 };
  for (const e of claimed.rows) {
    let outcome: Awaited<ReturnType<EmailProvider["send"]>>;
    try {
      outcome = !e.out_text || !e.out_html
        ? { ok: false, retry: false, error: "El correo ya no tiene contenido" }
        : await provider.send({ to: e.out_to, subject: e.out_subject, text: e.out_text, html: e.out_html });
    } catch (err) {
      outcome = { ok: false, retry: true, error: err instanceof Error ? err.message.slice(0, 200) : "error inesperado" };
    }
    if (outcome.ok) {
      await pool.query("SELECT email_mark($1, true, NULL, $2, $3, NULL, $4)", [e.out_id, provider.name, outcome.id, provider.purgeAfterSend]);
      counts.sent++;
    } else if (outcome.retry && e.out_attempts < EMAIL_MAX_ATTEMPTS) {
      await pool.query("SELECT email_mark($1, false, $2, $3, NULL, $4, false)", [e.out_id, outcome.error, provider.name, EMAIL_BACKOFF[e.out_attempts - 1]]);
      counts.retry++;
    } else {
      await pool.query("SELECT email_mark($1, false, $2, $3, NULL, NULL, true)", [e.out_id, outcome.error, provider.name]);
      counts.failed++;
    }
  }
  return counts;
}

interface Candidate { out_kind: string; out_key: string; out_tenant: string; out_tenant_name: string; out_to: string; out_info: Record<string, unknown> }

/** Revisa quién debe recibir un aviso de plan o de cobro y lo encola (una sola vez por aviso gracias a la clave). Devuelve cuántos encoló. */
export async function queuePlanNotices(opts: { tenantId?: string } = {}): Promise<number> {
  const rows = (await getPool().query<Candidate>("SELECT * FROM email_notice_candidates($1)", [opts.tenantId ?? null])).rows;
  let n = 0;
  for (const c of rows) {
    const plan = appLink("/plan");
    const business = c.out_tenant_name;
    const i = c.out_info;
    const msg =
      c.out_kind === "trial_ending" ? emailTemplates.trialEnding({ business, endsAt: i.ends_at, url: plan })
      : c.out_kind === "trial_ended" ? emailTemplates.trialEnded({ business, url: plan })
      : c.out_kind === "plan_expiring" ? emailTemplates.planExpiring({ business, endsAt: i.ends_at, url: plan })
      : c.out_kind === "plan_expired" ? emailTemplates.planExpired({ business, url: plan })
      : c.out_kind === "payment_confirmed" ? emailTemplates.paymentConfirmed({ business, plan: String(i.plan ?? ""), months: i.months, url: appLink("/panel") })
      : c.out_kind === "payment_rejected" ? emailTemplates.paymentRejected({ business, reason: (i.reason as string | null) ?? null, url: plan })
      : null;
    if (msg && (await enqueueEmail(c.out_to, msg, { tenantId: c.out_tenant, dedupeKey: c.out_key }))) n++;
  }
  return n;
}
