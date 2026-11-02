import type { PoolClient } from "pg";

type Db = Pick<PoolClient, "query">;

export interface DemoCounts { contacts: number; products: number; services: number; orders: number }

const HOUR = 3_600_000, DAY = 24 * HOUR;
const SUFFIX = " (ejemplo)";

export async function demoCounts(db: Db, tenantId: string): Promise<DemoCounts> {
  const r = await db.query<{ c: number; p: number; s: number; o: number }>(
    `SELECT (SELECT count(*) FROM contacts WHERE tenant_id = $1 AND demo)::int AS c,
            (SELECT count(*) FROM catalog_products WHERE tenant_id = $1 AND demo)::int AS p,
            (SELECT count(*) FROM agenda_services WHERE tenant_id = $1 AND demo)::int AS s,
            (SELECT count(*) FROM orders WHERE tenant_id = $1 AND demo)::int AS o`, [tenantId]);
  const x = r.rows[0]!;
  return { contacts: x.c, products: x.p, services: x.s, orders: x.o };
}

/**
 * Crea clientes, conversaciones, productos, pedidos y citas de ejemplo para que se vea cómo funciona todo.
 * Todo queda marcado como «ejemplo»; los clientes de ejemplo tienen números inventados y NO reciben avisos.
 * Devuelve false si ya hay datos de ejemplo.
 */
