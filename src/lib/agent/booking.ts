import type { PoolClient } from "pg";
import { activeServiceDuration, isStartFree, loadSettings, slotsForService } from "@/lib/agenda/load";
import { localDate } from "@/lib/agenda/tz";
import { normalizeUntrusted } from "./safety";
import { treatmentOf, type AgentStyle } from "./style";

type Db = Pick<PoolClient, "query">;

/**
 * Citas pedidas por el asistente (Paso 13C).
 *
 * El modelo NO inventa ni escribe nada en la base de datos:
 *  1. El servidor le muestra un menú cerrado: servicios (S1, S2…) y horarios libres (H1, H2…).
 *  2. Para pedir una cita el modelo escribe una línea con códigos: [[CITA:S1|H3|Nombre]].
 *  3. El servidor comprueba que los códigos existen en ESE menú, vuelve a comprobar que el horario sigue libre
 *     y crea la cita como «pendiente». El mensaje al cliente lo escribe el servidor, no el modelo.
 *  4. Una persona del equipo la confirma desde la Agenda (se crea una tarea para que no se pase).
 */

export const AGENDA_RULES_LINES: readonly string[] = [
  "A. Ofrece solo los horarios de la lista de la AGENDA. Nunca inventes otros ni afirmes que hay disponibilidad que no esté en la lista. Propón dos o tres opciones, no toda la lista.",
  "B. Para pedir una cita necesitas el servicio, un horario de la lista y el nombre del cliente. Cuando el cliente haya elegido con claridad, responde SOLO con esta línea, sin más texto: [[CITA:S1|H3|Nombre del cliente]] (usa los códigos de la lista).",
  "C. Nunca digas que la cita quedó confirmada: el sistema le avisará al cliente que queda pendiente de que una persona del equipo la confirme.",
  "D. Si el cliente quiere cancelar o cambiar una cita que ya tiene, o pide un horario que no está en la lista, responde SOLO con [[HUMANO]] seguido de una frase corta.",
];

export const MAX_MENU_SERVICES = 8;
export const MAX_SLOTS_PER_SERVICE = 8;
const MENU_DAYS = 14;
const MAX_PER_DAY = 3;
const MAX_ACTIVE_PER_CONTACT = 2;
export const MAX_PENDING_AGENT_APPOINTMENTS = 20;

export interface MenuService { code: string; id: string; name: string; durationMin: number; price: string | null }
export interface MenuSlot { code: string; serviceCode: string; startsAt: string }
export interface AgendaMenu { timezone: string; services: MenuService[]; slots: MenuSlot[]; text: string }

