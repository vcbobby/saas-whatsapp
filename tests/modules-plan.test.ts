import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { POST as agendaServices } from "@/app/api/agenda/services/route";
import { GET as agendaSlots } from "@/app/api/agenda/slots/route";
import { POST as products } from "@/app/api/catalog/products/route";
import { GET as orders } from "@/app/api/orders/route";
import { POST as copilot } from "@/app/api/copilot/route";
import { GET as automationsGet } from "@/app/api/automations/route";
import { GET as webhooksGet } from "@/app/api/webhooks/route";
import { GET as teamGet } from "@/app/api/team/route";
import { POST as signup } from "@/app/api/auth/signup/route";
import { GET as me } from "@/app/api/me/route";
import { getPool, withTenant } from "@/lib/db";
import { moduleForPermission, planModulesOf, tenantHasModule } from "@/lib/plans/modules";
import { layoutFor, loadModuleLayout } from "@/lib/modules";
import { buildSnapshot } from "@/lib/summary/snapshot";

const RUN = randomUUID().slice(0, 8);
const ORIGIN = new URL(process.env.APP_URL!).origin;
const owner = new Pool({ connectionString: process.env.MIGRATION_DATABASE_URL, max: 2 });
const tenantIds: string[] = [];
const planIds: string[] = [];
const req = (method: string, path: string, cookie: string, body?: unknown) =>
  new Request(`${ORIGIN}${path}`, { method, headers: { origin: ORIGIN, ...(body !== undefined ? { "content-type": "application/json" } : {}), cookie }, body: body !== undefined ? JSON.stringify(body) : undefined });

async function register(name: string) {
  const res = await signup(new Request(`${ORIGIN}/api/auth/signup`, { method: "POST", headers: { origin: ORIGIN, "content-type": "application/json" }, body: JSON.stringify({ email: `mp-${RUN}-${name}@example.test`, password: "contraseña-de-prueba-123", businessName: `Negocio ${name}` }) }));
  expect(res.status).toBe(201);
  const cookie = (res.headers.get("set-cookie") ?? "").split(";")[0]!;
  const info = await (await me(req("GET", "/api/me", cookie))).json();
  tenantIds.push(info.tenant.id);
  return { cookie, tenantId: info.tenant.id as string };
}
async function setModules(tenantId: string, modules: string[]) {
  const slug = `m-${RUN}-${planIds.length}`;
  const r = await owner.query<{ id: string }>("INSERT INTO plans (slug, name, position, max_replies_month, max_members, modules) VALUES ($1,$2,99,100,5,$3) RETURNING id", [slug, slug, modules]);
  planIds.push(r.rows[0]!.id);
  const c = await owner.connect();
  try {
    await c.query("BEGIN");
    await c.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
    await c.query("ALTER TABLE tenants DISABLE TRIGGER tenants_plan_guard");
    await c.query("UPDATE tenants SET plan_id = $2 WHERE id = $1", [tenantId, r.rows[0]!.id]);
    await c.query("ALTER TABLE tenants ENABLE TRIGGER tenants_plan_guard");
    await c.query("COMMIT");
  } catch (e) { await c.query("ROLLBACK"); throw e; } finally { c.release(); }
}
const MODS = ["agenda", "catalogo", "copiloto", "automatizaciones"];

beforeAll(async () => { await getPool().query("SELECT 1"); });
afterAll(async () => {
  await owner.query("DELETE FROM users WHERE email LIKE $1", [`mp-${RUN}-%`]);
  for (const id of tenantIds) {
    const c = await owner.connect();
    try {
      await c.query("BEGIN");
      await c.query("SELECT set_config('app.tenant_id', $1, true)", [id]);
      await c.query("ALTER TABLE audit_log DISABLE TRIGGER audit_log_sin_cambios");
      await c.query("DELETE FROM audit_log WHERE tenant_id = $1", [id]);
      await c.query("ALTER TABLE audit_log ENABLE TRIGGER audit_log_sin_cambios");
      await c.query("DELETE FROM tenants WHERE id = $1", [id]);
      await c.query("COMMIT");
    } catch (e) { await c.query("ROLLBACK"); throw e; } finally { c.release(); }
  }
  if (planIds.length) await owner.query("DELETE FROM plans WHERE id = ANY($1)", [planIds]);
  await owner.end();
});

