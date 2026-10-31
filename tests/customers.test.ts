import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { POST as signup } from "@/app/api/auth/signup/route";
import { GET as me } from "@/app/api/me/route";
import { POST as teamInvite } from "@/app/api/team/invite/route";
import { POST as inviteSignup } from "@/app/api/invitations/signup/route";
import { GET as listCustomers } from "@/app/api/customers/route";
import { GET as customerDetail } from "@/app/api/customers/detail/route";
import { POST as updateCustomer } from "@/app/api/customers/update/route";
import { GET as exportData } from "@/app/api/export/route";
import { getPool, withTenant } from "@/lib/db";
import { MAX_TAGS, likeEscape, normalizeTags, splitTagInput } from "@/lib/customers/tags";

const RUN = randomUUID().slice(0, 8);
const ORIGIN = new URL(process.env.APP_URL!).origin;
const PASSWORD = "contraseña-de-prueba-123";
const owner = new Pool({ connectionString: process.env.MIGRATION_DATABASE_URL, max: 2 });
const tenantIds: string[] = [];

function api(method: string, path: string, cookie?: string, body?: unknown, origin = ORIGIN) {
  return new Request(`${ORIGIN}${path}`, {
    method,
    headers: { origin, ...(body !== undefined ? { "content-type": "application/json" } : {}), ...(cookie ? { cookie } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}
async function register(name: string) {
  const email = `cl-${RUN}-${name}@example.test`;
  const res = await signup(api("POST", "/api/auth/signup", undefined, { email, password: PASSWORD, businessName: `Negocio ${name}` }));
  expect(res.status).toBe(201);
  const cookie = (res.headers.get("set-cookie") ?? "").split(";")[0]!;
  const info = await (await me(api("GET", "/api/me", cookie))).json();
  tenantIds.push(info.tenant.id);
  return { tenantId: info.tenant.id as string, cookie };
}
type T = Awaited<ReturnType<typeof register>>;
async function member(t: T, role: "admin" | "agent"): Promise<T> {
  const inv = await teamInvite(api("POST", "/api/team/invite", t.cookie, { email: `cl-${RUN}-${role}-${randomUUID().slice(0, 6)}@example.test`, role }));
  expect(inv.status).toBe(201);
  const token = ((await inv.json()).inviteUrl as string).split("/").pop()!;
  const ok = await inviteSignup(api("POST", "/api/invitations/signup", undefined, { token, password: PASSWORD }));
  expect(ok.status).toBe(201);
  return { tenantId: t.tenantId, cookie: (ok.headers.get("set-cookie") ?? "").split(";")[0]! };
}
beforeAll(async () => { await getPool().query("SELECT 1"); });
afterAll(async () => {
  await owner.query("DELETE FROM users WHERE email LIKE $1", [`cv-${RUN}-%`]);
  for (const id of tenantIds) {
    const c = await owner.connect();
    try {
      await c.query("BEGIN");
      await c.query("SELECT set_config('app.tenant_id', $1, true)", [id]);
      await c.query("ALTER TABLE audit_log DISABLE TRIGGER audit_log_sin_cambios");
      await c.query("DELETE FROM audit_log WHERE tenant_id = $1", [id]);
      await c.query("ALTER TABLE audit_log ENABLE TRIGGER audit_log_sin_cambios");
      const del = await c.query("DELETE FROM tenants WHERE id = $1", [id]);
      if (del.rowCount !== 1) throw new Error("La limpieza no borró el negocio de prueba " + id);
      await c.query("COMMIT");
    } catch (e) {
      await c.query("ROLLBACK");
      throw e;
    } finally {
      c.release();
    }
  }
  await owner.end();
  await getPool().end();
});


const list = (t: T, q = "") => listCustomers(api("GET", `/api/customers${q}`, t.cookie));
const detail = (t: T, id: string) => customerDetail(api("GET", `/api/customers/detail?id=${id}`, t.cookie));
const upd = (t: T, body: unknown, origin = ORIGIN) => updateCustomer(api("POST", "/api/customers/update", t.cookie, body, origin));
const exp = (t: T, q: string) => exportData(api("GET", `/api/export?${q}`, t.cookie));

async function contact(t: T, waId: string, name: string | null) {
  return withTenant(t.tenantId, async (db) => (await db.query("INSERT INTO contacts (tenant_id, wa_id, display_name) VALUES ($1, $2, $3) RETURNING id", [t.tenantId, waId, name])).rows[0]!.id as string);
}
async function order(t: T, number: number, contactId: string | null, phone: string | null, status = "confirmado", total = 1000) {
  await withTenant(t.tenantId, async (db) => {
    const prod = (await db.query("INSERT INTO catalog_products (tenant_id, name, price_minor) VALUES ($1, $2, $3) RETURNING id", [t.tenantId, `P${number}-${randomUUID().slice(0, 4)}`, total])).rows[0]!.id;
    const o = await db.query(
      `INSERT INTO orders (tenant_id, number, contact_id, customer_name, customer_phone, status, source, currency, total_minor, confirmed_at, cancelled_at)
       VALUES ($1, $2, $3, 'X', $4, $5, 'manual', 'USD', $6, CASE WHEN $5 = 'pendiente' THEN NULL ELSE now() END, CASE WHEN $5 = 'cancelado' THEN now() ELSE NULL END) RETURNING id`,
      [t.tenantId, number, contactId, phone, status, total],
    );
    await db.query("INSERT INTO order_items (tenant_id, order_id, product_id, position, name, unit_price_minor, quantity, line_total_minor) VALUES ($1, $2, $3, 1, 'Camisa', $4, 1, $4)", [t.tenantId, o.rows[0].id, prod, total]);
  });
}

describe("etiquetas (función pura)", () => {
  it("limpia espacios, quita repetidas sin mirar mayúsculas y respeta el orden", () => {
    expect(normalizeTags(["  VIP ", "vip", "Zona  norte", ""])).toEqual({ ok: true, tags: ["VIP", "Zona norte"] });
  });
  it("rechaza comas, comillas, etiquetas largas y más de 10", () => {
    expect(normalizeTags(["a,b"]).ok).toBe(false);
    expect(normalizeTags(['a"b']).ok).toBe(false);
    expect(normalizeTags(["x".repeat(31)]).ok).toBe(false);
    expect(normalizeTags(Array.from({ length: MAX_TAGS + 1 }, (_, i) => `t${i}`)).ok).toBe(false);
    expect(normalizeTags(Array.from({ length: MAX_TAGS }, (_, i) => `t${i}`)).ok).toBe(true);
  });
  it("el texto del campo se separa por coma, punto y coma o salto de línea; el LIKE se escapa", () => {
    expect(splitTagInput("vip, mayorista;zona\nnorte")).toEqual(["vip", " mayorista", "zona", "norte"]);
    expect(likeEscape("50%_a\\b")).toBe("50\\%\\_a\\\\b");
  });
});

describe("clientes: lista, ficha y edición", () => {
  it("lista con búsqueda por nombre y teléfono, filtros y paginación", async () => {
    const t = await register("lista");
    const ana = await contact(t, "584121111111", "Ana Pérez");
    await contact(t, "584142222222", "Luis 100% Real");
    await contact(t, "584163333333", null);
    expect((await upd(t, { action: "tags", id: ana, tags: ["VIP", "mayorista"] })).status).toBe(200);

    const all = await (await list(t)).json();
    expect(all.total).toBe(3);
    expect(all.customers).toHaveLength(3);
    expect(all.tags.map((x: { tag: string }) => x.tag).sort()).toEqual(["VIP", "mayorista"]);
    expect((await (await list(t, "?q=ana")).json()).customers.map((c: { id: string }) => c.id)).toEqual([ana]);
    expect((await (await list(t, "?q=4163333")).json()).total).toBe(1);
    expect((await (await list(t, "?q=100%25")).json()).total).toBe(1);
    expect((await (await list(t, "?q=%25")).json()).total).toBe(1);
    expect((await (await list(t, "?q=_")).json()).total).toBe(0);
    expect((await (await list(t, "?tag=vip")).json()).customers[0].id).toBe(ana);
    expect((await (await list(t, "?tag=otra")).json()).total).toBe(0);
    expect((await (await list(t, "?label=cliente")).json()).total).toBe(0);
    expect((await list(t, "?label=raro")).status).toBe(400);
    expect((await list(t, "?page=0")).status).toBe(400);
    const sinNombre = (await (await list(t, "?q=4163333")).json()).customers[0];
    expect(sinNombre.name).toBeNull();
  });

  it("pagina de 30 en 30", async () => {
    const t = await register("pag");
    await withTenant(t.tenantId, (db) => db.query("INSERT INTO contacts (tenant_id, wa_id, display_name) SELECT $1, '5841' || lpad(g::text, 7, '0'), 'C' || g FROM generate_series(1, 35) g", [t.tenantId]));
    const p1 = await (await list(t)).json();
    expect(p1.total).toBe(35); expect(p1.customers).toHaveLength(30); expect(p1.more).toBe(true);
    const p2 = await (await list(t, "?page=2")).json();
    expect(p2.customers).toHaveLength(5); expect(p2.more).toBe(false);
    expect(new Set([...p1.customers, ...p2.customers].map((c: { id: string }) => c.id)).size).toBe(35);
  });

  it("la ficha junta pedidos (por contacto o por teléfono), citas y lo comprado; no cuenta lo cancelado", async () => {
    const t = await register("ficha");
    const ana = await contact(t, "584121234567", "Ana");
    const otra = await contact(t, "584149999999", "Otra");
    await order(t, 1, ana, null, "confirmado", 2000);
    await order(t, 2, null, "+58 412 1234567", "confirmado", 500);
    await order(t, 3, ana, null, "cancelado", 9000);
    await order(t, 4, otra, null, "confirmado", 7000);
    await withTenant(t.tenantId, async (db) => {
      const s = (await db.query("INSERT INTO agenda_services (tenant_id, name, duration_minutes) VALUES ($1, 'Corte', 30) RETURNING id", [t.tenantId])).rows[0]!.id;
      await db.query("INSERT INTO appointments (tenant_id, service_id, contact_id, customer_name, starts_at, ends_at, status, source) VALUES ($1,$2,$3,'Ana','2026-02-05T14:00:00Z','2026-02-05T14:30:00Z','confirmada','manual')", [t.tenantId, s, ana]);
      await db.query("INSERT INTO appointments (tenant_id, service_id, customer_name, customer_phone, starts_at, ends_at, status, source) VALUES ($1,$2,'Ana','+584121234567','2026-03-05T14:00:00Z','2026-03-05T14:30:00Z','completada','manual')", [t.tenantId, s]);
      const cv = (await db.query("INSERT INTO conversations (tenant_id, contact_id, last_message_at) VALUES ($1,$2,now()) RETURNING id", [t.tenantId, ana])).rows[0]!.id;
      await db.query("INSERT INTO messages (tenant_id, conversation_id, direction, msg_type, body) VALUES ($1,$2,'in','text','Hola, quiero una camisa')", [t.tenantId, cv]);
    });
    const d = await (await detail(t, ana)).json();
    expect(d.customer.name).toBe("Ana");
    expect(d.customer.messagesReceived).toBe(1);
    expect(d.orders.map((o: { number: number }) => o.number)).toEqual([3, 2, 1]);
    expect(d.spent).toEqual([{ currency: "USD", totalMinor: 2500, orders: 2 }]);
    expect(d.appointments).toHaveLength(2);
    expect(d.conversations).toHaveLength(1);
    expect(d.conversations[0].lastBody).toBe("Hola, quiero una camisa");
    const l = await (await list(t, "?q=Ana")).json();
    expect(l.customers[0].orders).toBe(2);
    expect(l.customers[0].appointments).toBe(2);
  });

  it("etiquetas, nota, tipo y baja se guardan y quedan en el registro (sin el texto de la nota)", async () => {
    const t = await register("edita");
    const id = await contact(t, "584121234567", "Ana");
    expect((await upd(t, { action: "tags", id, tags: [" VIP ", "vip", "mayorista"] })).status).toBe(200);
    expect((await upd(t, { action: "notes", id, notes: "  Prefiere la tarde \r\n alérgica al maní  " })).status).toBe(200);
    expect((await upd(t, { action: "baja", id, off: true })).status).toBe(200);
    expect((await upd(t, { action: "label", id, label: "cliente" })).status).toBe(200);
    const d = (await (await detail(t, id)).json()).customer;
    expect(d.tags).toEqual(["VIP", "mayorista"]);
    expect(d.notes).toBe("Prefiere la tarde \n alérgica al maní");
    expect(d.optedOut).toBe(true);
    expect(d.label).toBe("cliente");
    expect((await upd(t, { action: "notes", id, notes: "" })).status).toBe(200);
    expect((await (await detail(t, id)).json()).customer.notes).toBe("");
    const log = await withTenant(t.tenantId, async (db) => (await db.query("SELECT action, metadata FROM audit_log WHERE tenant_id = $1 AND action LIKE 'customer.%' ORDER BY created_at", [t.tenantId])).rows);
    expect(log.map((r) => r.action).sort()).toEqual(["customer.baja", "customer.label", "customer.notes", "customer.notes", "customer.tags"]);
    expect(JSON.stringify(log)).not.toContain("maní");
  });

  it("valida: etiquetas inválidas, nota muy larga, id raro, cliente inexistente y origen ajeno", async () => {
    const t = await register("valida");
    const id = await contact(t, "584121234567", "Ana");
    expect((await upd(t, { action: "tags", id, tags: ["a,b"] })).status).toBe(400);
    expect((await upd(t, { action: "tags", id, tags: Array.from({ length: 11 }, (_, i) => `t${i}`) })).status).toBe(400);
    expect((await upd(t, { action: "notes", id, notes: "x".repeat(2001) })).status).toBe(400);
    expect((await upd(t, { action: "label", id, label: "otra" })).status).toBe(400);
    expect((await upd(t, { action: "baja", id: "no-es-uuid", off: true })).status).toBe(400);
    expect((await upd(t, { action: "baja", id: randomUUID(), off: true })).status).toBe(404);
    expect((await upd(t, { action: "baja", id, off: true }, "https://otro.example")).status).toBe(403);
    expect((await detail(t, "xx")).status).toBe(400);
    expect((await detail(t, randomUUID())).status).toBe(404);
  });

  it("un negocio no ve ni toca a los clientes de otro", async () => {
    const A = await register("aislaA");
    const B = await register("aislaB");
    const idA = await contact(A, "584121234567", "Ana de A");
    await order(A, 1, idA, null);
    expect((await detail(B, idA)).status).toBe(404);
    expect((await upd(B, { action: "tags", id: idA, tags: ["hack"] })).status).toBe(404);
    expect((await (await list(B)).json()).total).toBe(0);
    expect((await (await list(B, "?q=Ana")).json()).total).toBe(0);
    expect((await (await detail(A, idA)).json()).customer.tags).toEqual([]);
  });

  it("los agentes ven y editan la ficha; sin sesión no se entra", async () => {
    const t = await register("roles");
    const agent = await member(t, "agent");
    const id = await contact(t, "584121234567", "Ana");
    expect((await list(agent)).status).toBe(200);
    expect((await detail(agent, id)).status).toBe(200);
    expect((await upd(agent, { action: "tags", id, tags: ["nuevo"] })).status).toBe(200);
    expect((await listCustomers(api("GET", "/api/customers"))).status).toBe(401);
    expect((await updateCustomer(api("POST", "/api/customers/update", undefined, { action: "baja", id, off: true }))).status).toBe(401);
  });

  it("el permiso para promociones guarda fecha y origen, se filtra y se puede retirar", async () => {
    const t = await register("permiso");
    const id = await contact(t, "584121234567", "Ana");
    await contact(t, "584149999999", "Luis");
    expect((await (await list(t, "?permiso=si")).json()).total).toBe(0);
    expect((await upd(t, { action: "consent", id, source: "formulario" })).status).toBe(200);
    const d = (await (await detail(t, id)).json()).customer;
    expect(d.consentSource).toBe("formulario");
    expect(new Date(d.consentAt).getTime()).toBeGreaterThan(Date.now() - 60_000);
    expect((await (await list(t, "?permiso=si")).json()).customers.map((c: { id: string }) => c.id)).toEqual([id]);
    expect((await (await list(t, "?permiso=no")).json()).total).toBe(1);
    expect((await upd(t, { action: "consent", id, source: "inventada" })).status).toBe(400);
    expect((await upd(t, { action: "consent", id, source: null })).status).toBe(200);
    const r = (await (await detail(t, id)).json()).customer;
    expect(r.consentAt).toBeNull(); expect(r.consentSource).toBeNull();
    const bad = await withTenant(t.tenantId, (db) => db.query("UPDATE contacts SET promo_consent_at = now() WHERE tenant_id = $1 AND id = $2", [t.tenantId, id])).then(() => null, (e: { code?: string }) => e.code);
    expect(bad).toBe("23514");
  });

  it("la baja que pide el cliente por WhatsApp se ve en la ficha, y se puede revertir", async () => {
    const t = await register("baja");
    const id = await contact(t, "584121234567", "Ana");
    await withTenant(t.tenantId, (db) => db.query("UPDATE contacts SET notifications_off = true WHERE tenant_id = $1 AND id = $2", [t.tenantId, id]));
    expect((await (await list(t, "?baja=1")).json()).total).toBe(1);
    expect((await upd(t, { action: "baja", id, off: false })).status).toBe(200);
    expect((await (await list(t, "?baja=1")).json()).total).toBe(0);
  });

  it("la descarga de clientes incluye tipo, etiquetas, nota y baja (con protección contra fórmulas)", async () => {
    const t = await register("export");
    const id = await contact(t, "584121234567", "Ana");
    await upd(t, { action: "tags", id, tags: ["VIP", "zona norte"] });
    await upd(t, { action: "notes", id, notes: "=SUMA(1)" });
    await upd(t, { action: "baja", id, off: true });
    await upd(t, { action: "consent", id, source: "tienda" });
    const csv = await (await exp(t, "que=clientes&formato=csv")).text();
    expect(csv).toMatch(/^Nombre,Teléfono \(WhatsApp\),Primer contacto \(America\/Caracas\),Tipo,Etiquetas,Nota,No recibir avisos,Permiso para promociones,Pedidos,Citas\r\n/);
    expect(csv).toMatch(/Ana,584121234567,\d{4}-\d{2}-\d{2} \d{2}:\d{2},Sin clasificar,VIP; zona norte,'=SUMA\(1\),Sí,"Sí \(\d{4}-\d{2}-\d{2}, Lo aceptó en la tienda\)",0,0\r\n/);
  });
});
