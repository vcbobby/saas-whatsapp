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
import { CURRENCIES, MAX_MINOR, formatMoney, minorToInput, parseMoney } from "@/lib/catalog/money";
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
  const email = `ct-${RUN}-${name}@example.test`;
  const res = await signup(api("POST", "/api/auth/signup", undefined, { email, password: PASSWORD, businessName: `Negocio ${name}` }));
  expect(res.status).toBe(201);
  const cookie = (res.headers.get("set-cookie") ?? "").split(";")[0]!;
  const info = await (await me(api("GET", "/api/me", cookie))).json();
  tenantIds.push(info.tenant.id);
  return { tenantId: info.tenant.id as string, cookie };
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
  const inv = await teamInvite(api("POST", "/api/team/invite", t.cookie, { email: `ct-${RUN}-${role}-${randomUUID().slice(0, 6)}@example.test`, role }));
  expect(inv.status).toBe(201);
  const token = ((await inv.json()).inviteUrl as string).split("/").pop()!;
  const ok = await inviteSignup(api("POST", "/api/invitations/signup", undefined, { token, password: PASSWORD }));
  expect(ok.status).toBe(201);
  return { tenantId: t.tenantId, cookie: (ok.headers.get("set-cookie") ?? "").split(";")[0]! };
}

beforeAll(async () => { await getPool().query("SELECT 1"); });
afterAll(async () => {
  await owner.query("DELETE FROM users WHERE email LIKE $1", [`ct-${RUN}-%`]);
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

describe("dinero", () => {
  it("lee precios escritos por personas", () => {
    expect(parseMoney("10")).toBe(1000);
    expect(parseMoney("10.5")).toBe(1050);
    expect(parseMoney("10,50")).toBe(1050);
    expect(parseMoney("0")).toBe(0);
    expect(parseMoney("0,05")).toBe(5);
    expect(parseMoney("1,5")).toBe(150);
    expect(parseMoney("  7  ")).toBe(700);
    expect(parseMoney("100000000")).toBe(MAX_MINOR);
  });
  it("rechaza lo ambiguo o inválido (miles, 3 decimales, signos, letras, demasiado grande)", () => {
    for (const bad of ["", " ", "-1", "+1", "1.250", "1,234", "1.250,50", "10,", ",5", "abc", "1e3", "10.555", "$10", "10 USD", "100000000,01", "99999999999", "٣٤"]) expect(parseMoney(bad), bad).toBeNull();
  });
  it("muestra el dinero con coma decimal y puntos de miles, sin decimales si son cero", () => {
    expect(formatMoney(1050, "USD")).toBe("$10,50");
    expect(formatMoney(1000, "USD")).toBe("$10");
    expect(formatMoney(5, "USD")).toBe("$0,05");
    expect(formatMoney(123456789, "USD")).toBe("$1.234.567,89");
    expect(formatMoney(0, "USD")).toBe("$0");
    expect(formatMoney(50000, "VES")).toBe("Bs. 500");
    expect(formatMoney(1990, "EUR")).toBe("€19,90");
  });
  it("lo que se muestra al editar vuelve a leerse igual", () => {
    for (const minor of [0, 1, 5, 99, 100, 101, 1050, 123456, MAX_MINOR]) expect(parseMoney(minorToInput(minor)), String(minor)).toBe(minor);
  });
  it("todas las monedas tienen símbolo", () => {
    for (const c of CURRENCIES) expect(formatMoney(100, c).length).toBeGreaterThan(1);
  });
  it("ver el catálogo es de todos los roles; cambiarlo, solo dueño y administrador", () => {
    for (const r of ["owner", "admin", "agent"] as const) expect(can(r, "catalog:read")).toBe(true);
    expect(can("owner", "catalog:manage")).toBe(true);
    expect(can("admin", "catalog:manage")).toBe(true);
    expect(can("agent", "catalog:manage")).toBe(false);
    expect(can(null, "catalog:read")).toBe(false);
  });
});

describe("productos", () => {
  it("empieza vacío en dólares y el dueño puede gestionar", async () => {
    const t = await register("vacio");
    expect(await config(t)).toEqual({ currency: "USD", products: [], canManage: true });
  });

  it("crea un producto y lo devuelve con el precio como entero en la unidad menor", async () => {
    const t = await register("crea");
    const res = await create(t, { name: "Harina de maíz", priceMinor: 1050, unit: "paquete de 1 kg", description: "Precocida", stock: 20 });
    expect(res.status).toBe(201);
    const c = await config(t);
    expect(c.products).toEqual([{ id: expect.any(String), name: "Harina de maíz", description: "Precocida", unit: "paquete de 1 kg", priceMinor: 1050, stock: 20, active: true }]);
  });

  it("stock vacío = sin control; cero = agotado; lo opcional vacío se guarda como nulo", async () => {
    const t = await register("stock");
    await create(t, { name: "A" });
    await create(t, { name: "B", stock: 0, unit: "  ", description: "" });
    const p = Object.fromEntries((await config(t)).products.map((x) => [x.name, x]));
    expect(p.A!.stock).toBeNull();
    expect(p.B!.stock).toBe(0);
    expect(p.B!.unit).toBeNull();
    expect(p.B!.description).toBeNull();
  });

  it("acepta precio cero y el máximo; guarda el máximo sin perder exactitud", async () => {
    const t = await register("limites");
    expect((await create(t, { name: "Gratis", priceMinor: 0 })).status).toBe(201);
    expect((await create(t, { name: "Caro", priceMinor: MAX_MINOR })).status).toBe(201);
    const c = await config(t);
    expect(c.products.find((x) => x.name === "Caro")!.priceMinor).toBe(MAX_MINOR);
  });

  it("rechaza datos inválidos con 400 y no guarda nada", async () => {
    const t = await register("invalidos");
    const bads: Record<string, unknown>[] = [
      { name: "" }, { name: "   " }, { name: "x".repeat(121) },
      { name: "A", priceMinor: -1 }, { name: "A", priceMinor: 10.5 }, { name: "A", priceMinor: "1000" }, { name: "A", priceMinor: MAX_MINOR + 1 }, { name: "A", priceMinor: null },
      { name: "A", stock: -1 }, { name: "A", stock: 1.5 }, { name: "A", stock: 1_000_001 }, { name: "A", stock: "5" },
      { name: "A", unit: "x".repeat(41) }, { name: "A", description: "x".repeat(501) },
    ];
    for (const b of bads) expect((await create(t, b)).status, JSON.stringify(b).slice(0, 60)).toBe(400);
    expect((await send(createProduct, "/api/catalog/products", t, { name: "Sin precio" })).status).toBe(400);
    expect((await config(t)).products).toHaveLength(0);
  });

  it("guarda tal cual nombres con acentos, emojis y etiquetas (la pantalla los escapa)", async () => {
    const t = await register("texto");
    const name = "Café ☕ <b>Ñandú</b> & \"comillas\"";
    expect((await create(t, { name })).status).toBe(201);
    expect((await config(t)).products[0]!.name).toBe(name);
  });

  it("no permite dos productos activos con el mismo nombre (ni cambiando mayúsculas); desactivar libera el nombre", async () => {
    const t = await register("dup");
    const a = await idOf(await create(t, { name: "Queso" }));
    const dup = await create(t, { name: "  queso " });
    expect(dup.status).toBe(409);
    expect((await dup.json()).error).toBe("producto_duplicado");
    expect((await update(t, { id: a, active: false })).status).toBe(200);
    const b = await idOf(await create(t, { name: "QUESO" }));
    // Reactivar el viejo chocaría con el nuevo.
    const re = await update(t, { id: a, active: true });
    expect(re.status).toBe(409);
    expect((await update(t, { id: b, active: false })).status).toBe(200);
    expect((await update(t, { id: a, active: true })).status).toBe(200);
  });

  it("al renombrar a un nombre ya usado responde 409", async () => {
    const t = await register("ren");
    await create(t, { name: "Uno" });
    const two = await idOf(await create(t, { name: "Dos" }));
    expect((await update(t, { id: two, name: "uno" })).status).toBe(409);
    expect((await update(t, { id: two, name: "Tres" })).status).toBe(200);
  });

  it("la lista pone primero los activos y ordena por nombre sin importar mayúsculas", async () => {
    const t = await register("orden");
    const z = await idOf(await create(t, { name: "zanahoria" }));
    await create(t, { name: "Banano" });
    await create(t, { name: "arroz" });
    await update(t, { id: z, active: false });
    const names = (await config(t)).products.map((p) => `${p.name}:${p.active}`);
    expect(names).toEqual(["arroz:true", "Banano:true", "zanahoria:false"]);
  });
});

describe("cambios", () => {
  it("un cambio parcial solo toca lo enviado", async () => {
    const t = await register("parcial");
    const id = await idOf(await create(t, { name: "Aceite", priceMinor: 500, unit: "litro", description: "Girasol", stock: 9 }));
    expect((await update(t, { id, priceMinor: 650 })).status).toBe(200);
    expect((await config(t)).products[0]).toMatchObject({ name: "Aceite", priceMinor: 650, unit: "litro", description: "Girasol", stock: 9, active: true });
  });

  it("null borra descripción, presentación y stock (sin control); un texto vacío también", async () => {
    const t = await register("nulos");
    const id = await idOf(await create(t, { name: "Aceite", unit: "litro", description: "Girasol", stock: 9 }));
    expect((await update(t, { id, description: null, unit: "", stock: null })).status).toBe(200);
    expect((await config(t)).products[0]).toMatchObject({ description: null, unit: null, stock: null });
  });

  it("el stock puede ponerse en cero y volver a un número", async () => {
    const t = await register("stock2");
    const id = await idOf(await create(t, { name: "Pan", stock: 3 }));
    await update(t, { id, stock: 0 });
    expect((await config(t)).products[0]!.stock).toBe(0);
    await update(t, { id, stock: 12 });
    expect((await config(t)).products[0]!.stock).toBe(12);
  });

  it("rechaza cambios inválidos y no modifica nada", async () => {
    const t = await register("cambio-mal");
    const id = await idOf(await create(t, { name: "Pan", priceMinor: 300, stock: 3 }));
    for (const b of [{ priceMinor: -5 }, { priceMinor: 1.5 }, { stock: -1 }, { name: "" }, { active: "si" }, { unit: "x".repeat(41) }, { id: "no-es-uuid" }]) {
      expect((await update(t, { id, ...b })).status, JSON.stringify(b)).toBe(400);
    }
    expect((await config(t)).products[0]).toMatchObject({ name: "Pan", priceMinor: 300, stock: 3 });
  });

  it("un producto que no existe da 404", async () => {
    const t = await register("404");
    expect((await update(t, { id: randomUUID(), priceMinor: 1 })).status).toBe(404);
  });

  it("desactivar y activar conserva los datos; los productos no se borran", async () => {
    const t = await register("onoff");
    const id = await idOf(await create(t, { name: "Pan", priceMinor: 300 }));
    await update(t, { id, active: false });
    expect((await config(t)).products[0]).toMatchObject({ active: false, priceMinor: 300 });
    await update(t, { id, active: true });
    expect((await config(t)).products[0]).toMatchObject({ active: true, priceMinor: 300 });
  });
});

describe("límites y moneda", () => {
  it("máximo 500 productos activos: no deja crear ni reactivar de más; desactivar libera lugar", async () => {
    const t = await register("tope");
    await withTenant(t.tenantId, (db) => db.query("INSERT INTO catalog_products (tenant_id, name, price_minor) SELECT $1, 'P' || g, 100 FROM generate_series(1, 500) g", [t.tenantId]));
    const res = await create(t, { name: "Uno más" });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("limite_productos");
    const first = (await config(t)).products[0]!;
    await update(t, { id: first.id, active: false });
    const ok = await create(t, { name: "Uno más" });
    expect(ok.status).toBe(201);
    expect((await update(t, { id: first.id, active: true })).status).toBe(409);
  });

  it("cambiar la moneda no cambia los montos", async () => {
    const t = await register("moneda");
    await create(t, { name: "Pan", priceMinor: 1050 });
    expect((await send(putSettings, "/api/catalog/settings", t, { currency: "VES" }, "PUT")).status).toBe(200);
    let c = await config(t);
    expect(c.currency).toBe("VES");
    expect(c.products[0]!.priceMinor).toBe(1050);
    expect((await send(putSettings, "/api/catalog/settings", t, { currency: "EUR" }, "PUT")).status).toBe(200);
    c = await config(t);
    expect(c.currency).toBe("EUR");
  });

  it("monedas desconocidas se rechazan", async () => {
    const t = await register("moneda-mal");
    for (const currency of ["XXX", "usd", "", null, 5]) expect((await send(putSettings, "/api/catalog/settings", t, { currency }, "PUT")).status, String(currency)).toBe(400);
    expect((await config(t)).currency).toBe("USD");
  });

  it("la base de datos también protege: precio o stock negativos y monedas raras no entran", async () => {
    const t = await register("db");
    const run = async (sql: string, args: unknown[]) => withTenant(t.tenantId, async (db) => {
      try { await db.query("SAVEPOINT s"); await db.query(sql, args); return null; } catch (e) { return (e as { code?: string }).code; }
    });
    expect(await run("INSERT INTO catalog_products (tenant_id, name, price_minor) VALUES ($1, 'A', -1)", [t.tenantId])).toBe("23514");
    expect(await run("INSERT INTO catalog_products (tenant_id, name, price_minor, stock) VALUES ($1, 'B', 1, -1)", [t.tenantId])).toBe("23514");
    expect(await run("INSERT INTO catalog_products (tenant_id, name, price_minor) VALUES ($1, 'C', 10000000001)", [t.tenantId])).toBe("23514");
    expect(await run("INSERT INTO catalog_settings (tenant_id, currency) VALUES ($1, 'ZZZ')", [t.tenantId])).toBe("23514");
  });
});

describe("seguridad", () => {
  it("sin sesión: 401 en todo", async () => {
    expect((await getConfig(api("GET", "/api/catalog/config"))).status).toBe(401);
    expect((await send(createProduct, "/api/catalog/products", null, { name: "A", priceMinor: 1 })).status).toBe(401);
    expect((await send(updateProduct, "/api/catalog/products/update", null, { id: randomUUID() })).status).toBe(401);
    expect((await send(putSettings, "/api/catalog/settings", null, { currency: "USD" }, "PUT")).status).toBe(401);
  });

  it("rechaza peticiones desde otros sitios (CSRF) y no cambia nada", async () => {
    const t = await register("csrf");
    const evil = "https://evil.example";
    expect((await send(createProduct, "/api/catalog/products", t, { name: "A", priceMinor: 1 }, "POST", evil)).status).toBe(403);
    const id = await idOf(await create(t, { name: "Pan", priceMinor: 300 }));
    expect((await send(updateProduct, "/api/catalog/products/update", t, { id, priceMinor: 1 }, "POST", evil)).status).toBe(403);
    expect((await send(putSettings, "/api/catalog/settings", t, { currency: "VES" }, "PUT", evil)).status).toBe(403);
    const c = await config(t);
    expect(c.products).toHaveLength(1);
    expect(c.products[0]!.priceMinor).toBe(300);
    expect(c.currency).toBe("USD");
  });

  it("los negocios no se ven entre sí ni pueden tocarse los productos", async () => {
    const a = await register("isoA");
    const b = await register("isoB");
    const pa = await idOf(await create(a, { name: "Secreto de A", priceMinor: 777 }));
    await create(b, { name: "De B" });
    expect((await config(b)).products.map((p) => p.name)).toEqual(["De B"]);
    expect((await update(b, { id: pa, priceMinor: 1, active: false, name: "Hackeado" })).status).toBe(404);
    expect((await config(a)).products[0]).toMatchObject({ name: "Secreto de A", priceMinor: 777, active: true });
    // Aunque B pida las filas de A directo a la base, el aislamiento por negocio no se las muestra.
    const seen = await withTenant(b.tenantId, async (db) => (await db.query("SELECT count(*)::int AS n FROM catalog_products WHERE tenant_id = $1", [a.tenantId])).rows[0].n as number);
    expect(seen).toBe(0);
    // Tampoco la moneda: cada negocio tiene la suya.
    await send(putSettings, "/api/catalog/settings", a, { currency: "VES" }, "PUT");
    expect((await config(b)).currency).toBe("USD");
  });

  it("un negocio no puede crear productos a nombre de otro", async () => {
    const a = await register("forjaA");
    const b = await register("forjaB");
    const err = await withTenant(a.tenantId, async (db) => {
      try { await db.query("SAVEPOINT s"); await db.query("INSERT INTO catalog_products (tenant_id, name, price_minor) VALUES ($1, 'Falso', 1)", [b.tenantId]); return null; } catch (e) { return (e as { code?: string }).code; }
    });
    expect(err).toBe("42501");
    expect((await config(b)).products).toHaveLength(0);
  });

  it("un agente puede ver el catálogo pero no cambiarlo; un administrador sí", async () => {
    const o = await register("roles");
    const id = await idOf(await create(o, { name: "Pan", priceMinor: 300 }));
    const ag = await member(o, "agent");
    const view = await config(ag);
    expect(view.canManage).toBe(false);
    expect(view.products).toHaveLength(1);
    expect((await create(ag, { name: "Nuevo" })).status).toBe(403);
    expect((await update(ag, { id, priceMinor: 1, active: false })).status).toBe(403);
    expect((await send(putSettings, "/api/catalog/settings", ag, { currency: "VES" }, "PUT")).status).toBe(403);
    const after = await config(o);
    expect(after.products).toHaveLength(1);
    expect(after.products[0]).toMatchObject({ priceMinor: 300, active: true });
    expect(after.currency).toBe("USD");

    const ad = await member(o, "admin");
    expect((await config(ad)).canManage).toBe(true);
    expect((await create(ad, { name: "Del admin" })).status).toBe(201);
    expect((await update(ad, { id, priceMinor: 400 })).status).toBe(200);
  });
});