describe("moduleForPermission", () => {
  it("mapea permisos a módulos y deja libres los demás", () => {
    expect(moduleForPermission("agenda:read")).toBe("agenda");
    expect(moduleForPermission("agenda:manage")).toBe("agenda");
    expect(moduleForPermission("catalog:manage")).toBe("catalogo");
    expect(moduleForPermission("orders:read")).toBe("catalogo");
    expect(moduleForPermission("orders:write")).toBe("catalogo");
    expect(moduleForPermission("copilot:use")).toBe("copiloto");
    expect(moduleForPermission("team:manage" as never)).toBeNull();
    expect(moduleForPermission(undefined)).toBeNull();
  });
});

describe("API cerrada si el plan no incluye el módulo", () => {
  const calls: Array<[string, string, (c: string) => Promise<Response>]> = [
    ["agenda", "agenda services", (c) => agendaServices(req("POST", "/api/agenda/services", c, {}))],
    ["agenda", "agenda slots", (c) => agendaSlots(req("GET", "/api/agenda/slots", c))],
    ["catalogo", "catalog products", (c) => products(req("POST", "/api/catalog/products", c, {}))],
    ["catalogo", "orders", (c) => orders(req("GET", "/api/orders", c))],
    ["copiloto", "copilot", (c) => copilot(req("POST", "/api/copilot", c, { message: "hola" }))],
    ["automatizaciones", "automations", (c) => automationsGet(req("GET", "/api/automations", c))],
    ["automatizaciones", "webhooks", (c) => webhooksGet(req("GET", "/api/webhooks", c))],
  ];
  it.each(calls)("%s: %s → 403 sin módulo, no 403 con módulo", async (mod, _n, call) => {
    const t = await register(`api-${mod}-${_n.replace(/\W/g, "")}`);
    await setModules(t.tenantId, MODS.filter((m) => m !== mod));
    const res = await call(t.cookie);
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe("modulo_no_incluido");
    await setModules(t.tenantId, [mod]);
    const ok = await call(t.cookie);
    expect(ok.status).not.toBe(403);
  });

  it("lo que no es de un módulo sigue funcionando sin ningún módulo", async () => {
    const t = await register("libre");
    await setModules(t.tenantId, []);
    expect((await teamGet(req("GET", "/api/team", t.cookie))).status).toBe(200);
  });
});

