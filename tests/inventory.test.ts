import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { POST as signup } from "@/app/api/auth/signup/route";
import { GET as me } from "@/app/api/me/route";
import { POST as teamInvite } from "@/app/api/team/invite/route";
import { POST as inviteSignup } from "@/app/api/invitations/signup/route";
import { POST as createProduct } from "@/app/api/catalog/products/route";
import { POST as updateProduct } from "@/app/api/catalog/products/update/route";
import { POST as createOrderApi } from "@/app/api/orders/route";
import { POST as updateOrder } from "@/app/api/orders/update/route";
import { GET as invList } from "@/app/api/inventory/route";
import { POST as invAdjust } from "@/app/api/inventory/adjust/route";
import { POST as invMin } from "@/app/api/inventory/min/route";
import { GET as invMoves } from "@/app/api/inventory/movements/route";
import { GET as invExport } from "@/app/api/inventory/export/route";
import { csvCell, adjustStock, listMovements } from "@/lib/inventory/service";
import { DEFAULT_LOW_STOCK, stockStatus } from "@/lib/inventory/levels";
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
  const email = `iv-${RUN}-${name}@example.test`;
  const res = await signup(api("POST", "/api/auth/signup", undefined, { email, password: PASSWORD, businessName: `Negocio ${name}` }));
  expect(res.status).toBe(201);
  const cookie = (res.headers.get("set-cookie") ?? "").split(";")[0]!;
  const info = await (await me(api("GET", "/api/me", cookie))).json();
  tenantIds.push(info.tenant.id);
  return { tenantId: info.tenant.id as string, cookie, userId: info.user?.id as string | undefined };
}
type T = Awaited<ReturnType<typeof register>>;
type Handler = (req: Request) => Promise<Response>;
const post = (h: Handler, path: string, t: T | null, body: unknown, origin = ORIGIN) => h(api("POST", path, t?.cookie, body, origin));
const product = async (t: T, name: string, stock: number | null) => (await (await post(createProduct, "/api/catalog/products", t, { name, priceMinor: 1000, stock })).json()).id as string;
const adjust = (t: T, productId: string, mode: string, quantity: number, note?: string) => post(invAdjust, "/api/inventory/adjust", t, { productId, mode, quantity, note });
const moves = async (t: T, productId?: string) => (await (await invMoves(api("GET", `/api/inventory/movements${productId ? `?productId=${productId}` : ""}`, t.cookie))).json()).movements as { kind: string; delta: number; stockAfter: number; note: string | null; orderNumber: number | null; actor: string; productName: string }[];
const inv = async (t: T, qs = "") => (await invList(api("GET", `/api/inventory${qs}`, t.cookie))).json() as Promise<{ rows: { id: string; name: string; stock: number | null; minStock: number | null; status: string }[]; summary: Record<string, number>; canManage: boolean }>;

beforeAll(async () => { await getPool().query("SELECT 1"); });
afterAll(async () => {
  await owner.query("DELETE FROM users WHERE email LIKE $1", [`iv-${RUN}-%`]);
  for (const id of tenantIds) {
    const c = await owner.connect();
    try {
      await c.query("BEGIN");
      await c.query("SELECT set_config('app.tenant_id', $1, true)", [id]);
      await c.query("ALTER TABLE audit_log DISABLE TRIGGER audit_log_sin_cambios");
      await c.query("DELETE FROM audit_log WHERE tenant_id = $1", [id]);
      await c.query("ALTER TABLE audit_log ENABLE TRIGGER audit_log_sin_cambios");
      if ((await c.query("DELETE FROM tenants WHERE id = $1", [id])).rowCount !== 1) throw new Error("La limpieza no borró " + id);
      await c.query("COMMIT");
    } catch (e) { await c.query("ROLLBACK"); throw e; } finally { c.release(); }
  }
  await owner.end();
  await getPool().end();
});

describe("estado de stock", () => {
  it("agotado, poco, normal y sin control; el mínimo propio manda sobre el general", () => {
    expect(DEFAULT_LOW_STOCK).toBe(10);
    expect(stockStatus(null, 5)).toBe("sin_control");
    expect(stockStatus(0, null)).toBe("agotado");
    expect(stockStatus(10, null)).toBe("bajo");
    expect(stockStatus(11, null)).toBe("ok");
    expect(stockStatus(3, 2)).toBe("ok");
    expect(stockStatus(2, 2)).toBe("bajo");
    expect(stockStatus(50, 100)).toBe("bajo");
  });
  it("CSV: las fórmulas se desactivan y las comas y comillas se protegen", () => {
    expect(csvCell("=HYPERLINK(\"x\")")).toBe("\"'=HYPERLINK(\"\"x\"\")\"");
    for (const bad of ["+1", "-1", "@a", "\tx"]) expect(csvCell(bad).startsWith("'")).toBe(true);
    expect(csvCell("a,b")).toBe('"a,b"');
    expect(csvCell(null)).toBe("");
    expect(csvCell(5)).toBe("5");
  });
});

