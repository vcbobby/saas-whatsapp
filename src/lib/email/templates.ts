import { brand } from "@/config/brand";

export interface Rendered { template: string; subject: string; text: string; html: string }

const esc = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
/** Para el asunto: una sola línea, sin saltos (evita inyectar cabeceras) y corto. */
const oneLine = (s: unknown, max = 80) => String(s ?? "").replace(/[\r\n\t]+/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
const fmtDate = (d: unknown) => {
  const t = new Date(String(d));
  return Number.isNaN(t.getTime()) ? "" : new Intl.DateTimeFormat("es-VE", { dateStyle: "long", timeZone: "America/Caracas" }).format(t);
};

interface Body { greeting?: string; paragraphs: string[]; button?: { label: string; url: string }; footer?: string }

function layout(title: string, b: Body): { text: string; html: string } {
  const name = esc(brand.name);
  const text = [b.greeting ?? "Hola,", "", ...b.paragraphs, ...(b.button ? ["", `${b.button.label}: ${b.button.url}`] : []), "", b.footer ?? "", `— El equipo de ${brand.name}`].filter((l, i, a) => !(l === "" && a[i - 1] === "")).join("\n");
  const html = `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${esc(title)}</title></head>
<body style="margin:0;padding:24px;background:#f2f5f4;font-family:Arial,Helvetica,sans-serif;color:#14201d">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center">
<table role="presentation" width="560" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:12px;padding:32px">
<tr><td style="font-size:20px;font-weight:bold;padding-bottom:16px">${name}</td></tr>
<tr><td style="font-size:16px;line-height:1.6">
<p style="margin:0 0 16px">${esc(b.greeting ?? "Hola,")}</p>
${b.paragraphs.map((p) => `<p style="margin:0 0 16px">${esc(p)}</p>`).join("\n")}
${b.button ? `<p style="margin:24px 0"><a href="${esc(b.button.url)}" style="background:#1fbf8f;color:#08261c;text-decoration:none;font-weight:bold;padding:12px 22px;border-radius:999px;display:inline-block">${esc(b.button.label)}</a></p>
<p style="margin:0 0 16px;font-size:13px;color:#52625d">Si el botón no funciona, copia y pega este enlace en tu navegador:<br><span style="word-break:break-all">${esc(b.button.url)}</span></p>` : ""}
${b.footer ? `<p style="margin:16px 0 0;font-size:13px;color:#52625d">${esc(b.footer)}</p>` : ""}
</td></tr>
<tr><td style="padding-top:24px;font-size:12px;color:#7a8a85">${name}${brand.supportEmail ? ` · ¿Dudas? Escríbenos a ${esc(brand.supportEmail)}` : ""}</td></tr>
</table></td></tr></table></body></html>`;
  return { text, html };
}
function make(template: string, subject: string, b: Body): Rendered {
  const { text, html } = layout(subject, b);
  return { template, subject: oneLine(subject, 150), text, html };
}

export const emailTemplates = {
  verifyEmail: (url: string) => make("verificar_correo", `Confirma tu correo en ${brand.name}`, {
    paragraphs: [`Gracias por crear tu cuenta en ${brand.name}. Confirma que este correo es tuyo para poder recuperar tu cuenta si algún día lo necesitas.`], button: { label: "Confirmar mi correo", url }, footer: "El enlace vale 48 horas. Si no creaste una cuenta, ignora este mensaje.",
  }),
  resetPassword: (url: string) => make("recuperar_clave", `Restablece tu contraseña de ${brand.name}`, {
    paragraphs: ["Recibimos una solicitud para cambiar tu contraseña. Pulsa el botón para elegir una nueva."], button: { label: "Elegir nueva contraseña", url }, footer: "El enlace vale 1 hora y solo sirve una vez. Si no lo pediste, ignora este mensaje: tu contraseña sigue igual.",
  }),
  passwordChanged: () => make("clave_cambiada", `Tu contraseña de ${brand.name} fue cambiada`, {
    paragraphs: ["Te avisamos que la contraseña de tu cuenta acaba de cambiar y que cerramos tus sesiones abiertas.", "Si fuiste tú, no tienes que hacer nada. Si NO fuiste tú, recupera tu cuenta ahora con «¿Olvidaste tu contraseña?» y escríbenos de inmediato."],
  }),
  newDevice: (o: { device: string; ip: string; when: unknown }) => make("nuevo_dispositivo", `Nuevo inicio de sesión en tu cuenta de ${brand.name}`, {
    paragraphs: [
      `Alguien acaba de entrar a tu cuenta desde un dispositivo que no habíamos visto: ${oneLine(o.device, 60)}${o.ip && o.ip !== "unknown" ? `, dirección ${oneLine(o.ip, 45)}` : ""}${fmtDate(o.when) ? `, el ${fmtDate(o.when)}` : ""}.`,
      "Si fuiste tú, no tienes que hacer nada.",
      "Si NO fuiste tú: entra a tu cuenta (si puedes) y cambia tu contraseña desde «Seguridad» (eso cierra las demás sesiones), o usa «¿Olvidaste tu contraseña?». Activa también la verificación en dos pasos.",
    ],
  }),
  chatToAttend: (o: { business: string; customer: string; reason: string; mine: boolean; url: string }) => make("chat_por_atender", `${o.mine ? "Te asignaron un chat" : "Un chat espera a una persona"}: ${oneLine(o.customer, 40)}`, {
    paragraphs: [
      `${o.mine ? "Te asignamos" : "Hay"} una conversación de «${oneLine(o.business, 60)}» que ${o.mine ? "necesita" : "necesita"} a una persona: ${oneLine(o.customer, 60)}.`,
      oneLine(o.reason, 200),
      "El asistente ya no le responde a esta persona hasta que alguien la atienda o se la devuelva.",
    ], button: { label: "Abrir la conversación", url: o.url },
  }),
  invitation: (o: { url: string; business: string; role: string; inviter?: string }) => {
    const role = ({ owner: "dueño", admin: "administrador", agent: "agente" } as Record<string, string>)[o.role] ?? o.role;
    return make("invitacion", `${oneLine(o.inviter || "Te", 40) === "Te" ? "Te invitaron" : `${oneLine(o.inviter, 40)} te invitó`} a ${oneLine(o.business, 60)} en ${brand.name}`, {
      paragraphs: [`${o.inviter ? `${o.inviter} te invitó` : "Te invitaron"} a unirte al equipo de «${o.business}» en ${brand.name} como ${role}.`], button: { label: "Aceptar invitación", url: o.url }, footer: "Si no esperabas esta invitación, ignora este mensaje.",
    });
  },
  trialEnding: (o: { business: string; endsAt: unknown; url: string }) => make("prueba_por_vencer", `Tu prueba gratis de ${brand.name} termina pronto`, {
    paragraphs: [`La prueba gratis de «${o.business}» termina el ${fmtDate(o.endsAt)}. Para que tu asistente siga respondiendo a tus clientes, elige un plan antes de esa fecha.`], button: { label: "Ver planes", url: o.url },
  }),
  trialEnded: (o: { business: string; url: string }) => make("prueba_terminada", `Tu prueba gratis terminó: reactiva «${oneLine(o.business, 50)}»`, {
    paragraphs: [`La prueba gratis de «${o.business}» terminó y tu asistente dejó de responder a tus clientes. Tus datos están seguros: al elegir un plan todo sigue como estaba.`], button: { label: "Elegir un plan", url: o.url },
  }),
  planExpiring: (o: { business: string; endsAt: unknown; url: string }) => make("plan_por_vencer", `Tu plan de ${brand.name} vence pronto`, {
    paragraphs: [`El plan de «${o.business}» vence el ${fmtDate(o.endsAt)}. Renueva antes para que tu asistente no se detenga.`], button: { label: "Renovar mi plan", url: o.url },
  }),
  planExpired: (o: { business: string; url: string }) => make("plan_vencido", `Tu plan de ${brand.name} venció`, {
    paragraphs: [`El plan de «${o.business}» venció y tu asistente dejó de responder a tus clientes. Al renovar se reactiva al instante.`], button: { label: "Renovar mi plan", url: o.url },
  }),
  paymentConfirmed: (o: { business: string; plan: string; months: unknown; url: string }) => make("pago_confirmado", `Pago confirmado: ya tienes el plan ${oneLine(o.plan, 40)}`, {
    paragraphs: [`Confirmamos tu pago de ${o.months} mes(es) del plan «${o.plan}» para «${o.business}». ¡Gracias! Tu asistente ya está activo.`], button: { label: "Ir a mi panel", url: o.url },
  }),
  paymentRejected: (o: { business: string; reason?: string | null; url: string }) => make("pago_rechazado", "No pudimos confirmar tu pago", {
    paragraphs: [`No pudimos confirmar el pago reportado para «${o.business}».${o.reason ? ` Motivo: ${o.reason}` : ""}`, "Revisa los datos y vuelve a reportarlo. Si crees que es un error, responde a este correo o escríbenos."], button: { label: "Revisar mi pago", url: o.url },
  }),
};
