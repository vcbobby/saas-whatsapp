// Mensajes en español, legibles por personas, para cada aviso (Telegram, Discord, Slack). Sin dependencias de servidor.
type Json = Record<string, unknown>;
const obj = (v: unknown): Json => (v && typeof v === "object" && !Array.isArray(v) ? (v as Json) : {});
const str = (v: unknown, max = 120) => (typeof v === "string" || typeof v === "number" ? String(v).replace(/\s+/g, " ").trim().slice(0, max) : "");

function money(minor: unknown, currency: unknown) {
  const n = Number(minor);
  if (!Number.isFinite(n)) return "";
  return `${(n / 100).toFixed(2)} ${str(currency, 6)}`.trim();
}
function when(v: unknown) {
  const d = new Date(str(v, 40));
  if (Number.isNaN(d.getTime())) return "";
  return new Intl.DateTimeFormat("es-VE", { dateStyle: "short", timeStyle: "short", timeZone: "America/Caracas" }).format(d);
}
const STATUS: Record<string, string> = { pendiente: "pendiente", confirmado: "confirmado", confirmada: "confirmada", entregado: "entregado", cancelado: "cancelado", cancelada: "cancelada", completada: "completada", no_asistio: "no asistió" };
const st = (v: unknown) => STATUS[str(v, 30)] ?? str(v, 30);

/** Texto del aviso. Nunca incluye datos que no sean del propio negocio y se recorta a 1800 caracteres (límite de Discord: 2000). */
export function formatEventText(type: string, payload: unknown): string {
  const data = obj(obj(payload).data);
  let t: string;
  switch (type) {
    case "order.created":
    case "order.status_changed":
    case "order.paid":
    case "order.payment_rejected": {
      const o = obj(data.order);
      const items = Array.isArray(o.items) ? (o.items as unknown[]).slice(0, 8).map((i) => `• ${str(obj(i).quantity, 6)} × ${str(obj(i).name, 60)}`).join("\n") : "";
      const pay = obj(data.payment);
      const head = type === "order.created" ? "🛒 Pedido nuevo" : type === "order.paid" ? `💵 Pedido pagado${pay.method ? ` (${str(pay.method, 40)})` : ""}` : type === "order.payment_rejected" ? "⚠️ Comprobante rechazado" : `📦 Pedido cambió a «${st(o.status)}»`;
      t = [`${head} #${str(o.number, 12)}`, `Cliente: ${str(o.customer_name) || "—"}${o.customer_phone ? ` (${str(o.customer_phone, 24)})` : ""}`, items, `Total: ${money(o.total_minor, o.currency) || "—"}`, o.delivery_note ? `Nota: ${str(o.delivery_note, 200)}` : ""].filter(Boolean).join("\n");
      break;
    }
    case "appointment.created":
    case "appointment.status_changed":
    case "appointment.rescheduled":
    case "appointment.upcoming": {
      const a = obj(data.appointment);
      const head = { "appointment.created": "📅 Cita nueva", "appointment.status_changed": `📅 Cita ${st(a.status)}`, "appointment.rescheduled": "📅 Cita reprogramada", "appointment.upcoming": "⏰ Cita próxima" }[type];
      t = [head, `${str(a.service) || "Servicio"} · ${when(a.starts_at) || "—"}`, `Cliente: ${str(a.customer_name) || "—"}${a.customer_phone ? ` (${str(a.customer_phone, 24)})` : ""}`].join("\n");
      break;
    }
    case "conversation.handoff": {
      const c = obj(data.conversation);
      t = [`🙋 ${str(c.contact_name) || "Un cliente"} necesita a una persona`, c.contact_phone ? `Teléfono: ${str(c.contact_phone, 24)}` : "", "Entra a Conversaciones para atenderle."].filter(Boolean).join("\n");
      break;
    }
    case "contact.created": {
      const c = obj(data.contact);
      t = `👋 Cliente nuevo: ${str(c.name) || "sin nombre"}${c.phone ? ` (+${str(c.phone, 24)})` : ""}`;
      break;
    }
    case "stock.low": {
      const p = obj(data.product);
      t = p.level === "agotado" ? `❌ Producto agotado: ${str(p.name)}` : `⚠️ Poco stock: ${str(p.name)} — quedan ${str(p.stock, 12)}${p.unit ? ` ${str(p.unit, 20)}` : ""} (mínimo ${str(p.min_stock, 12)})`;
      break;
    }
    case "automation.message":
      t = str(data.text, 1800) || "Aviso";
      break;
    case "webhook.test":
      t = "✅ ¡Conexión lista! Este es un mensaje de prueba: a partir de ahora recibirás aquí los avisos que elegiste.";
      break;
    default:
      t = `Aviso: ${str(type, 60)}`;
  }
  return t.slice(0, 1800);
}