describe("historial de movimientos (lo escribe la base de datos)", () => {
  it("stock inicial al crear; entrada, salida, merma y conteo dejan su rastro con quién y cuándo", async () => {
    const t = await register("a");
    const id = await product(t, "Harina", 5);
    expect((await moves(t, id)).map((m) => [m.kind, m.delta, m.stockAfter])).toEqual([["inicial", 5, 5]]);

    expect((await adjust(t, id, "entrada", 20, "compra a proveedor")).status).toBe(200);
    expect((await adjust(t, id, "salida", 3)).status).toBe(200);
    expect((await adjust(t, id, "merma", 2, "se mojó")).status).toBe(200);
    expect((await adjust(t, id, "conteo", 10)).status).toBe(200);
    const m = await moves(t, id);
    expect(m.map((x) => [x.kind, x.delta, x.stockAfter])).toEqual([["ajuste", -10, 10], ["merma", -2, 20], ["salida", -3, 22], ["entrada", 20, 25], ["inicial", 5, 5]]);
    expect(m[3]).toMatchObject({ note: "compra a proveedor", actor: "yo" });
    expect(m[1]!.note).toBe("se mojó");
    expect((await inv(t)).rows[0]).toMatchObject({ stock: 10, status: "bajo" });
  });

  it("rechaza sacar más de lo que hay, cantidades raras y productos sin control; un conteo empieza el control", async () => {
    const t = await register("b");
    const id = await product(t, "Aceite", 4);
    const sin = await product(t, "Servicio", null);
    expect((await adjust(t, id, "salida", 5)).status).toBe(409);
    expect((await adjust(t, id, "entrada", 0)).status).toBe(400);
    expect((await adjust(t, id, "entrada", 1.5)).status).toBe(400);
    expect((await adjust(t, id, "entrada", 2_000_000)).status).toBe(400);
    expect((await adjust(t, id, "entrada", 999_999)).status).toBe(409);
    expect((await adjust(t, id, "regalo", 1)).status).toBe(400);
    expect((await adjust(t, id, "entrada", 1, "x".repeat(201))).status).toBe(400);
    expect((await adjust(t, randomUUID(), "entrada", 1)).status).toBe(404);
    expect((await adjust(t, sin, "entrada", 1)).status).toBe(409);
    expect((await moves(t, id)).length).toBe(1); // nada de lo rechazado dejó rastro
    const ok = await adjust(t, sin, "conteo", 7);
    expect(ok.status).toBe(200);
    expect((await moves(t, sin)).map((x) => [x.kind, x.delta])).toEqual([["inicial", 7]]);
    // mismo número otra vez: sin cambios y sin movimiento nuevo
    expect(await (await adjust(t, sin, "conteo", 7)).json()).toMatchObject({ changed: false });
    expect((await moves(t, sin)).length).toBe(1);
  });

  it("editar el stock en el catálogo también queda anotado; quitar el control no inventa movimientos", async () => {
    const t = await register("c");
    const id = await product(t, "Sal", 0);
    expect(await moves(t, id)).toEqual([]); // stock 0 al crear: nada que anotar
    await post(updateProduct, "/api/catalog/products/update", t, { id, stock: 12 });
    await post(updateProduct, "/api/catalog/products/update", t, { id, stock: 9 });
    await post(updateProduct, "/api/catalog/products/update", t, { id, stock: null });
    await post(updateProduct, "/api/catalog/products/update", t, { id, stock: 4 });
    expect((await moves(t, id)).map((x) => [x.kind, x.delta, x.stockAfter])).toEqual([["inicial", 4, 4], ["edicion", -3, 9], ["edicion", 12, 12]]);
  });

  it("pedidos: confirmar descuenta y deja «pedido» con su número; cancelar devuelve y deja «devolucion»", async () => {
    const t = await register("d");
    const id = await product(t, "Harina", 10);
    const placed = await (await post(createOrderApi, "/api/orders", t, { customerName: "María", items: [{ productId: id, quantity: 3 }] })).json();
    expect(placed.number).toBe(1);
    expect((await moves(t, id))[0]).toMatchObject({ kind: "pedido", delta: -3, stockAfter: 7, orderNumber: 1, actor: "yo" });
    const cancel = await post(updateOrder, "/api/orders/update", t, { id: placed.id, action: "cancel" });
    expect(cancel.status).toBe(200);
    expect((await moves(t, id))[0]).toMatchObject({ kind: "devolucion", delta: 3, stockAfter: 10, orderNumber: 1 });
  });

  it("un cambio sin contexto se anota como «edicion» y el contexto no se filtra al siguiente cambio", async () => {
    const t = await register("e");
    const id = await product(t, "Pan", 10);
    await adjust(t, id, "entrada", 5);
    await withTenant(t.tenantId, (db) => db.query("UPDATE catalog_products SET stock = 1 WHERE tenant_id = $1 AND id = $2", [t.tenantId, id]));
    expect((await moves(t, id))[0]).toMatchObject({ kind: "edicion", delta: -14, stockAfter: 1, actor: "sistema", note: null });
  });

  it("un tipo que no cuadra con el signo se anota como «ajuste» (la base no acepta incoherencias)", async () => {
    const t = await register("f");
    const id = await product(t, "Queso", 10);
    await withTenant(t.tenantId, async (db) => {
      await db.query("SELECT set_config('app.stock_kind', 'entrada', true)");
      await db.query("UPDATE catalog_products SET stock = 4 WHERE tenant_id = $1 AND id = $2", [t.tenantId, id]);
      await db.query("SELECT set_config('app.stock_kind', 'inventado', true)");
      await db.query("UPDATE catalog_products SET stock = 6 WHERE tenant_id = $1 AND id = $2", [t.tenantId, id]);
    });
    expect((await moves(t, id)).slice(0, 2).map((x) => [x.kind, x.delta])).toEqual([["edicion", 2], ["ajuste", -6]]);
  });

  it("la aplicación no puede editar ni borrar el historial, y un negocio no ve el de otro", async () => {
    const a = await register("g1");
    const b = await register("g2");
    const id = await product(a, "Arroz", 8);
    await expect(withTenant(a.tenantId, (db) => db.query("UPDATE stock_movements SET delta = 99 WHERE tenant_id = $1", [a.tenantId]))).rejects.toMatchObject({ code: "42501" });
    await expect(withTenant(a.tenantId, (db) => db.query("DELETE FROM stock_movements WHERE tenant_id = $1", [a.tenantId]))).rejects.toMatchObject({ code: "42501" });
    expect(await withTenant(b.tenantId, async (db) => (await db.query("SELECT count(*)::int AS n FROM stock_movements")).rows[0].n)).toBe(0);
    expect((await adjust(b, id, "entrada", 1)).status).toBe(404); // el producto de A no existe para B
    expect((await moves(a, id)).length).toBe(1);
  });

  it("servicio: ajustar dos veces a la vez no pierde unidades", async () => {
    const t = await register("h");
    const id = await product(t, "Leche", 0);
    await adjust(t, id, "conteo", 100);
    await Promise.all(Array.from({ length: 10 }, () => withTenant(t.tenantId, (db) => adjustStock(db, t.tenantId, { productId: id, mode: "salida", quantity: 3 }))));
    expect((await inv(t)).rows[0]!.stock).toBe(70);
    const all = await withTenant(t.tenantId, (db) => listMovements(db, t.tenantId, { productId: id }));
    expect(all.reduce((s, m) => s + m.delta, 0)).toBe(70);
    expect(all[0]!.stockAfter).toBe(70);
  });
});

