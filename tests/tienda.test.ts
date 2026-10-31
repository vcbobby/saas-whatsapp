import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { POST as signup } from "@/app/api/auth/signup/route";
import { GET as me } from "@/app/api/me/route";
import { POST as teamInvite } from "@/app/api/team/invite/route";
import { POST as inviteSignup } from "@/app/api/invitations/signup/route";
import { GET as storeGet, PUT as storePut } from "@/app/api/public-catalog/route";
import { GET as qrGet } from "@/app/api/public-catalog/qr/route";
import { NextRequest } from "next/server";
import { getPool, withTenant } from "@/lib/db";
import { proxy } from "@/proxy";
import { loadStore } from "@/lib/storefront/load";
import { normalizePhone, orderText, waLink } from "@/lib/storefront/pure";

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
  const email = `st-${RUN}-${name}@example.test`;
  const res = await signup(api("POST", "/api/auth/signup", undefined, { email, password: PASSWORD, businessName: `Negocio ${name}` }));
  expect(res.status).toBe(201);
  const cookie = (res.headers.get("set-cookie") ?? "").split(";")[0]!;
  const info = await (await me(api("GET", "/api/me", cookie))).json();
  tenantIds.push(info.tenant.id);
  return { tenantId: info.tenant.id as string, cookie, email };
}
type T = Awaited<ReturnType<typeof register>>;
async function agentOf(t: T) {
  const email = `st-${RUN}-ag-${randomUUID().slice(0, 6)}@example.test`;
  const inv = await teamInvite(api("POST", "/api/team/invite", t.cookie, { email, role: "agent" }));
  const token = ((await inv.json()).inviteUrl as string).split("/").pop()!;
  const ok = await inviteSignup(api("POST", "/api/invitations/signup", undefined, { token, password: PASSWORD }));
  return (ok.headers.get("set-cookie") ?? "").split(";")[0]!;
}
async function oq(t: { tenantId: string }, sql: string, params: unknown[] = []) {
  const c = await owner.connect();
  try {
    await c.query("BEGIN");
    await c.query("SELECT set_config('app.tenant_id', $1, true)", [t.tenantId]);
    const r = await c.query(sql, params);
    await c.query("COMMIT");
    return r;
  } catch (e) { await c.query("ROLLBACK"); throw e; } finally { c.release(); }
}

