import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { POST as signup } from "@/app/api/auth/signup/route";
import { GET as me } from "@/app/api/me/route";
import { POST as teamInvite } from "@/app/api/team/invite/route";
import { POST as inviteSignup } from "@/app/api/invitations/signup/route";
import { GET as getConfig } from "@/app/api/catalog/config/route";
import { PUT as putSettings } from "@/app/api/catalog/settings/route";
import { POST as createProduct } from "@/app/api/catalog/products/route";
import { POST as updateProduct } from "@/app/api/catalog/products/update/route";
import { can } from "@/lib/auth/permissions";
import { GET as listOrders, POST as createOrderApi } from "@/app/api/orders/route";
import { POST as updateOrder } from "@/app/api/orders/update/route";
import { createOrder, mergeLines, type OrderInput } from "@/lib/orders/service";
import { ingestBatch } from "@/lib/whatsapp/ingest";
import { encryptSecret } from "@/lib/crypto";
import { getPool, withTenant } from "@/lib/db";

const RUN = randomUUID().slice(0, 8);
const ORIGIN = new URL(process.env.APP_URL!).origin;
const PASSWORD = "contraseña-de-prueba-123";
const owner = new Pool({ connectionString: process.env.MIGRATION_DATABASE_URL, max: 2 });
const tenantIds: string[] = [];
let seq = 0;