describe("API de inventario", () => {
  it("exige sesión y origen válido; sin sesión no lista nada", async () => {
    const t = await register("i");
    const id = await product(t, "Café", 5);
    expect((await invList(api("GET", "/api/inventory"))).status).toBe(401);
    expect((await invMoves(api("GET", "/api/inventory/movements"))).status).toBe(401);
    expect((await invExport(api("GET", "/api/inventory/export"))).status).toBe(401);
    expect((await post(invAdjust, "/api/inventory/adjust", null, { productId: id, mode: "entrada", quantity: 1 })).status).toBe(401);
    expect((await post(invAdjust, "/api/inventory/adjust", t, { productId: id, mode: "entrada", quantity: 1 }, "https://malo.example")).status).toBe(403);
    expect((await post(invMin, "/api/inventory/min", t, { productId: id, minStock: 1 }, "https://malo.example")).status).toBe(403);
    expect((await invMoves(api("GET", "/api/inventory/movements?productId=no-es-uuid", t.cookie))).status).toBe(400);
    expect((await moves(t, id)).length).toBe(1);
  });

  it("resumen y filtros: agotados, poco stock, sin control, búsqueda; el mínimo propio cambia el estado", async () => {
    const t = await register("j");
    const harina = await product(t, "Harina", 50);
    await product(t, "Sal", 0);
    await product(t, "Azúcar", 4);
    await product(t, "Delivery", null);
    let r = await inv(t);
    expect(r.summary).toEqual({ tracked: 3, low: 1, out: 1, untracked: 1 });
    expect(r.rows.map((x) => x.name)).toEqual(["Sal", "Azúcar", "Harina", "Delivery"]); // lo urgente primero
    expect((await inv(t, "?filter=out")).rows.map((x) => x.name)).toEqual(["Sal"]);
    expect((await inv(t, "?filter=low")).rows.map((x) => x.name)).toEqual(["Azúcar"]);
    expect((await inv(t, "?filter=untracked")).rows.map((x) => x.name)).toEqual(["Delivery"]);
    expect((await inv(t, "?q=har")).rows.map((x) => x.name)).toEqual(["Harina"]);
    expect((await inv(t, "?filter=raro")).rows.length).toBe(4);
    expect((await post(invMin, "/api/inventory/min", t, { productId: harina, minStock: 60 })).status).toBe(200);
    r = await inv(t);
    expect(r.summary.low).toBe(2);
    expect(r.rows.find((x) => x.id === harina)).toMatchObject({ minStock: 60, status: "bajo" });
    expect((await post(invMin, "/api/inventory/min", t, { productId: harina, minStock: null })).status).toBe(200);
    expect((await inv(t)).summary.low).toBe(1);
    expect((await post(invMin, "/api/inventory/min", t, { productId: randomUUID(), minStock: 1 })).status).toBe(404);
    expect((await post(invMin, "/api/inventory/min", t, { productId: harina, minStock: -1 })).status).toBe(400);
  });

  it("CSV: se descarga con cabeceras seguras y un producto con fórmula no se ejecuta", async () => {
    const t = await register("k");
    const id = await product(t, "=cmd|' /C calc'!A0", 3);
    await adjust(t, id, "entrada", 2, "+nota,con \"comillas\"");
    const stock = await invExport(api("GET", "/api/inventory/export?que=stock", t.cookie));
    expect(stock.status).toBe(200);
    expect(stock.headers.get("content-type")).toContain("text/csv");
    expect(stock.headers.get("content-disposition")).toContain("attachment");
    expect(stock.headers.get("cache-control")).toBe("no-store");
    expect(stock.headers.get("x-content-type-options")).toBe("nosniff");
    const csv = await stock.text();
    expect(csv).toContain("Producto,Presentación,Stock");
    expect(csv).toContain("'=cmd|");
    expect(csv).not.toMatch(/(^|\r\n)=cmd/);
    const mv = await (await invExport(api("GET", "/api/inventory/export?que=movimientos", t.cookie))).text();
    expect(mv).toContain("Entrada");
    expect(mv).toContain('"\'+nota,con ""comillas"""');
    expect((await invExport(api("GET", "/api/inventory/export?que=todo", t.cookie))).status).toBe(400);
  });

  it("el equipo de «agente» puede ver pero no ajustar ni descargar", async () => {
    const t = await register("l");
    const id = await product(t, "Jugo", 5);
    const inviteRes = await teamInvite(api("POST", "/api/team/invite", t.cookie, { email: `iv-${RUN}-ag@example.test`, role: "agent" }));
    expect(inviteRes.status).toBe(201);
    const token = ((await inviteRes.json()).inviteUrl as string).split("/").pop()!;
    const ok = await inviteSignup(api("POST", "/api/invitations/signup", undefined, { token, password: PASSWORD }));
    const ag: T = { tenantId: t.tenantId, cookie: (ok.headers.get("set-cookie") ?? "").split(";")[0]!, userId: undefined };
    const view = await inv(ag);
    expect(view.canManage).toBe(false);
    expect(view.rows.length).toBe(1);
    expect((await moves(ag, id)).length).toBe(1);
    expect((await adjust(ag, id, "entrada", 1)).status).toBe(403);
    expect((await post(invMin, "/api/inventory/min", ag, { productId: id, minStock: 1 })).status).toBe(403);
    expect((await invExport(api("GET", "/api/inventory/export", ag.cookie))).status).toBe(403);
    // el historial distingue a quién lo hizo
    await adjust(t, id, "entrada", 1);
    expect((await moves(ag, id))[0]!.actor).toBe("equipo");
  });
});
