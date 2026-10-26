// Apps a las que un negocio puede conectarse en pocos clics. Sin dependencias de servidor: lo usan la API y la pantalla.
// Debe coincidir con el CHECK de webhook_endpoints.kind (migración 0038).
export const APP_KINDS = ["telegram", "discord", "slack", "zapier", "make", "n8n", "webhook"] as const;
export type AppKind = (typeof APP_KINDS)[number];
/** Tipos cuyas credenciales se guardan cifradas (el negocio nunca las vuelve a ver completas). */
export const SEALED_KINDS = ["telegram", "discord", "slack"] as const;
export const isSealed = (k: string): k is (typeof SEALED_KINDS)[number] => (SEALED_KINDS as readonly string[]).includes(k);
/** Tipos que reciben el aviso como JSON completo (los que usan Zapier, Make, n8n o un sistema propio). */
export const isJsonKind = (k: string) => !isSealed(k);

export interface AppInfo { kind: AppKind; name: string; tagline: string; steps: string[]; placeholder: string; field: string }
export const APPS: Record<AppKind, AppInfo> = {
  telegram: {
    kind: "telegram", name: "Telegram", tagline: "Recibe los avisos en un chat o grupo de Telegram.", field: "Token del bot", placeholder: "123456789:AAE…",
    steps: [
      "En Telegram busca @BotFather y escríbele /newbot. Elige un nombre y te dará un token (un texto largo con dos puntos).",
      "Pega aquí el token.",
      "Abre tu bot en Telegram y escríbele «hola» (si quieres los avisos en un grupo, agrégalo al grupo y escribe ahí).",
      "Pulsa «Buscar mi chat»: lo detectamos solos. Elígelo y listo.",
    ],
  },
  discord: {
    kind: "discord", name: "Discord", tagline: "Recibe los avisos en un canal de tu servidor de Discord.", field: "Enlace del webhook", placeholder: "https://discord.com/api/webhooks/…",
    steps: [
      "En Discord abre el canal → ⚙ Editar canal → Integraciones → Webhooks → Nuevo webhook.",
      "Pulsa «Copiar URL del webhook».",
      "Pégala aquí y elige qué avisos quieres recibir.",
    ],
  },
  slack: {
    kind: "slack", name: "Slack", tagline: "Recibe los avisos en un canal de Slack.", field: "Enlace del webhook", placeholder: "https://hooks.slack.com/services/…",
    steps: [
      "Entra a api.slack.com/apps → Create New App → From scratch → elige tu espacio de trabajo.",
      "En «Incoming Webhooks» actívalos y pulsa «Add New Webhook to Workspace»; elige el canal.",
      "Copia la URL del webhook, pégala aquí y elige qué avisos quieres recibir.",
    ],
  },
  zapier: {
    kind: "zapier", name: "Zapier", tagline: "Conecta con miles de apps (Google Sheets, Gmail, Notion…) sin programar.", field: "Dirección del «Catch Hook»", placeholder: "https://hooks.zapier.com/hooks/catch/…",
    steps: [
      "En Zapier crea un Zap y como disparador elige «Webhooks by Zapier» → «Catch Hook».",
      "Copia la dirección («Custom Webhook URL») que te muestra y pégala aquí.",
      "Pulsa «Enviar prueba» y, en Zapier, «Test trigger»: verás los datos. Luego añade la acción que quieras (guardar en una hoja, enviar un correo…).",
    ],
  },
  make: {
    kind: "make", name: "Make", tagline: "Automatiza con Make (antes Integromat) y sus cientos de apps.", field: "Dirección del webhook", placeholder: "https://hook.us1.make.com/…",
    steps: [
      "En Make crea un escenario y añade el módulo «Webhooks» → «Custom webhook».",
      "Copia la dirección que te muestra y pégala aquí.",
      "Pulsa «Enviar prueba» y deja que Make «Determine data structure». Luego añade los módulos que quieras.",
    ],
  },
  n8n: {
    kind: "n8n", name: "n8n", tagline: "Para quien ya usa n8n (en la nube o instalado por su cuenta).", field: "Dirección del webhook (Production URL)", placeholder: "https://tu-n8n.com/webhook/…",
    steps: [
      "En n8n crea un flujo que empiece con el nodo «Webhook» (método POST).",
      "Copia la «Production URL», pégala aquí y activa el flujo en n8n.",
      "Pulsa «Enviar prueba» para ver llegar los datos.",
    ],
  },
  webhook: {
    kind: "webhook", name: "Avanzado (webhook firmado)", tagline: "Para programadores: aviso JSON con firma de seguridad hacia tu propio sistema.", field: "Dirección de destino (https)", placeholder: "https://mi-sistema.com/avisos",
    steps: ["Escribe la dirección de tu sistema y elige los avisos.", "Guarda el secreto de firma que se muestra una sola vez."],
  },
};

export type UrlCheck = { ok: true; url: string } | { ok: false; reason: string };

/** Valida el enlace de una app según su tipo. Solo se aceptan los dominios oficiales (evita mandar avisos a direcciones internas). */
export function checkAppUrl(kind: AppKind, raw: string): UrlCheck {
  let u: URL;
  try { u = new URL(raw.trim()); } catch { return { ok: false, reason: "Ese enlace no es válido. Cópialo completo, tal como lo muestra la app." }; }
  if (u.protocol !== "https:" || u.username || u.password || u.port || u.hash) return { ok: false, reason: "Ese enlace no es válido. Debe empezar con https:// y copiarse completo." };
  const host = u.hostname.toLowerCase();
  const path = u.pathname;
  switch (kind) {
    case "discord":
      if (!["discord.com", "discordapp.com", "ptb.discord.com", "canary.discord.com"].includes(host) || !/^\/api(\/v\d+)?\/webhooks\/\d{5,25}\/[\w-]{20,200}\/?$/.test(path))
        return { ok: false, reason: "Ese enlace no parece un webhook de Discord. Debe verse así: https://discord.com/api/webhooks/…" };
      return { ok: true, url: `https://discord.com${path.replace(/\/$/, "")}` };
    case "slack":
      if (host !== "hooks.slack.com" || !/^\/services\/T[\w]+\/B[\w]+\/[\w]{16,64}$/.test(path))
        return { ok: false, reason: "Ese enlace no parece un webhook de Slack. Debe verse así: https://hooks.slack.com/services/…" };
      return { ok: true, url: `https://hooks.slack.com${path}` };
    case "zapier":
      if (host !== "hooks.zapier.com" || !path.startsWith("/hooks/")) return { ok: false, reason: "Ese enlace no parece un «Catch Hook» de Zapier. Debe empezar con https://hooks.zapier.com/hooks/…" };
      return { ok: true, url: u.toString() };
    case "make":
      if (!/^hook\.([a-z0-9-]+\.)?(make\.com|integromat\.com)$/.test(host) || path.length < 4) return { ok: false, reason: "Ese enlace no parece un webhook de Make. Debe empezar con https://hook.…make.com/…" };
      return { ok: true, url: u.toString() };
    default:
      return { ok: true, url: u.toString() };
  }
}

export const TELEGRAM_TOKEN_RE = /^\d{6,14}:[A-Za-z0-9_-]{30,60}$/;
export const TELEGRAM_CHAT_RE = /^-?\d{3,20}$/;

/** Qué se ve en pantalla de una conexión de app (sin revelar enlaces ni tokens). */
export function appDisplay(kind: AppKind, detail?: string | null): string {
  const base = APPS[kind]?.name ?? kind;
  return detail ? `${base} · ${detail}` : base;
}