export async function loadDemo(db: Db, tenantId: string, now: Date = new Date()): Promise<boolean> {
  const T = tenantId;
  const t0 = now.getTime();
  const at = (ms: number) => new Date(ms).toISOString();
  const c = await demoCounts(db, T);
  if (c.contacts + c.products + c.services + c.orders > 0) return false;

  // Productos y servicio.
  const prod = async (name: string, price: number, stock: number) =>
    (await db.query<{ id: string }>("INSERT INTO catalog_products (tenant_id, name, price_minor, stock, min_stock, demo) VALUES ($1,$2,$3,$4,3,true) RETURNING id", [T, name + SUFFIX, price, stock])).rows[0]!.id;
  const camisa = await prod("Camisa", 1200, 25);
  const gorra = await prod("Gorra", 800, 4);
  const bolso = await prod("Bolso", 2500, 10);
  const svc = (await db.query<{ id: string }>("INSERT INTO agenda_services (tenant_id, name, duration_minutes, demo) VALUES ($1,$2,30,true) RETURNING id", [T, "Consulta" + SUFFIX])).rows[0]!.id;

  // Clientes y conversaciones. Los números empiezan con 58000…: no existen.
  const person = async (n: number, name: string, label: string, tags: string[]) =>
    (await db.query<{ id: string }>("INSERT INTO contacts (tenant_id, wa_id, display_name, label, tags, notifications_off, demo, created_at) VALUES ($1,$2,$3,$4,$5,true,true,$6) RETURNING id", [T, `5800000000${n}`, name + SUFFIX, label, tags, at(t0 - (n + 1) * DAY)])).rows[0]!.id;
  const conv = async (contact: string, status: string, startedMs: number, reason: string | null) =>
    (await db.query<{ id: string }>("INSERT INTO conversations (tenant_id, contact_id, status, handoff_reason, created_at, last_message_at) VALUES ($1,$2,$3,$4,$5,$5) RETURNING id", [T, contact, status, reason, at(startedMs)])).rows[0]!.id;
  const say = async (cv: string, dir: "in" | "out", ms: number, body: string, replyTo?: string) =>
    (await db.query<{ id: string }>(
      `INSERT INTO messages (tenant_id, conversation_id, direction, msg_type, body, created_at, received_at, reply_to, send_state, process_state)
       VALUES ($1,$2,$3,'text',$4,$5,$5,$6,$7,$8) RETURNING id`,
      [T, cv, dir, body, at(ms), replyTo ?? null, dir === "out" ? "sent" : null, "done"])).rows[0]!.id;

  const ana = await person(1, "Ana Pérez", "cliente", ["frecuente"]);
  const luis = await person(2, "Luis Gómez", "cliente", []);
  const marta = await person(3, "Marta Rojas", "cliente", ["mayorista"]);
  const jose = await person(4, "José Silva", "cliente", []);
  // De dónde llegaron (para ver el reporte «¿De dónde llegaron tus clientes?» con datos).
  await db.query("UPDATE contacts SET origin_type = 'anuncio', origin_headline = $3, origin_at = created_at WHERE tenant_id = $1 AND id = ANY($2::uuid[])", [T, [marta, luis], "Camisas y gorras 2x1 (ejemplo)"]);
  await db.query("UPDATE contacts SET origin_type = 'publicacion', origin_at = created_at WHERE tenant_id = $1 AND id = $2", [T, jose]);

  const v1 = await conv(ana, "bot", t0 - 2 * DAY, null);
  const a1 = await say(v1, "in", t0 - 2 * DAY, "Hola, ¿tienen camisas disponibles?");
  await say(v1, "out", t0 - 2 * DAY + 20_000, "¡Hola! Sí, tenemos camisas a $12. ¿Quieres que te aparte una?", a1);
  const a2 = await say(v1, "in", t0 - 2 * DAY + 5 * 60_000, "Sí, dos por favor");
  await say(v1, "out", t0 - 2 * DAY + 5 * 60_000 + 25_000, "Listo, apartadas 2 camisas. Total: $24. ¿Cómo prefieres pagar?", a2);

  const v2 = await conv(luis, "bot", t0 - 3 * DAY, null);
  const l1 = await say(v2, "in", t0 - 3 * DAY, "¿Hasta qué hora atienden hoy?");
  await say(v2, "out", t0 - 3 * DAY + 15_000, "Atendemos hasta las 5:00 p. m. ¿Te ayudo con algo más?", l1);

  const v3 = await conv(marta, "human", t0 - 5 * HOUR, "pedido_de_persona");
  const m1 = await say(v3, "in", t0 - 5 * HOUR, "Quiero hacer un pedido grande, ¿puedo hablar con alguien?");
  await say(v3, "out", t0 - 5 * HOUR + 18_000, "Claro, te comunico con una persona del equipo.", m1);
  await say(v3, "in", t0 - 4 * HOUR, "Necesito 20 gorras para el viernes");

  const v4 = await conv(jose, "bot", t0 - 4 * DAY, null);
  const j1 = await say(v4, "in", t0 - 4 * DAY, "Buenas, quiero reservar una consulta");
  await say(v4, "out", t0 - 4 * DAY + 22_000, "¡Con gusto! Tengo disponible mañana a las 3:00 p. m. ¿Te sirve?", j1);

  // Pedidos (los tres con productos que suman su total).
  let num = ((await db.query<{ n: number }>("SELECT COALESCE(MAX(number), 0)::int AS n FROM orders WHERE tenant_id = $1", [T])).rows[0]!.n) + 1;
  const order = async (contact: string, name: string, conv: string, status: "pendiente" | "confirmado" | "entregado", ageMs: number, lines: [string, string, number, number][]) => {
    const total = lines.reduce((s, l) => s + l[2] * l[3], 0);
    const created = at(t0 - ageMs);
    const o = (await db.query<{ id: string }>(
      `INSERT INTO orders (tenant_id, number, contact_id, conversation_id, customer_name, status, source, currency, total_minor, created_at, confirmed_at, delivered_at, demo)
       VALUES ($1,$2,$3,$4,$5,$6,'manual','USD',$7,$8,$9,$10,true) RETURNING id`,
      [T, num++, contact, conv, name + SUFFIX, status, total, created, status === "pendiente" ? null : created, status === "entregado" ? created : null])).rows[0]!.id;
    let pos = 1;
    for (const [pid, pname, price, qty] of lines) {
      await db.query("INSERT INTO order_items (tenant_id, order_id, product_id, position, name, unit_price_minor, quantity, line_total_minor) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)", [T, o, pid, pos++, pname + SUFFIX, price, qty, price * qty]);
    }
  };
  await order(ana, "Ana Pérez", v1, "confirmado", 2 * DAY, [[camisa, "Camisa", 1200, 2]]);
  await order(luis, "Luis Gómez", v2, "entregado", 3 * DAY, [[gorra, "Gorra", 800, 1], [bolso, "Bolso", 2500, 1]]);
  await order(marta, "Marta Rojas", v3, "pendiente", 4 * HOUR, [[gorra, "Gorra", 800, 20]]);

  // Citas: una por venir y una ya atendida.
  const appt = (contact: string, name: string, cv: string, startMs: number, status: string) =>
    db.query("INSERT INTO appointments (tenant_id, service_id, contact_id, conversation_id, customer_name, starts_at, ends_at, status, source) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'manual')",
      [T, svc, contact, cv, name + SUFFIX, at(startMs), at(startMs + 30 * 60_000), status]);
  await appt(jose, "José Silva", v4, t0 + DAY, "confirmada");
  await appt(ana, "Ana Pérez", v1, t0 - 3 * DAY, "completada");
  return true;
}

/** Borra TODO lo marcado como ejemplo (y lo que cuelga de ello). Lo real no se toca. */
export async function clearDemo(db: Db, tenantId: string): Promise<DemoCounts> {
  const before = await demoCounts(db, tenantId);
  // Orden: pedidos → productos → clientes (arrastran conversaciones, mensajes, citas y tareas) → servicios.
  await db.query("DELETE FROM orders WHERE tenant_id = $1 AND demo", [tenantId]);
  await db.query("DELETE FROM catalog_products WHERE tenant_id = $1 AND demo", [tenantId]);
  await db.query("DELETE FROM contacts WHERE tenant_id = $1 AND demo", [tenantId]);
  await db.query("DELETE FROM agenda_services WHERE tenant_id = $1 AND demo", [tenantId]);
  return before;
}
