import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { POST as signup } from "@/app/api/auth/signup/route";
import { GET as me } from "@/app/api/me/route";
import { getPool, withTenant } from "@/lib/db";
import { layoutFor, loadModuleLayout } from "@/lib/modules";

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
  const email = `md-${RUN}-${name}@example.test`;
  const res = await signup(api("POST", "/api/auth/signup", undefined, { email, password: PASSWORD, businessName: `Negocio ${name}` }));
  expect(res.status).toBe(201);
  const cookie = (res.headers.get("set-cookie") ?? "").split(";")[0]!;
  const info = await (await me(api("GET", "/api/me", cookie))).json();
  tenantIds.push(info.tenant.id);
  return { tenantId: info.tenant.id as string, cookie };
}
type T = Awaited<ReturnType<typeof register>>;

beforeAll(async () => { await getPool().query("SELECT 1"); });
afterAll(async () => {
  await owner.query("DELETE FROM users WHERE email LIKE $1", [`md-${RUN}-%`]);
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



afterEach(() => { vi.unstubAllEnvs(); });




async function setType(t: T, type: string) {
  await withTenant(t.tenantId, (db) => db.query(
    `INSERT INTO tenant_agents (tenant_id, enabled, assistant_name, instructions, business_type) VALUES ($1,false,'Asistente','x',$2)
     ON CONFLICT (tenant_id) DO UPDATE SET business_type = EXCLUDED.business_type`, [t.tenantId, type]));
}
const load = (t: T) => withTenant(t.tenantId, (db) => loadModuleLayout(db, t.tenantId));

describe("layoutFor (reglas puras)", () => {
  it.each<[string, { type: "citas" | "catalogo" | "atencion"; hasServices: boolean; hasProducts: boolean }, string[], string[]]>([
    ["citas", { type: "citas", hasServices: false, hasProducts: false }, ["agenda"], ["catalogo", "pedidos"]],
    ["catálogo", { type: "catalogo", hasServices: false, hasProducts: false }, ["catalogo", "pedidos"], ["agenda"]],
    ["solo atención", { type: "atencion", hasServices: false, hasProducts: false }, [], ["agenda", "catalogo", "pedidos"]],
    ["atención pero ya tiene servicios", { type: "atencion", hasServices: true, hasProducts: false }, ["agenda"], ["catalogo", "pedidos"]],
    ["atención pero ya tiene productos", { type: "atencion", hasServices: false, hasProducts: true }, ["catalogo", "pedidos"], ["agenda"]],
    ["citas y además vende", { type: "citas", hasServices: false, hasProducts: true }, ["agenda", "catalogo", "pedidos"], []],
    ["catálogo y además agenda", { type: "catalogo", hasServices: true, hasProducts: false }, ["agenda", "catalogo", "pedidos"], []],
  ])("%s", (_n, u, main, more) => {
    expect(layoutFor(u)).toEqual({ main, more });
  });
  it("todo módulo está en la barra o en «Más», nunca en ninguno ni en ambos", () => {
    for (const type of ["citas", "catalogo", "atencion"] as const) for (const hasServices of [true, false]) for (const hasProducts of [true, false]) {
      const l = layoutFor({ type, hasServices, hasProducts });
      expect([...l.main, ...l.more].sort()).toEqual(["agenda", "catalogo", "pedidos"]);
    }
  });
});

describe("loadModuleLayout (base de datos)", () => {
  it("negocio nuevo sin asistente configurado = solo atención: todo en «Más»", async () => {
    const t = await register("nuevo");
    expect(await load(t)).toEqual({ main: [], more: ["agenda", "catalogo", "pedidos"] });
  });
  it("sigue el tipo elegido en el asistente", async () => {
    const t = await register("tipo");
    await setType(t, "citas");
    expect((await load(t)).main).toEqual(["agenda"]);
    await setType(t, "catalogo");
    expect((await load(t)).main).toEqual(["catalogo", "pedidos"]);
  });
  it("un servicio o un producto activos hacen aparecer su módulo aunque el tipo sea otro", async () => {
    const t = await register("datos");
    await setType(t, "atencion");
    await withTenant(t.tenantId, (db) => db.query("INSERT INTO agenda_services (tenant_id, name, duration_minutes) VALUES ($1,'Corte',30)", [t.tenantId]));
    expect((await load(t)).main).toEqual(["agenda"]);
    await withTenant(t.tenantId, (db) => db.query("INSERT INTO catalog_products (tenant_id, name, price_minor, stock) VALUES ($1,'Arroz',250,NULL)", [t.tenantId]));
    expect((await load(t)).main).toEqual(["agenda", "catalogo", "pedidos"]);
  });
  it("un servicio desactivado ya no cuenta", async () => {
    const t = await register("inact");
    await withTenant(t.tenantId, (db) => db.query("INSERT INTO agenda_services (tenant_id, name, duration_minutes, active) VALUES ($1,'Corte',30,false)", [t.tenantId]));
    expect((await load(t)).main).toEqual([]);
  });
  it("los negocios no se mezclan", async () => {
    const a = await register("iso-a");
    const b = await register("iso-b");
    await setType(a, "citas");
    expect((await load(a)).main).toEqual(["agenda"]);
    expect((await load(b)).main).toEqual([]);
  });
  it("un valor raro guardado se trata como solo atención", async () => {
    const t = await register("raro");
    await setType(t, "atencion");
    expect(await load(t)).toEqual({ main: [], more: ["agenda", "catalogo", "pedidos"] });
  });
});