function api(method: string, path: string, cookie?: string, body?: unknown, origin = ORIGIN) {
  return new Request(`${ORIGIN}${path}`, {
    method,
    headers: { origin, ...(body !== undefined ? { "content-type": "application/json" } : {}), ...(cookie ? { cookie } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

async function register(name: string) {
  const email = `od-${RUN}-${name}@example.test`;
  const res = await signup(api("POST", "/api/auth/signup", undefined, { email, password: PASSWORD, businessName: `Negocio ${name}` }));
  expect(res.status).toBe(201);
  const cookie = (res.headers.get("set-cookie") ?? "").split(";")[0]!;
  const info = await (await me(api("GET", "/api/me", cookie))).json();
  tenantIds.push(info.tenant.id);
  const phoneId = `8${RUN.replace(/\D/g, "").padEnd(4, "7").slice(0, 4)}${Date.now() % 100000}${seq++}`.slice(0, 18);
  const { payload, keyVersion } = encryptSecret("EAAtoken-de-prueba-del-negocio-1234567890", `wa:${info.tenant.id}:${phoneId}`);
  await owner.query("INSERT INTO tenant_integrations (tenant_id, provider, external_id, secret_enc, key_version) VALUES ($1,'whatsapp',$2,$3,$4)", [info.tenant.id, phoneId, payload, keyVersion]);
  return { tenantId: info.tenant.id as string, cookie, phoneId };
}
type T = Awaited<ReturnType<typeof register>>;

type Handler = (req: Request) => Promise<Response>;
const send = (h: Handler, path: string, t: T | null, body: unknown, method = "POST", origin = ORIGIN) => h(api(method, path, t?.cookie, body, origin));
const create = (t: T, body: Record<string, unknown>) => send(createProduct, "/api/catalog/products", t, { priceMinor: 1000, ...body });
const update = (t: T, body: Record<string, unknown>) => send(updateProduct, "/api/catalog/products/update", t, body);
const config = async (t: T) => (await getConfig(api("GET", "/api/catalog/config", t.cookie))).json() as Promise<{ currency: string; canManage: boolean; products: { id: string; name: string; description: string | null; unit: string | null; priceMinor: number; stock: number | null; active: boolean }[] }>;
const idOf = async (res: Response) => (await res.json()).id as string;

/** Invita a alguien con ese rol, acepta la invitación y devuelve su sesión dentro del negocio. */
async function member(t: T, role: "admin" | "agent"): Promise<T> {
  const inv = await teamInvite(api("POST", "/api/team/invite", t.cookie, { email: `od-${RUN}-${role}-${randomUUID().slice(0, 6)}@example.test`, role }));
  expect(inv.status).toBe(201);
  const token = ((await inv.json()).inviteUrl as string).split("/").pop()!;
  const ok = await inviteSignup(api("POST", "/api/invitations/signup", undefined, { token, password: PASSWORD }));
  expect(ok.status).toBe(201);
  return { tenantId: t.tenantId, cookie: (ok.headers.get("set-cookie") ?? "").split(";")[0]!, phoneId: t.phoneId };
}

beforeAll(async () => { await getPool().query("SELECT 1"); });
afterAll(async () => {
  await owner.query("DELETE FROM users WHERE email LIKE $1", [`od-${RUN}-%`]);
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


type Order = { id: string; number: number; status: string; source: string; customerName: string; customerPhone: string | null; notes: string | null; deliveryNote: string | null; currency: string; totalMinor: number; conversationId: string | null; items: { name: string; unit: string | null; unitPriceMinor: number; quantity: number; lineTotalMinor: number }[] };
type Listing = { counts: Record<string, number>; more: boolean; orders: Order[] };
const list = async (t: T, qs = "") => (await listOrders(api("GET", `/api/orders${qs}`, t.cookie))).json() as Promise<Listing>;
const place = (t: T, body: Record<string, unknown>) => send(createOrderApi, "/api/orders", t, { customerName: "María Pérez", ...body });
const act = (t: T, id: string, action: string) => send(updateOrder, "/api/orders/update", t, { id, action });
const stockOf = async (t: T, id: string) => (await config(t)).products.find((p) => p.id === id)!.stock;

/** Un negocio con productos: Harina $10,50 (stock 5), Aceite $5 (sin control de stock), Sal $1 (stock 0). */
async function shop(name: string) {
  const t = await register(name);
  const mk = async (n: string, priceMinor: number, stock: number | null, unit?: string) => idOf(await create(t, { name: n, priceMinor, stock, ...(unit ? { unit } : {}) }));
  const harina = await mk("Harina", 1050, 5, "paquete 1 kg");
  const aceite = await mk("Aceite", 500, null);
  const sal = await mk("Sal", 100, 0);
  return { t, harina, aceite, sal };
}
const rawOrder = (tenantId: string, over: Partial<OrderInput> & { items: OrderInput["items"] }): OrderInput => ({ tenantId, source: "agente", status: "pendiente", customerName: "Cliente", ...over });
const inTx = <T2,>(tenantId: string, fn: (db: Parameters<Parameters<typeof withTenant>[1]>[0]) => Promise<T2>) => withTenant(tenantId, fn);
const dbErr = async (tenantId: string, sql: string, args: unknown[] = []) =>
  inTx(tenantId, async (db) => { try { await db.query("SAVEPOINT s"); await db.query(sql, args); return null; } catch (e) { return (e as { code?: string }).code ?? "?"; } });

describe("crear pedidos", () => {
  it("calcula el total en el servidor con los precios del catálogo y guarda una copia de cada línea", async () => {
    const { t, harina, aceite } = await shop("crea");
    const res = await place(t, { customerPhone: "0414-1234567", notes: "sin prisa", deliveryNote: "Retira en tienda", items: [{ productId: harina, quantity: 2 }, { productId: aceite, quantity: 3 }] });
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ ok: true, number: 1, totalMinor: 2 * 1050 + 3 * 500 });
    const { orders, counts } = await list(t);
    expect(counts).toEqual({ pendiente: 0, confirmado: 1, entregado: 0, cancelado: 0 });
    expect(orders[0]).toMatchObject({ number: 1, status: "confirmado", source: "manual", customerName: "María Pérez", customerPhone: "0414-1234567", notes: "sin prisa", deliveryNote: "Retira en tienda", currency: "USD", totalMinor: 3600 });
    expect(orders[0]!.items.map((i) => i.name)).toEqual(["Harina", "Aceite"]); // el orden en que se pidieron
    const byName = Object.fromEntries(orders[0]!.items.map((i) => [i.name, i]));
    expect(byName.Harina).toEqual({ name: "Harina", unit: "paquete 1 kg", unitPriceMinor: 1050, quantity: 2, lineTotalMinor: 2100 });
    expect(byName.Aceite).toEqual({ name: "Aceite", unit: null, unitPriceMinor: 500, quantity: 3, lineTotalMinor: 1500 });
  });

  it("ignora precios o totales que mande el cliente", async () => {
    const { t, harina } = await shop("precio");
    const res = await place(t, { totalMinor: 1, priceMinor: 1, items: [{ productId: harina, quantity: 1, unitPriceMinor: 1, priceMinor: 1, name: "Gratis" }] });
    expect(res.status).toBe(201);
    const o = (await list(t)).orders[0]!;
    expect(o.totalMinor).toBe(1050);
    expect(o.items[0]).toMatchObject({ name: "Harina", unitPriceMinor: 1050 });
  });

  it("junta líneas repetidas del mismo producto", async () => {
    const { t, harina } = await shop("junta");
    await place(t, { items: [{ productId: harina, quantity: 2 }, { productId: harina, quantity: 3 }] });
    const o = (await list(t)).orders[0]!;
    expect(o.items).toHaveLength(1);
    expect(o.items[0]).toMatchObject({ quantity: 5, lineTotalMinor: 5250 });
    expect(mergeLines([{ productId: "b", quantity: 1 }, { productId: "a", quantity: 1 }, { productId: "b", quantity: 2 }])).toEqual([{ productId: "b", quantity: 3 }, { productId: "a", quantity: 1 }]);
  });

  it("numera 1, 2, 3… por negocio, sin repetir ni dejar huecos ni siquiera con pedidos simultáneos", async () => {
    const a = await shop("numA");
    const b = await shop("numB");
    const rs = await Promise.all(Array.from({ length: 8 }, () => place(a.t, { items: [{ productId: a.aceite, quantity: 1 }] })));
    expect(rs.map((r) => r.status)).toEqual(Array(8).fill(201));
    const nums = (await list(a.t)).orders.map((o) => o.number).sort((x, y) => x - y);
    expect(nums).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    await place(b.t, { items: [{ productId: b.aceite, quantity: 1 }] });
    expect((await list(b.t)).orders[0]!.number).toBe(1);
  });

  it("al crear confirmado se descuenta el stock de los productos que lo controlan, y solo de esos", async () => {
    const { t, harina, aceite } = await shop("stock");
    await place(t, { items: [{ productId: harina, quantity: 2 }, { productId: aceite, quantity: 4 }] });
    expect(await stockOf(t, harina)).toBe(3);
    expect(await stockOf(t, aceite)).toBeNull();
  });

  it("sin stock suficiente: 409, no se crea nada, no se toca el stock de otras líneas y no se gasta el número", async () => {
    const { t, harina, aceite, sal } = await shop("sinstock");
    const r = await place(t, { items: [{ productId: aceite, quantity: 1 }, { productId: harina, quantity: 6 }, { productId: sal, quantity: 1 }] });
    expect(r.status).toBe(409);
    const j = await r.json();
    expect(j.error).toBe("sin_stock");
    expect(j.message).toContain("Harina");
    expect(j.message).toContain("Sal");
    expect((await list(t)).orders).toHaveLength(0);
    expect(await stockOf(t, harina)).toBe(5);
    expect((await place(t, { items: [{ productId: aceite, quantity: 1 }] })).status).toBe(201);
    expect((await list(t)).orders[0]!.number).toBe(1);
  });

  it("el límite exacto de stock se puede vender entero y luego ya no", async () => {
    const { t, harina } = await shop("limite");
    expect((await place(t, { items: [{ productId: harina, quantity: 5 }] })).status).toBe(201);
    expect(await stockOf(t, harina)).toBe(0);
    expect((await place(t, { items: [{ productId: harina, quantity: 1 }] })).status).toBe(409);
  });

  it("dos pedidos simultáneos por la última unidad: solo uno entra y el stock nunca baja de cero", async () => {
    const { t, harina } = await shop("carrera");
    await update(t, { id: harina, stock: 1 });
    const rs = await Promise.all(Array.from({ length: 6 }, () => place(t, { items: [{ productId: harina, quantity: 1 }] })));
    expect(rs.filter((r) => r.status === 201)).toHaveLength(1);
    expect(rs.filter((r) => r.status === 409)).toHaveLength(5);
    expect(await stockOf(t, harina)).toBe(0);
    expect((await list(t)).orders).toHaveLength(1);
  });

  it("productos desactivados, inexistentes o de otro negocio dan 404", async () => {
    const a = await shop("prodA");
    const b = await shop("prodB");
    await update(a.t, { id: a.aceite, active: false });
    for (const productId of [a.aceite, randomUUID(), b.harina]) {
      const r = await place(a.t, { items: [{ productId, quantity: 1 }] });
      expect(r.status).toBe(404);
      expect((await r.json()).error).toBe("producto_no_disponible");
    }
    expect((await list(a.t)).orders).toHaveLength(0);
    expect(await stockOf(b.t, b.harina)).toBe(5);
  });

  it("rechaza datos inválidos con 400 y no guarda nada", async () => {
    const { t, harina } = await shop("invalidos");
    const ok = [{ productId: harina, quantity: 1 }];
    const bads: Record<string, unknown>[] = [
      { items: [] }, { items: undefined }, { items: Array.from({ length: 51 }, () => ({ productId: harina, quantity: 1 })) },
      { items: [{ productId: harina, quantity: 0 }] }, { items: [{ productId: harina, quantity: -1 }] }, { items: [{ productId: harina, quantity: 1.5 }] },
      { items: [{ productId: harina, quantity: "2" }] }, { items: [{ productId: harina, quantity: 10000 }] }, { items: [{ productId: "no-uuid", quantity: 1 }] },
      { items: ok, customerName: "" }, { items: ok, customerName: "x".repeat(121) }, { items: ok, customerPhone: "abc" }, { items: ok, notes: "x".repeat(1001) },
      { items: ok, deliveryNote: "x".repeat(301) }, { items: ok, conversationId: "no-uuid" },
    ];
    for (const b of bads) expect((await place(t, b)).status, JSON.stringify(b).slice(0, 80)).toBe(400);
    expect((await list(t)).orders).toHaveLength(0);
    expect(await stockOf(t, harina)).toBe(5);
    const big = await place(t, { items: [{ productId: harina, quantity: 10000 }] });
    expect((await big.json()).error).toBe("datos_invalidos"); // lo frena la validación de la API, no solo el servicio
  });

  it("líneas repetidas que juntas pasan de 9999 unidades, o un total gigante, se rechazan con 400", async () => {
    const { t, aceite } = await shop("enorme");
    const r1 = await place(t, { items: [{ productId: aceite, quantity: 6000 }, { productId: aceite, quantity: 6000 }] });
    expect(r1.status).toBe(400);
    expect((await r1.json()).error).toBe("cantidad_excedida");
    await update(t, { id: aceite, priceMinor: 10_000_000_000 });
    const r2 = await place(t, { items: [{ productId: aceite, quantity: 200 }] });
    expect(r2.status).toBe(400);
    expect((await r2.json()).error).toBe("total_excedido");
    expect((await place(t, { items: [{ productId: aceite, quantity: 100 }] })).status).toBe(201);
    expect((await list(t)).orders).toHaveLength(1);
  });

  it("cambiar el catálogo después no altera pedidos viejos (nombre, precio, moneda)", async () => {
    const { t, harina } = await shop("copia");
    await place(t, { items: [{ productId: harina, quantity: 2 }] });
    await update(t, { id: harina, name: "Harina PAN", priceMinor: 9999 });
    await send(putSettings, "/api/catalog/settings", t, { currency: "VES" }, "PUT");
    await update(t, { id: harina, active: false });
    const o = (await list(t)).orders[0]!;
    expect(o.currency).toBe("USD");
    expect(o.totalMinor).toBe(2100);
    expect(o.items[0]).toMatchObject({ name: "Harina", unitPriceMinor: 1050 });
    const nuevo = await idOf(await create(t, { name: "Nuevo", priceMinor: 100 }));
    await place(t, { items: [{ productId: nuevo, quantity: 1 }] });
    expect((await list(t)).orders[0]!.currency).toBe("VES");
  });

  it("puede enlazarse a una conversación del mismo negocio; una ajena o inexistente da 404", async () => {
    const a = await shop("convA");
    const b = await shop("convB");
    const conv = async (t: T) => inTx(t.tenantId, async (db) => {
      const c = (await db.query("INSERT INTO contacts (tenant_id, wa_id) VALUES ($1, $2) RETURNING id", [t.tenantId, `58412${Date.now() % 10000000}${seq++}`])).rows[0].id as string;
      return (await db.query("INSERT INTO conversations (tenant_id, contact_id) VALUES ($1, $2) RETURNING id", [t.tenantId, c])).rows[0].id as string;
    });
    const ca = await conv(a.t);
    const cb = await conv(b.t);
    expect((await place(a.t, { conversationId: ca, items: [{ productId: a.aceite, quantity: 1 }] })).status).toBe(201);
    expect((await list(a.t)).orders[0]!.conversationId).toBe(ca);
    expect((await place(a.t, { conversationId: cb, items: [{ productId: a.aceite, quantity: 1 }] })).status).toBe(404);
    expect((await place(a.t, { conversationId: randomUUID(), items: [{ productId: a.aceite, quantity: 1 }] })).status).toBe(404);
  });
});

describe("estados y stock", () => {
  /** Pedido del asistente (pendiente, sin descontar stock) con su tarea «Confirmar pedido». */
  async function pending(t: T, items: { productId: string; quantity: number }[]) {
    return inTx(t.tenantId, async (db) => {
      const r = await createOrder(db, rawOrder(t.tenantId, { items }));
      if (r.kind !== "ok") throw new Error("no se creó " + r.kind);
      await db.query("INSERT INTO work_items (tenant_id, type, title, source, dedupe_key) VALUES ($1, 'pedido', 'Confirmar pedido', 'agente', $2)", [t.tenantId, `pedido:${r.id}`]);
      return r.id;
    });
  }
  const task = (t: T, id: string) => inTx(t.tenantId, async (db) => (await db.query("SELECT status, resolved_at FROM work_items WHERE dedupe_key = $1", [`pedido:${id}`])).rows[0] as { status: string; resolved_at: Date | null });
  const status = async (t: T, id: string) => (await list(t)).orders.find((o) => o.id === id)!.status;

  it("un pedido del asistente nace pendiente y no descuenta stock", async () => {
    const { t, harina } = await shop("pend");
    const id = await pending(t, [{ productId: harina, quantity: 2 }]);
    expect(await status(t, id)).toBe("pendiente");
    expect(await stockOf(t, harina)).toBe(5);
  });

  it("confirmar descuenta el stock, fija la fecha y cierra la tarea como resuelta", async () => {
    const { t, harina, aceite } = await shop("conf");
    const id = await pending(t, [{ productId: harina, quantity: 2 }, { productId: aceite, quantity: 1 }]);
    expect((await act(t, id, "confirm")).status).toBe(200);
    expect(await status(t, id)).toBe("confirmado");
    expect(await stockOf(t, harina)).toBe(3);
    expect(await stockOf(t, aceite)).toBeNull();
    expect((await task(t, id)).status).toBe("resuelto");
    expect((await task(t, id)).resolved_at).not.toBeNull();
  });

  it("confirmar sin stock suficiente: 409, sigue pendiente y no cambia nada; con stock repuesto sí se puede", async () => {
    const { t, harina } = await shop("conf-sin");
    const id = await pending(t, [{ productId: harina, quantity: 4 }]);
    await update(t, { id: harina, stock: 3 });
    const r = await act(t, id, "confirm");
    expect(r.status).toBe(409);
    expect((await r.json()).error).toBe("sin_stock");
    expect(await status(t, id)).toBe("pendiente");
    expect(await stockOf(t, harina)).toBe(3);
    expect((await task(t, id)).status).toBe("abierto");
    await update(t, { id: harina, stock: 4 });
    expect((await act(t, id, "confirm")).status).toBe(200);
    expect(await stockOf(t, harina)).toBe(0);
  });

  it("confirmar dos veces (incluso a la vez) descuenta una sola vez", async () => {
    const { t, harina } = await shop("doble");
    const id = await pending(t, [{ productId: harina, quantity: 2 }]);
    const rs = await Promise.all([act(t, id, "confirm"), act(t, id, "confirm"), act(t, id, "confirm")]);
    expect(rs.filter((r) => r.status === 200)).toHaveLength(1);
    expect(rs.filter((r) => r.status === 409)).toHaveLength(2);
    expect(await stockOf(t, harina)).toBe(3);
  });

  it("dos pedidos pendientes por la última unidad: al confirmar los dos a la vez solo uno entra", async () => {
    const { t, harina } = await shop("ultima");
    await update(t, { id: harina, stock: 1 });
    const a = await pending(t, [{ productId: harina, quantity: 1 }]);
    const b = await pending(t, [{ productId: harina, quantity: 1 }]);
    const rs = await Promise.all([act(t, a, "confirm"), act(t, b, "confirm")]);
    expect(rs.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(await stockOf(t, harina)).toBe(0);
  });

  it("entregar solo desde confirmado; entregado y cancelado son finales", async () => {
    const { t, harina } = await shop("final");
    const id = await pending(t, [{ productId: harina, quantity: 1 }]);
    expect((await act(t, id, "deliver")).status).toBe(409);
    await act(t, id, "confirm");
    expect((await act(t, id, "deliver")).status).toBe(200);
    expect(await status(t, id)).toBe("entregado");
    for (const a of ["confirm", "deliver", "cancel"]) expect((await act(t, id, a)).status, a).toBe(409);
    expect(await stockOf(t, harina)).toBe(4);
  });

  it("cancelar un pedido confirmado devuelve exactamente el stock descontado; cancelar uno pendiente no toca el stock", async () => {
    const { t, harina } = await shop("cancel");
    const conf = await pending(t, [{ productId: harina, quantity: 3 }]);
    await act(t, conf, "confirm");
    expect(await stockOf(t, harina)).toBe(2);
    expect((await act(t, conf, "cancel")).status).toBe(200);
    expect(await stockOf(t, harina)).toBe(5);
    expect((await task(t, conf)).status).toBe("resuelto"); // ya estaba resuelta al confirmar
    const pend = await pending(t, [{ productId: harina, quantity: 2 }]);
    expect((await act(t, pend, "cancel")).status).toBe(200);
    expect(await stockOf(t, harina)).toBe(5);
    expect(await inTx(t.tenantId, async (db) => (await db.query("SELECT count(*)::int AS n FROM order_items WHERE order_id = $1 AND stock_taken", [conf])).rows[0].n)).toBe(0);
    expect((await task(t, pend)).status).toBe("descartado");
    expect(await status(t, pend)).toBe("cancelado");
  });

  it("cancelar dos veces no devuelve el stock dos veces", async () => {
    const { t, harina } = await shop("cancel2");
    const r = await place(t, { items: [{ productId: harina, quantity: 2 }] });
    const id = (await r.json()).id as string;
    const rs = await Promise.all([act(t, id, "cancel"), act(t, id, "cancel")]);
    expect(rs.map((x) => x.status).sort()).toEqual([200, 409]);
    expect(await stockOf(t, harina)).toBe(5);
  });

  it("al cancelar, un producto que ya no controla stock sigue sin controlarlo, y el stock nunca pasa del máximo", async () => {
    const { t, harina, aceite } = await shop("cancel3");
    await update(t, { id: aceite, stock: 10 });
    const id = (await (await place(t, { items: [{ productId: harina, quantity: 2 }, { productId: aceite, quantity: 4 }] })).json()).id as string;
    await update(t, { id: harina, stock: null });
    await update(t, { id: aceite, stock: 999_999 });
    expect((await act(t, id, "cancel")).status).toBe(200);
    expect(await stockOf(t, harina)).toBeNull();
    expect(await stockOf(t, aceite)).toBe(1_000_000);
  });

  it("pedidos y acciones inexistentes", async () => {
    const { t } = await shop("noexiste");
    expect((await act(t, randomUUID(), "confirm")).status).toBe(404);
    expect((await act(t, randomUUID(), "borrar")).status).toBe(400);
    expect((await send(updateOrder, "/api/orders/update", t, { id: "x", action: "confirm" })).status).toBe(400);
  });

  it("un pedido de otro negocio no se puede tocar", async () => {
    const a = await shop("tocaA");
    const b = await shop("tocaB");
    const id = await pending(a.t, [{ productId: a.harina, quantity: 1 }]);
    expect((await act(b.t, id, "confirm")).status).toBe(404);
    expect((await act(b.t, id, "cancel")).status).toBe(404);
    expect(await status(a.t, id)).toBe("pendiente");
  });
});

describe("lista de pedidos", () => {
  it("filtra por estado, cuenta por estado y ordena del más nuevo al más viejo", async () => {
    const { t, aceite } = await shop("lista");
    const ids: string[] = [];
    for (let i = 0; i < 4; i++) ids.push((await (await place(t, { customerName: `C${i}`, items: [{ productId: aceite, quantity: 1 }] })).json()).id);
    await act(t, ids[0]!, "deliver");
    await act(t, ids[1]!, "cancel");
    const all = await list(t);
    expect(all.orders.map((o) => o.number)).toEqual([4, 3, 2, 1]);
    expect(all.counts).toEqual({ pendiente: 0, confirmado: 2, entregado: 1, cancelado: 1 });
    expect((await list(t, "?status=confirmado")).orders.map((o) => o.number)).toEqual([4, 3]);
    expect((await list(t, "?status=cancelado")).orders.map((o) => o.number)).toEqual([2]);
    expect((await list(t, "?status=pendiente")).orders).toEqual([]);
  });

  it("filtros inválidos dan 400", async () => {
    const { t } = await shop("filtro");
    for (const qs of ["?status=raro", "?before=abc", "?before=-1", "?before=0"]) expect((await listOrders(api("GET", `/api/orders${qs}`, t.cookie))).status, qs).toBe(400);
  });

  it("pagina de 100 en 100 con «before»", async () => {
    const { t, aceite } = await shop("pagina");
    await inTx(t.tenantId, async (db) => { for (let i = 0; i < 103; i++) await createOrder(db, rawOrder(t.tenantId, { status: "confirmado", source: "manual", items: [{ productId: aceite, quantity: 1 }] })); });
    const p1 = await list(t);
    expect(p1.orders).toHaveLength(100);
    expect(p1.more).toBe(true);
    expect(p1.orders[0]!.number).toBe(103);
    const p2 = await list(t, `?before=${p1.orders.at(-1)!.number}`);
    expect(p2.orders.map((o) => o.number)).toEqual([3, 2, 1]);
    expect(p2.more).toBe(false);
  });

  it("cada negocio ve solo sus pedidos", async () => {
    const a = await shop("veA");
    const b = await shop("veB");
    await place(a.t, { customerName: "Solo de A", items: [{ productId: a.aceite, quantity: 1 }] });
    expect((await list(b.t)).orders).toEqual([]);
    expect((await list(b.t)).counts.confirmado).toBe(0);
    const seen = await inTx(b.t.tenantId, async (db) => (await db.query("SELECT (SELECT count(*) FROM orders WHERE tenant_id = $1) AS o, (SELECT count(*) FROM order_items WHERE tenant_id = $1) AS i", [a.t.tenantId])).rows[0]);
    expect(seen).toEqual({ o: "0", i: "0" });
  });
});

describe("seguridad", () => {
  it("sin sesión: 401; desde otro sitio: 403; no cambia nada", async () => {
    const { t, harina } = await shop("seg");
    expect((await listOrders(api("GET", "/api/orders"))).status).toBe(401);
    expect((await send(createOrderApi, "/api/orders", null, { customerName: "A", items: [{ productId: harina, quantity: 1 }] })).status).toBe(401);
    expect((await send(updateOrder, "/api/orders/update", null, { id: randomUUID(), action: "cancel" })).status).toBe(401);
    const evil = "https://evil.example";
    expect((await send(createOrderApi, "/api/orders", t, { customerName: "A", items: [{ productId: harina, quantity: 1 }] }, "POST", evil)).status).toBe(403);
    const id = (await (await place(t, { items: [{ productId: harina, quantity: 1 }] })).json()).id as string;
    expect((await send(updateOrder, "/api/orders/update", t, { id, action: "cancel" }, "POST", evil)).status).toBe(403);
    expect((await list(t)).orders[0]!.status).toBe("confirmado");
    expect(await stockOf(t, harina)).toBe(4);
  });

  it("los agentes también pueden tomar y gestionar pedidos", async () => {
    const { t, harina } = await shop("rol");
    for (const r of ["owner", "admin", "agent"] as const) { expect(can(r, "orders:read")).toBe(true); expect(can(r, "orders:write")).toBe(true); }
    expect(can(null, "orders:read")).toBe(false);
    const ag = await member(t, "agent");
    const r = await place(ag, { items: [{ productId: harina, quantity: 1 }] });
    expect(r.status).toBe(201);
    const id = (await r.json()).id as string;
    expect((await act(ag, id, "deliver")).status).toBe(200);
    expect((await list(ag)).orders).toHaveLength(1);
  });
});

describe("base de datos", () => {
  it("un pedido sin líneas, o con un total que no es la suma de sus líneas, no se guarda", async () => {
    const { t, aceite } = await shop("db1");
    const tx = (total: number, withItem: boolean) => inTx(t.tenantId, async (db) => {
      const o = await db.query("INSERT INTO orders (tenant_id, number, customer_name, source, currency, total_minor) VALUES ($1, 99, 'X', 'manual', 'USD', $2) RETURNING id", [t.tenantId, total]);
      if (withItem) await db.query("INSERT INTO order_items (tenant_id, order_id, product_id, position, name, unit_price_minor, quantity, line_total_minor) VALUES ($1, $2, $3, 1, 'Aceite', 500, 2, 1000)", [t.tenantId, o.rows[0].id, aceite]);
    }).then(() => null, (e: { code?: string }) => e.code);
    expect(await tx(1000, false)).toBe("23514");
    expect(await tx(999, true)).toBe("23514");
    expect(await tx(1000, true)).toBeNull();
  });

  it("número, total, moneda y origen de un pedido no cambian; las líneas tampoco; los estados finales no se reabren", async () => {
    const { t, aceite } = await shop("db2");
    const id = (await (await place(t, { items: [{ productId: aceite, quantity: 2 }] })).json()).id as string;
    for (const sql of ["UPDATE orders SET total_minor = 1 WHERE id = $1", "UPDATE orders SET number = 50 WHERE id = $1", "UPDATE orders SET currency = 'VES' WHERE id = $1", "UPDATE orders SET source = 'agente' WHERE id = $1",
      "UPDATE order_items SET unit_price_minor = 1, line_total_minor = 2 WHERE order_id = $1", "UPDATE order_items SET quantity = 3, line_total_minor = 1500 WHERE order_id = $1", "UPDATE order_items SET name = 'Otro' WHERE order_id = $1"]) {
      expect(await dbErr(t.tenantId, sql, [id]), sql).toBe("23514");
    }
    expect(await dbErr(t.tenantId, "UPDATE order_items SET stock_taken = NOT stock_taken WHERE order_id = $1", [id])).toBeNull();
    await act(t, id, "cancel");
    expect(await dbErr(t.tenantId, "UPDATE orders SET status = 'confirmado', cancelled_at = NULL, confirmed_at = now() WHERE id = $1", [id])).toBe("23514");
  });

  it("la base también protege cantidades, líneas mal sumadas, fechas incoherentes y estados raros", async () => {
    const { t, aceite } = await shop("db3");
    const id = (await (await place(t, { items: [{ productId: aceite, quantity: 1 }] })).json()).id as string;
    const item = (sql: string) => dbErr(t.tenantId, `INSERT INTO order_items (tenant_id, order_id, product_id, position, name, unit_price_minor, quantity, line_total_minor) VALUES ($1, $2, $3, ${sql})`, [t.tenantId, id, aceite]);
    expect(await item("2, 'A', 500, 0, 0")).toBe("23514");
    expect(await item("2, 'A', 500, 10000, 5000000")).toBe("23514");
    expect(await item("2, 'A', 500, 2, 999")).toBe("23514");
    expect(await dbErr(t.tenantId, "UPDATE orders SET status = 'raro' WHERE id = $1", [id])).toBe("23514");
    expect(await dbErr(t.tenantId, "UPDATE orders SET status = 'cancelado' WHERE id = $1", [id])).toBe("23514"); // cancelado sin fecha
    expect(await dbErr(t.tenantId, "UPDATE orders SET status = 'entregado' WHERE id = $1", [id])).toBe("23514"); // entregado sin fecha
  });

  it("un negocio no puede escribir pedidos a nombre de otro", async () => {
    const a = await shop("dbA");
    const b = await shop("dbB");
    expect(await dbErr(a.t.tenantId, "INSERT INTO orders (tenant_id, number, customer_name, source, currency, total_minor) VALUES ($1, 1, 'X', 'manual', 'USD', 0)", [b.t.tenantId])).toBe("42501");
    expect(await dbErr(a.t.tenantId, "INSERT INTO order_counters (tenant_id, last_number) VALUES ($1, 5)", [b.t.tenantId])).toBe("42501");
  });

  it("el mismo mensaje del cliente no genera dos pedidos ni descuenta dos veces", async () => {
    const { t, harina } = await shop("idem");
    const m = (await ingestBatch({ phoneNumberId: t.phoneId, statuses: [], messages: [{ waId: `58414${Date.now() % 10000000}1`, name: "Ana", waMessageId: `wamid.od.${RUN}.${seq++}`, at: new Date(), type: "text", body: "quiero harina" }] })).inbound[0]!.messageId;
    const first = await inTx(t.tenantId, (db) => createOrder(db, rawOrder(t.tenantId, { requestMessageId: m, items: [{ productId: harina, quantity: 2 }] })));
    expect(first.kind).toBe("ok");
    const again = await inTx(t.tenantId, (db) => createOrder(db, rawOrder(t.tenantId, { requestMessageId: m, items: [{ productId: harina, quantity: 4 }] })));
    expect(again.kind).toBe("repetido");
    expect(again.kind === "repetido" && again.id).toBe(first.kind === "ok" && first.id);
    expect((await list(t)).orders).toHaveLength(1);
    expect((await list(t)).orders[0]!.totalMinor).toBe(2100);
    expect(await dbErr(t.tenantId, "INSERT INTO orders (tenant_id, number, customer_name, source, currency, total_minor, request_message_id) VALUES ($1, 77, 'X', 'manual', 'USD', 0, $2)", [t.tenantId, m])).toBe("23514");
  });
});
