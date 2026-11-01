import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { POST as signup } from "@/app/api/auth/signup/route";
import { GET as me } from "@/app/api/me/route";
import { createOrder } from "@/lib/orders/service";
import { getPool, withTenant } from "@/lib/db";

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
  const email = `ap-${RUN}-${name}@example.test`;
  const res = await signup(api("POST", "/api/auth/signup", undefined, { email, password: PASSWORD, businessName: `Negocio ${name}` }));
  expect(res.status).toBe(201);
  const cookie = (res.headers.get("set-cookie") ?? "").split(";")[0]!;
  const info = await (await me(api("GET", "/api/me", cookie))).json();
  tenantIds.push(info.tenant.id);
  return { tenantId: info.tenant.id as string, cookie };
}
type T = Awaited<ReturnType<typeof register>>;
import { POST as createRule } from "@/app/api/automations/route";
import { POST as payPost } from "@/app/api/orders/payment/route";
import { formatEventText } from "@/lib/connections/format";
import { MESSAGE_TRIGGERS } from "@/lib/automations/rules";
import { WEBHOOK_EVENTS, WEBHOOK_EVENT_LABEL } from "@/lib/webhooks/events";

beforeAll(async () => { await getPool().query("SELECT 1"); });
afterAll(async () => {
  await owner.query("DELETE FROM users WHERE email LIKE $1", [`ap-${RUN}-%`]);
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
    } catch (e) { await c.query("ROLLBACK"); throw e; } finally { c.release(); }
  }
  await owner.end();
  await getPool().end();
});
afterEach(() => { vi.unstubAllEnvs(); });

const rule = async (t: T, trigger: string, tpl: string, extra: Record<string, unknown> = {}) => {
  const r = await createRule(api("POST", "/api/automations", t.cookie, { name: "Aviso " + trigger, triggerEvent: trigger, actionType: "mensaje", messageTemplate: tpl, taskTitle: "Avisar a {cliente}", ...extra }));
  return r;
};
const notes = (t: T) => withTenant(t.tenantId, async (db) => (await db.query("SELECT * FROM customer_notifications ORDER BY created_at, id")).rows);
async function customerOrder(t: T) {
  return withTenant(t.tenantId, async (db) => {
    const waId = `58414${String(Math.random()).slice(2, 9)}`;
    const c = (await db.query("INSERT INTO contacts (tenant_id, wa_id, display_name) VALUES ($1,$2,'Ana') RETURNING id", [t.tenantId, waId])).rows[0].id as string;
    const cv = (await db.query("INSERT INTO conversations (tenant_id, contact_id, status) VALUES ($1,$2,'bot') RETURNING id", [t.tenantId, c])).rows[0].id as string;
    await db.query("INSERT INTO messages (tenant_id, conversation_id, direction, msg_type, body, wa_message_id) VALUES ($1,$2,'in','text','hola',$3)", [t.tenantId, cv, `wamid.IN.${randomUUID()}`]);
    const p = (await db.query("INSERT INTO catalog_products (tenant_id, name, price_minor, stock) VALUES ($1,$2,250,NULL) RETURNING id", [t.tenantId, "Arroz " + randomUUID().slice(0, 6)])).rows[0].id as string;
    const r = await createOrder(db, { tenantId: t.tenantId, source: "agente", status: "pendiente", customerName: "Ana", customerPhone: null, contactId: c, conversationId: cv, items: [{ productId: p, quantity: 2 }] });
    if (r.kind !== "ok") throw new Error("pedido");
    return r;
  });
}
const setPay = (t: T, id: string, state: string, method: string | null = null) =>
  withTenant(t.tenantId, (db) => db.query("UPDATE orders SET payment_state = $3, payment_method = $4, paid_at = CASE WHEN $3 = 'pagado' THEN now() ELSE NULL END WHERE tenant_id = $1 AND id = $2", [t.tenantId, id, state, method]));
const pay = (t: T, id: string, action: string, extra: object = {}) => payPost(api("POST", "/api/orders/payment", t.cookie, { id, action, ...extra }));