/** Texto escrito por el negocio que va al prompt: sin saltos de línea ni marcas que se confundan con las nuestras. */
export function cleanLabel(s: string, max: number): string {
  return normalizeUntrusted(s).replace(/\[\[|\]\]|[<>\r\n]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
}

const STATUS_LABEL: Record<string, string> = { pendiente: "pendiente de confirmación", confirmada: "confirmada" };

export function whenLabel(startsAtIso: string, tz: string): string {
  const d = new Date(startsAtIso);
  const day = new Intl.DateTimeFormat("es-VE", { timeZone: tz, weekday: "long", day: "numeric", month: "long" }).format(d);
  const hm = new Intl.DateTimeFormat("es-VE", { timeZone: tz, hour: "numeric", minute: "2-digit", hour12: true }).format(d);
  return `${day}, ${hm}`;
}

/** Menú de agenda para este turno. null = el negocio no usa citas (sin servicios activos): el asistente actúa como siempre. */
export async function buildMenu(db: Db, tenantId: string, contactId: string, now: number = Date.now()): Promise<AgendaMenu | null> {
  const svc = await db.query("SELECT id, name, duration_minutes, price_text FROM agenda_services WHERE tenant_id = $1 AND active ORDER BY lower(name) LIMIT $2", [tenantId, MAX_MENU_SERVICES]);
  if (svc.rowCount === 0) return null;
  const settings = await loadSettings(db, tenantId);
  const tz = settings.timezone;
  const today = localDate(now, tz);
  const services: MenuService[] = [];
  const slots: MenuSlot[] = [];
  let h = 0;
  for (const [i, r] of svc.rows.entries()) {
    const s: MenuService = { code: `S${i + 1}`, id: r.id, name: cleanLabel(r.name, 80) || "Servicio", durationMin: r.duration_minutes, price: r.price_text ? cleanLabel(r.price_text, 40) : null };
    services.push(s);
    const all = (await slotsForService(db, tenantId, r.id, today, MENU_DAYS)) ?? [];
    const perDay = new Map<string, number>();
    let n = 0;
    for (const sl of all) {
      if (n >= MAX_SLOTS_PER_SERVICE) break;
      const c = perDay.get(sl.date) ?? 0;
      if (c >= MAX_PER_DAY) continue;
      perDay.set(sl.date, c + 1);
      slots.push({ code: `H${++h}`, serviceCode: s.code, startsAt: sl.startsAt });
      n++;
    }
  }

  const mine = await db.query(
    `SELECT a.starts_at, a.status, s.name FROM appointments a JOIN agenda_services s ON s.tenant_id = a.tenant_id AND s.id = a.service_id
      WHERE a.tenant_id = $1 AND a.contact_id = $2 AND a.status IN ('pendiente', 'confirmada') AND a.ends_at > now()
      ORDER BY a.starts_at LIMIT 3`,
    [tenantId, contactId],
  );

  const lines = [
    "AGENDA DEL NEGOCIO (datos del sistema; no los inventes ni los cambies):",
    `Servicios: ${services.map((s) => `${s.code} = ${s.name} (${s.durationMin} min${s.price ? `, ${s.price}` : ""})`).join("; ")}`,
  ];
  if (slots.length === 0) lines.push(`Horarios libres: no hay horarios libres en los próximos ${MENU_DAYS} días. No ofrezcas citas; ofrece comunicar con una persona.`);
  else {
    lines.push("Horarios libres:");
    for (const s of services) {
      const mineSlots = slots.filter((x) => x.serviceCode === s.code);
      lines.push(`${s.code}: ${mineSlots.length ? mineSlots.map((x) => `${x.code} ${whenLabel(x.startsAt, tz)}`).join("; ") : "sin horarios libres"}`);
    }
  }
  lines.push(
    mine.rowCount
      ? `Citas actuales de este cliente: ${mine.rows.map((m) => `${cleanLabel(m.name, 80)}, ${whenLabel(m.starts_at.toISOString(), tz)} (${STATUS_LABEL[m.status] ?? m.status})`).join("; ")}`
      : "Citas actuales de este cliente: ninguna.",
  );
  return { timezone: tz, services, slots, text: lines.join("\n") };
}

export interface BookingRequest { serviceCode: string; slotCode: string; name: string }

const MARKER_RE = /\[\[\s*CITA\s*:\s*(S\d{1,2})\s*\|\s*(H\d{1,3})\s*\|([^\]\n]{0,200})\]\]/i;
const ANY_MARKER_RE = /\[\[\s*CITA[^\]\n]*(?:\]\]?)?/gi;

export function parseBookingRequest(raw: string): BookingRequest | null {
  const m = MARKER_RE.exec(raw);
  if (!m) return null;
  return { serviceCode: m[1]!.toUpperCase(), slotCode: m[2]!.toUpperCase(), name: m[3]!.trim() };
}

/** Quita cualquier resto de la marca para que el cliente nunca la vea. */
export function stripBookingMarkers(raw: string): string {
  return raw.replace(ANY_MARKER_RE, "").trim();
}