describe("SQL: automatizaciones y entregas dependen del módulo", () => {
  it("sin módulo emit_event no crea entregas ni reglas; con módulo sí", async () => {
    const t = await register("sql");
    await setModules(t.tenantId, ["agenda"]);
    await withTenant(t.tenantId, (db) => db.query("INSERT INTO webhook_endpoints (tenant_id, url, events, secret_enc, key_version) VALUES ($1,'https://8.8.8.8/h',ARRAY['order.created'],'x',1)", [t.tenantId]));
    const emit = () => withTenant(t.tenantId, (db) => db.query("SELECT emit_event($1,'order.created','{}'::jsonb)", [t.tenantId]));
    const count = () => withTenant(t.tenantId, async (db) => Number((await db.query("SELECT count(*) AS n FROM webhook_deliveries WHERE tenant_id = $1", [t.tenantId])).rows[0].n));
    await emit();
    expect(await count()).toBe(0);
    await setModules(t.tenantId, ["automatizaciones"]);
    await emit();
    expect(await count()).toBe(1);
  });
  it("run_time_automations devuelve 0 sin módulo", async () => {
    const t = await register("tick");
    await setModules(t.tenantId, []);
    const n = await withTenant(t.tenantId, async (db) => Number((await db.query("SELECT run_time_automations($1) AS n", [t.tenantId])).rows[0].n));
    expect(n).toBe(0);
  });
  it("un negocio que no existe no tiene ningún módulo (cerrado por defecto)", async () => {
    expect(await planModulesOf(randomUUID())).toEqual([]);
    expect(await tenantHasModule(randomUUID(), "agenda")).toBe(false);
  });
  it("tenant_has_module", async () => {
    const t = await register("has");
    await setModules(t.tenantId, ["copiloto"]);
    expect(await tenantHasModule(t.tenantId, "copiloto")).toBe(true);
    expect(await tenantHasModule(t.tenantId, "agenda")).toBe(false);
    expect(await planModulesOf(t.tenantId)).toEqual(["copiloto"]);
    const r = await withTenant(t.tenantId, async (db) => (await db.query("SELECT tenant_has_module($1,'copiloto') a, tenant_has_module($1,'agenda') b", [t.tenantId])).rows[0]);
    expect(r).toEqual({ a: true, b: false });
  });
});

describe("resumen y menú", () => {
  it("el resumen omite agenda y pedidos si el plan no los incluye (aunque haya datos)", async () => {
    const t = await register("snap");
    await withTenant(t.tenantId, async (db) => {
      await db.query("INSERT INTO agenda_services (tenant_id, name, duration_minutes) VALUES ($1,'Corte',30)", [t.tenantId]);
      await db.query("INSERT INTO catalog_products (tenant_id, name, price_minor, stock) VALUES ($1,'Torta',500,NULL)", [t.tenantId]);
    });
    await setModules(t.tenantId, MODS);
    const con = await withTenant(t.tenantId, (db) => buildSnapshot(db, t.tenantId));
    expect(con.agenda).not.toBeNull();
    expect(con.orders).not.toBeNull();
    await setModules(t.tenantId, ["copiloto"]);
    const sin = await withTenant(t.tenantId, (db) => buildSnapshot(db, t.tenantId));
    expect(sin.agenda).toBeNull();
    expect(sin.orders).toBeNull();
  });
  it("layoutFor respeta allowed y team", () => {
    const base = { type: "citas" as const, hasServices: true, hasProducts: true };
    expect(layoutFor({ ...base, allowed: [] })).toEqual({ main: [], more: [], team: { copiloto: false, automatizaciones: false } });
    expect(layoutFor({ ...base, allowed: ["catalogo"] })).toMatchObject({ main: ["catalogo", "pedidos"], team: { copiloto: false, automatizaciones: false } });
    expect(layoutFor({ ...base, allowed: ["agenda", "copiloto"] })).toMatchObject({ main: ["agenda"], team: { copiloto: true, automatizaciones: false } });
    expect(layoutFor(base).team).toEqual({ copiloto: true, automatizaciones: true });
  });
  it("loadModuleLayout usa los módulos del plan", async () => {
    const t = await register("lay");
    await setModules(t.tenantId, ["automatizaciones"]);
    const l = await withTenant(t.tenantId, (db) => loadModuleLayout(db, t.tenantId));
    expect(l.main).toEqual([]);
    expect(l.more).toEqual([]);
    expect(l.team).toEqual({ copiloto: false, automatizaciones: true });
  });
});

describe("plan por defecto", () => {
  it("'prueba' es el plan por defecto y trae los 4 módulos", async () => {
    const r = await owner.query("SELECT modules, is_default FROM plans WHERE slug = 'prueba'");
    expect(r.rows[0].is_default).toBe(true);
    expect([...r.rows[0].modules].sort()).toEqual([...MODS].sort());
    const d = await owner.query("SELECT count(*)::int n FROM plans WHERE is_default");
    expect(d.rows[0].n).toBe(1);
  });
});