describe("aviso al cliente cuando se recibe el pago", () => {
  it("al marcar el pedido como pagado nace UN aviso con el texto rellenado", async () => {
    const t = await register("paid");
    expect((await rule(t, "order.paid", "Hola {cliente}, recibimos tu pago del pedido #{numero} ({total}).")).status).toBe(201);
    const o = await customerOrder(t);
    expect(await notes(t)).toHaveLength(0);
    await setPay(t, o.id, "pagado", "Pago móvil");
    const n = await notes(t);
    expect(n).toHaveLength(1);
    expect(n[0]).toMatchObject({ status: "pendiente", customer_name: "Ana" });
    expect(n[0].body).toMatch(new RegExp(`^Hola Ana, recibimos tu pago del pedido #${o.number} \\(5\\.00 \\w+\\)\\.$`));
  });
  it("por la pantalla (API): confirmar el pago avisa; «Marcado por error» no avisa a nadie", async () => {
    const t = await register("api");
    await rule(t, "order.paid", "Pago recibido #{numero}");
    const o = await customerOrder(t);
    expect((await pay(t, o.id, "pagado", { method: "Zelle" })).status).toBe(200);
    expect(await notes(t)).toHaveLength(1);
    expect((await pay(t, o.id, "reabrir")).status).toBe(200);
    expect(await notes(t)).toHaveLength(1); // reabrir no genera aviso
  });
  it("rechazar un comprobante avisa por su propio evento; reabrir un pago no", async () => {
    const t = await register("rej");
    await rule(t, "order.payment_rejected", "No pudimos verificar el comprobante del pedido #{numero}.");
    await rule(t, "order.paid", "Gracias por tu pago.");
    const o = await customerOrder(t);
    await setPay(t, o.id, "por_verificar");
    expect(await notes(t)).toHaveLength(0);
    await setPay(t, o.id, "sin_pago"); // rechazo
    const n = await notes(t);
    expect(n).toHaveLength(1);
    expect(n[0].body).toBe(`No pudimos verificar el comprobante del pedido #${o.number}.`);
    await setPay(t, o.id, "pagado", "Efectivo"); // aviso de pago
    expect(await notes(t)).toHaveLength(2);
    await setPay(t, o.id, "sin_pago"); // reabrir: ni rechazo ni pago
    expect(await notes(t)).toHaveLength(2);
  });
  it("sin reglas no pasa nada, y una regla de otro negocio no se activa", async () => {
    const a = await register("iso-a");
    const b = await register("iso-b");
    await rule(a, "order.paid", "Solo para A");
    const ob = await customerOrder(b);
    await setPay(b, ob.id, "pagado", "Efectivo");
    expect(await notes(b)).toHaveLength(0);
    expect(await notes(a)).toHaveLength(0);
  });
  it("también llega a las apps conectadas (webhook) con el medio de pago", async () => {
    const t = await register("hook");
    await withTenant(t.tenantId, (db) => db.query("INSERT INTO webhook_endpoints (tenant_id, url, events, secret_enc, key_version, active) VALUES ($1, 'https://example.test/hook', '{order.paid,order.payment_rejected}', 'x', 1, true)", [t.tenantId]));
    const o = await customerOrder(t);
    await setPay(t, o.id, "pagado", "Zelle");
    const d = await withTenant(t.tenantId, async (db) => (await db.query("SELECT event_type, payload FROM webhook_deliveries ORDER BY created_at")).rows);
    expect(d.map((x) => x.event_type)).toEqual(["order.paid"]);
    expect(d[0].payload.data.payment.method).toBe("Zelle");
    expect(d[0].payload.data.order.number).toBe(o.number);
  });
});

describe("reglas y catálogo de eventos", () => {
  it("una regla de aviso al cliente acepta los dos eventos; un filtro de estado no tiene sentido y se rechaza", async () => {
    const t = await register("rules");
    expect((await rule(t, "order.paid", "Gracias {cliente}")).status).toBe(201);
    expect((await rule(t, "order.payment_rejected", "Reenvía tu comprobante {cliente}")).status).toBe(201);
    expect((await rule(t, "order.paid", "Gracias", { onlyStatus: "confirmado" })).status).toBe(422);
  });
  it("los eventos tienen nombre en pantalla y se pueden usar como aviso al cliente", () => {
    for (const e of ["order.paid", "order.payment_rejected"] as const) {
      expect(WEBHOOK_EVENTS).toContain(e);
      expect(WEBHOOK_EVENT_LABEL[e].title.length).toBeGreaterThan(3);
      expect(MESSAGE_TRIGGERS).toContain(e);
    }
  });
  it("la base rechaza eventos que no existen", async () => {
    const t = await register("check");
    await expect(withTenant(t.tenantId, (db) => db.query("INSERT INTO webhook_endpoints (tenant_id, url, events, secret_enc, key_version, active) VALUES ($1, 'https://example.test/h', '{order.inventado}', 'x', 1, true)", [t.tenantId]))).rejects.toThrow();
  });
  it("el texto para Telegram/Discord/Slack dice el medio de pago y el rechazo", () => {
    const base = { data: { order: { number: 12, customer_name: "Ana", total_minor: 500, currency: "USD", items: [] }, payment: { method: "Zelle" } } };
    expect(formatEventText("order.paid", base)).toContain("💵 Pedido pagado (Zelle) #12");
    expect(formatEventText("order.payment_rejected", base)).toContain("⚠️ Comprobante rechazado #12");
  });
});