/** Nombre apto para guardar: solo letras, espacios, ' y - (sin puntos: así un «nombre» no puede ser un dominio); si queda vacío se usa el de WhatsApp o «Cliente». */
export function cleanCustomerName(proposed: string, fallback: string | null): string {
  const clean = (s: string) => normalizeUntrusted(s).replace(/[^\p{L}\p{M} '’-]/gu, " ").replace(/\s+/g, " ").trim().slice(0, 60);
  return clean(proposed) || (fallback ? clean(fallback) : "") || "Cliente";
}

export type BookingOutcome =
  | { kind: "ok"; id: string; serviceName: string; startsAt: string; name: string }
  | { kind: "ocupado" }
  | { kind: "limite" }
  | { kind: "invalido" };

export async function createAgentAppointment(
  db: Db,
  a: { tenantId: string; contactId: string; conversationId: string; messageId: string; waId: string; contactName: string | null; menu: AgendaMenu; req: BookingRequest },
): Promise<BookingOutcome> {
  const service = a.menu.services.find((s) => s.code === a.req.serviceCode);
  const slot = a.menu.slots.find((s) => s.code === a.req.slotCode && s.serviceCode === a.req.serviceCode);
  if (!service || !slot) return { kind: "invalido" };
  const name = cleanCustomerName(a.req.name, a.contactName);

  // Reintento del mismo mensaje: ya existe la cita, no se crea otra.
  const prev = await db.query("SELECT id, starts_at FROM appointments WHERE tenant_id = $1 AND request_message_id = $2", [a.tenantId, a.messageId]);
  if (prev.rowCount === 1) return { kind: "ok", id: prev.rows[0].id, serviceName: service.name, startsAt: prev.rows[0].starts_at.toISOString(), name };

  const mine = await db.query("SELECT count(*)::int AS n FROM appointments WHERE tenant_id = $1 AND contact_id = $2 AND status IN ('pendiente', 'confirmada') AND ends_at > now()", [a.tenantId, a.contactId]);
  if (mine.rows[0].n >= MAX_ACTIVE_PER_CONTACT) return { kind: "limite" };
  const pend = await db.query("SELECT count(*)::int AS n FROM appointments WHERE tenant_id = $1 AND source = 'agente' AND status = 'pendiente' AND ends_at > now()", [a.tenantId]);
  if (pend.rows[0].n >= MAX_PENDING_AGENT_APPOINTMENTS) return { kind: "limite" };

  // El servicio y el horario se vuelven a validar contra la base: el menú pudo quedar viejo.
  const duration = await activeServiceDuration(db, a.tenantId, service.id);
  if (duration === null) return { kind: "invalido" };
  if (!(await isStartFree(db, a.tenantId, duration, slot.startsAt))) return { kind: "ocupado" };

  const start = new Date(slot.startsAt);
  const end = new Date(start.getTime() + duration * 60_000);
  const phone = /^\d{5,31}$/.test(a.waId) ? `+${a.waId}` : a.waId.slice(0, 32);
  try {
    await db.query("SAVEPOINT cita");
    const ins = await db.query(
      `INSERT INTO appointments (tenant_id, service_id, contact_id, conversation_id, customer_name, customer_phone, starts_at, ends_at, status, source, request_message_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'pendiente', 'agente', $9) RETURNING id`,
      [a.tenantId, service.id, a.contactId, a.conversationId, name, phone, start.toISOString(), end.toISOString(), a.messageId],
    );
    const id = ins.rows[0].id as string;
    await db.query(
      `INSERT INTO work_items (tenant_id, type, priority, title, detail, due_at, conversation_id, contact_id, source, dedupe_key)
       VALUES ($1, 'cita', 2, $2, $3, $4, $5, $6, 'agente', $7) ON CONFLICT DO NOTHING`,
      [a.tenantId, `Confirmar cita: ${name} · ${service.name}`.slice(0, 200), `Pedida por el asistente para ${whenLabel(slot.startsAt, a.menu.timezone)}. Confírmala o cancélala en Agenda.`, start.toISOString(), a.conversationId, a.contactId, `cita:${id}`],
    );
    await db.query("RELEASE SAVEPOINT cita");
    return { kind: "ok", id, serviceName: service.name, startsAt: start.toISOString(), name };
  } catch (e) {
    await db.query("ROLLBACK TO SAVEPOINT cita");
    if ((e as { code?: string }).code === "23P01") return { kind: "ocupado" };
    throw e;
  }
}

// ------------------------------------------------------------------ mensajes fijos (los escribe el servidor, no el modelo)
export interface BookingTexts {
  requested: (name: string, service: string, when: string) => string;
  slotTaken: string;
  limit: string;
}

const BOOKING_BY_TREATMENT: Record<"tu" | "usted" | "vos", BookingTexts> = {
  tu: {
    requested: (n, s, w) => `Listo, ${n}. Dejé tu solicitud de cita para ${s}: ${w}. Queda pendiente: una persona del equipo la confirma y te avisa por aquí.`,
    slotTaken: "Ese horario se acaba de ocupar. Dime si te sirve otro y reviso cuáles siguen libres.",
    limit: "Ya tienes citas pendientes con nosotros, así que te comunico con una persona del equipo para ayudarte. En cuanto pueda te responde por aquí.",
  },
  usted: {
    requested: (n, s, w) => `Listo, ${n}. Dejé su solicitud de cita para ${s}: ${w}. Queda pendiente: una persona del equipo la confirma y le avisa por aquí.`,
    slotTaken: "Ese horario se acaba de ocupar. Dígame si le sirve otro y reviso cuáles siguen libres.",
    limit: "Ya tiene citas pendientes con nosotros, así que le comunico con una persona del equipo para ayudarle. En cuanto pueda le responde por aquí.",
  },
  vos: {
    requested: (n, s, w) => `Listo, ${n}. Dejé tu solicitud de cita para ${s}: ${w}. Queda pendiente: una persona del equipo la confirma y te avisa por acá.`,
    slotTaken: "Ese horario se acaba de ocupar. Decime si te sirve otro y reviso cuáles siguen libres.",
    limit: "Ya tenés citas pendientes con nosotros, así que te comunico con una persona del equipo para ayudarte. En cuanto pueda te responde por acá.",
  },
};

export function bookingTexts(s: AgentStyle): BookingTexts {
  return BOOKING_BY_TREATMENT[treatmentOf(s)];
}
