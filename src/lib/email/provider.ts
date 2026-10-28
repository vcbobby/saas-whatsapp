import { ipv4Fetch } from "@/lib/ai/provider";
import { getEmailEnv } from "@/lib/env";

export interface OutgoingEmail { to: string; subject: string; text: string; html: string }
export type SendOutcome = { ok: true; id: string | null } | { ok: false; retry: boolean; error: string };
export interface EmailProvider {
  name: "dev" | "resend";
  /** true = tras enviarse se borra el cuerpo de la bandeja (lleva enlaces secretos). El de desarrollo conserva los cuerpos: son la bandeja visible. */
  purgeAfterSend: boolean;
  send(msg: OutgoingEmail): Promise<SendOutcome>;
}

/** Desarrollo: no envía nada. El correo queda visible en /dev/correos y en la terminal del worker. */
export const devProvider: EmailProvider = {
  name: "dev",
  purgeAfterSend: false,
  async send(msg) {
    const links = [...msg.text.matchAll(/https?:\/\/\S+/g)].map((m) => m[0]);
    console.log(`[correo:dev] Para: ${msg.to} · Asunto: ${msg.subject}${links.length ? `\n             Enlaces: ${links.join("  ")}` : ""}`);
    return { ok: true, id: null };
  },
};

/** Resend (https://resend.com): 3.000 correos/mes gratis. Requiere un dominio verificado para escribir a cualquier persona. */
export function resendProvider(cfg: { apiKey: string; from: string; replyTo?: string }, fetchImpl: typeof fetch = ipv4Fetch): EmailProvider {
  return {
    name: "resend",
    purgeAfterSend: true,
    async send(msg) {
      let res: Response;
      try {
        res = await fetchImpl("https://api.resend.com/emails", {
          method: "POST",
          headers: { authorization: `Bearer ${cfg.apiKey}`, "content-type": "application/json" },
          body: JSON.stringify({ from: cfg.from, to: [msg.to], subject: msg.subject, text: msg.text, html: msg.html, ...(cfg.replyTo ? { reply_to: cfg.replyTo } : {}) }),
          signal: AbortSignal.timeout(15_000),
          redirect: "error",
        });
      } catch {
        return { ok: false, retry: true, error: "No se pudo conectar con el proveedor de correo" };
      }
      const j = (await res.json().catch(() => null)) as { id?: unknown; message?: unknown } | null;
      if (res.status >= 200 && res.status < 300) return { ok: true, id: typeof j?.id === "string" ? j.id.slice(0, 100) : null };
      if (res.status === 429 || res.status >= 500) return { ok: false, retry: true, error: `El proveedor respondió ${res.status}` };
      if (res.status === 401 || res.status === 403) return { ok: false, retry: false, error: "La clave del proveedor de correo no es válida o no tiene permiso (revisa EMAIL_API_KEY y que el dominio esté verificado)" };
      if (res.status === 422) return { ok: false, retry: false, error: `El proveedor rechazó el correo: ${typeof j?.message === "string" ? j.message.slice(0, 160) : "datos inválidos"}` };
      return { ok: false, retry: false, error: `El proveedor respondió ${res.status}` };
    },
  };
}

export function getEmailProvider(): EmailProvider {
  const env = getEmailEnv();
  if (env.EMAIL_PROVIDER === "resend") return resendProvider({ apiKey: env.EMAIL_API_KEY!, from: env.EMAIL_FROM!, replyTo: env.EMAIL_REPLY_TO || undefined });
  return devProvider;
}