beforeAll(async () => { await getPool().query("SELECT 1"); });
afterAll(async () => {
  await owner.query("DELETE FROM users WHERE email LIKE $1", [`st-${RUN}-%`]);
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

const put = (t: { cookie: string }, b: object, origin = ORIGIN) => storePut(api("PUT", "/api/public-catalog", t.cookie, b, origin));
const slugOf = async (t: T) => (await withTenant(t.tenantId, (db) => db.query("SELECT slug FROM tenants WHERE id = $1", [t.tenantId]))).rows[0].slug as string;
const addProduct = (t: T, name: string, o: { active?: boolean; stock?: number | null; price?: number } = {}) =>
  oq(t, "INSERT INTO catalog_products (tenant_id, name, price_minor, stock, active, description) VALUES ($1,$2,$3,$4,$5,'Rico y fresco')", [t.tenantId, name, o.price ?? 1000, o.stock ?? null, o.active ?? true]);

describe("catálogo público: lógica", () => {
  it("normaliza el teléfono para wa.me", () => {
    expect(normalizePhone("+58 (412) 123-4567")).toBe("584121234567");
    expect(normalizePhone("0412 1234567")).toBeNull();
    expect(normalizePhone("123")).toBeNull();
    expect(normalizePhone("58412abc")).toBeNull();
    expect(normalizePhone("1".repeat(16))).toBeNull();
  });
  it("arma el texto del pedido y el enlace", () => {
    expect(orderText("Panadería", [], "USD")).toContain("consulta");
    const t = orderText("Panadería", [{ name: "Pan", unitMinor: 150, qty: 2 }, { name: "Torta", unitMinor: 1000, qty: 0 }, { name: "Café", unitMinor: 300, qty: 1 }], "USD");
    expect(t).toBe("Hola, quiero hacer un pedido en Panadería:\n- 2 x Pan\n- 1 x Café\nTotal aproximado: $6");
    const link = waLink("584121234567", t);
    expect(link.startsWith("https://wa.me/584121234567?text=")).toBe(true);
    expect(decodeURIComponent(link.split("text=")[1]!)).toBe(t);
  });
});

describe("catálogo público: negocio", () => {
  it("guarda, valida y entrega enlace y QR; solo dueño o administrador", async () => {
    const t = await register("cfg");
    expect(await (await storeGet(api("GET", "/api/public-catalog", t.cookie))).json()).toMatchObject({ enabled: false, phone: "", products: 0 });
    expect((await put(t, { enabled: true, phone: "", intro: "" })).status).toBe(400); // publicar exige teléfono
    expect((await put(t, { enabled: false, phone: "0412 123", intro: "" })).status).toBe(400);
    expect((await put(t, { enabled: false, phone: "58412", intro: "" })).status).toBe(400);
    expect((await put(t, { enabled: true, phone: "58 412 1234567", intro: "x".repeat(301) })).status).toBe(400);
    expect((await put(t, { enabled: true, phone: "58 412 1234567", intro: "" }, "https://malo.example")).status).toBe(403);
    const ok = await put(t, { enabled: true, phone: "+58 412 123-4567", intro: "Entregas en la ciudad" });
    expect(ok.status).toBe(200);
    const slug = await slugOf(t);
    expect((await ok.json()).url).toBe(`${ORIGIN}/c/${slug}`);
    expect(await (await storeGet(api("GET", "/api/public-catalog", t.cookie))).json()).toMatchObject({ enabled: true, phone: "584121234567", intro: "Entregas en la ciudad" });
    const qr = await qrGet(api("GET", "/api/public-catalog/qr", t.cookie));
    expect(qr.status).toBe(200);
    expect(qr.headers.get("content-type")).toContain("image/svg+xml");
    expect(await qr.text()).toContain("<svg");
    const agent = await agentOf(t);
    expect((await storeGet(api("GET", "/api/public-catalog", agent))).status).toBe(403);
    expect((await put({ cookie: agent }, { enabled: false, phone: "", intro: "" })).status).toBe(403);
    expect((await qrGet(api("GET", "/api/public-catalog/qr", agent))).status).toBe(403);
    expect((await storeGet(api("GET", "/api/public-catalog"))).status).toBe(401);
  });
});

describe("catálogo público: la página de los clientes", () => {
  it("solo muestra productos activos, sin números de inventario, y solo si está publicado", async () => {
    const t = await register("pub");
    await addProduct(t, "Pan", { price: 150, stock: 20 });
    await addProduct(t, "Torta", { price: 1200, stock: 0 });
    await addProduct(t, "Oculto", { active: false });
    const slug = await slugOf(t);
    expect(await loadStore(slug)).toBeNull(); // todavía no publicado
    await put(t, { enabled: true, phone: "584121234567", intro: "Hola" });
    const s = (await loadStore(slug))!;
    expect(s).toMatchObject({ business: "Negocio pub", phone: "584121234567", intro: "Hola", currency: "USD" });
    expect(s.products.map((p) => [p.name, p.priceMinor, p.soldOut])).toEqual([["Pan", 150, false], ["Torta", 1200, true]]);
    expect(JSON.stringify(s)).not.toContain("stock");
    expect((await loadStore(slug.toUpperCase()))?.business).toBe("Negocio pub"); // el slug no distingue mayúsculas
    await put(t, { enabled: false, phone: "584121234567", intro: "Hola" });
    expect(await loadStore(slug)).toBeNull(); // apagarlo la quita al instante
  });
  it("no mezcla negocios; negocio suspendido, eliminación pedida, slug inválido o inexistente: nada", async () => {
    const a = await register("sa"), b = await register("sb");
    await addProduct(a, "Solo de A");
    await addProduct(b, "Solo de B");
    await put(a, { enabled: true, phone: "584121234567", intro: "" });
    await put(b, { enabled: true, phone: "584127654321", intro: "" });
    expect((await loadStore(await slugOf(a)))!.products.map((p) => p.name)).toEqual(["Solo de A"]);
    expect((await loadStore(await slugOf(b)))!.products.map((p) => p.name)).toEqual(["Solo de B"]);
    await oq(a, "UPDATE tenants SET status = 'suspended' WHERE id = $1", [a.tenantId]);
    expect(await loadStore(await slugOf(a))).toBeNull();
    await oq(b, "UPDATE tenants SET deletion_requested_at = now(), deletion_scheduled_for = now() + interval '7 days' WHERE id = $1", [b.tenantId]);
    expect(await loadStore(await slugOf(b))).toBeNull();
    for (const bad of ["no-existe-" + RUN, "../etc", "a", "'; drop table tenants;--", ""]) expect(await loadStore(bad)).toBeNull();
  });
  it("sin la función de búsqueda, la aplicación no puede leer la tabla pública", async () => {
    const t = await register("rls");
    await put(t, { enabled: true, phone: "584121234567", intro: "" });
    expect((await getPool().query("SELECT count(*)::int AS n FROM public_catalog")).rows[0].n).toBe(0);
    const f = await getPool().query("SELECT * FROM public_catalog_lookup($1)", [await slugOf(t)]);
    expect(f.rows).toHaveLength(1);
    expect(Object.keys(f.rows[0]).sort()).toEqual(["out_intro", "out_name", "out_phone", "out_tenant_id"]);
  });
});

describe("catálogo público: dirección inexistente", () => {
  const go = async (path: string) => (await proxy(new NextRequest(`${ORIGIN}${path}`))).headers.get("x-middleware-rewrite") ?? "";
  it("el proxy da 404 real a un catálogo que no existe o no está publicado, y deja pasar al publicado", async () => {
    const t = await register("px");
    const slug = await slugOf(t);
    expect(await go(`/c/${slug}`)).toMatch(/\/no-existe$/);
    expect(await go(`/c/no-existe-${RUN}`)).toMatch(/\/no-existe$/);
    await put(t, { enabled: true, phone: "584121234567", intro: "" });
    expect(await go(`/c/${slug}`)).toBe("");
    expect(await go(`/c/${slug}/otra/cosa`)).toBe(""); // otras rutas no se tocan aquí
  });
});
