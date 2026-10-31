import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { POST as login } from "@/app/api/auth/login/route";
import { POST as verify2fa } from "@/app/api/auth/2fa/verify/route";
import { POST as signup } from "@/app/api/auth/signup/route";
import { GET as me } from "@/app/api/me/route";
import { POST as teamInvite } from "@/app/api/team/invite/route";
import { POST as inviteSignup } from "@/app/api/invitations/signup/route";
import { GET as demoGet, POST as demoPost } from "@/app/api/demo/route";
import { POST as feedbackPost } from "@/app/api/feedback/route";
import { getAdminFeedback } from "@/lib/admin/feedback";
import { buildReport } from "@/lib/reports/build";
import { hashPassword } from "@/lib/auth/password";
import { getPool, withTenant } from "@/lib/db";
import { createHash } from "node:crypto";
import { codeFor, enableMfaDirect } from "./mfa-helpers";

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
  const email = `dm-${RUN}-${name}@example.test`;
  const res = await signup(api("POST", "/api/auth/signup", undefined, { email, password: PASSWORD, businessName: `Negocio ${name}` }));
  expect(res.status).toBe(201);
  const cookie = (res.headers.get("set-cookie") ?? "").split(";")[0]!;
  const info = await (await me(api("GET", "/api/me", cookie))).json();
  tenantIds.push(info.tenant.id);
  return { tenantId: info.tenant.id as string, cookie, email };
}
type T = Awaited<ReturnType<typeof register>>;
async function agentOf(t: T) {
  const email = `dm-${RUN}-ag-${randomUUID().slice(0, 6)}@example.test`;
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
const demo = (t: { cookie: string }, action: "load" | "clear", origin = ORIGIN) => demoPost(api("POST", "/api/demo", t.cookie, { action }, origin));
const fb = (t: { cookie: string }, b: unknown, origin = ORIGIN) => feedbackPost(api("POST", "/api/feedback", t.cookie, b, origin));

beforeAll(async () => { await getPool().query("SELECT 1"); });
afterAll(async () => {
  await owner.query("DELETE FROM users WHERE email LIKE $1", [`dm-${RUN}-%`]);
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

const count = async (t: T, table: string) => (await oq(t, `SELECT count(*)::int AS n FROM ${table} WHERE tenant_id = $1`, [t.tenantId])).rows[0].n as number;

describe("datos de ejemplo", () => {
  it("carga todo marcado, sin avisos, con totales correctos y se ve en el reporte", async () => {
    const t = await register("carga");
    expect((await (await demoGet(api("GET", "/api/demo", t.cookie))).json()).present).toBe(false);
    expect((await demo(t, "load")).status).toBe(200);
    expect(await (await demoGet(api("GET", "/api/demo", t.cookie))).json()).toMatchObject({ present: true, contacts: 4, products: 3, services: 1, orders: 3 });
    expect(await count(t, "conversations")).toBe(4);
    expect(await count(t, "appointments")).toBe(2);
    const off = await oq(t, "SELECT count(*)::int AS n FROM contacts WHERE tenant_id = $1 AND notifications_off AND demo AND wa_id LIKE '58000%'", [t.tenantId]);
    expect(off.rows[0].n).toBe(4);
    expect((await oq(t, "SELECT count(*)::int AS n FROM contacts WHERE tenant_id = $1 AND promo_consent_at IS NOT NULL", [t.tenantId])).rows[0].n).toBe(0);
    // Los pedidos de ejemplo suman sus líneas (si no, la base los rechazaría al guardar).
    const o = await oq(t, "SELECT count(*)::int AS n, sum(total_minor)::int AS total FROM orders WHERE tenant_id = $1", [t.tenantId]);
    expect(o.rows[0]).toEqual({ n: 3, total: 2400 + 3300 + 16000 });
    const r = await withTenant(t.tenantId, (db) => buildReport(db, t.tenantId, 7));
    expect(r.inbound.current).toBeGreaterThan(0);
    expect(r.sales.length).toBe(1);
    const log = await oq(t, "SELECT count(*)::int AS n FROM audit_log WHERE tenant_id = $1 AND action = 'demo.load'", [t.tenantId]);
    expect(log.rows[0].n).toBe(1);
  });

  it("no se carga dos veces; borrar quita solo lo de ejemplo y deja lo real intacto", async () => {
    const t = await register("borra");
    await oq(t, "INSERT INTO contacts (tenant_id, wa_id, display_name) VALUES ($1,'584129998877','Cliente real')", [t.tenantId]);
    await oq(t, "INSERT INTO catalog_products (tenant_id, name, price_minor) VALUES ($1,'Producto real',500)", [t.tenantId]);
    await oq(t, "INSERT INTO agenda_services (tenant_id, name, duration_minutes) VALUES ($1,'Servicio real',30)", [t.tenantId]);
    expect((await demo(t, "load")).status).toBe(200);
    expect((await demo(t, "load")).status).toBe(409);
    expect((await demo(t, "clear")).status).toBe(200);
    expect(await (await demoGet(api("GET", "/api/demo", t.cookie))).json()).toMatchObject({ present: false, contacts: 0, orders: 0 });
    expect(await count(t, "contacts")).toBe(1);
    expect(await count(t, "catalog_products")).toBe(1);
    expect(await count(t, "agenda_services")).toBe(1);
    for (const tb of ["conversations", "messages", "orders", "order_items", "appointments", "work_items"]) expect(await count(t, tb)).toBe(0);
    expect((await demo(t, "load")).status).toBe(200); // y se puede volver a cargar
  });

  it("permisos, origen y aislamiento", async () => {
    const t = await register("perm");
    const agent = await agentOf(t);
    expect((await demo({ cookie: agent }, "load")).status).toBe(403);
    expect((await demoGet(api("GET", "/api/demo", agent))).status).toBe(403);
    expect((await demo(t, "load", "https://malo.example")).status).toBe(403);
    expect((await demoPost(api("POST", "/api/demo", t.cookie, { action: "otra" }))).status).toBe(400);
    expect((await demoGet(api("GET", "/api/demo"))).status).toBe(401);
    await demo(t, "load");
    const other = await register("ajeno");
    expect((await (await demoGet(api("GET", "/api/demo", other.cookie))).json()).present).toBe(false);
    await demo(other, "clear"); // borrar en el otro negocio no toca el de este
    expect((await (await demoGet(api("GET", "/api/demo", t.cookie))).json()).present).toBe(true);
  });
});

describe("comentarios", () => {
  it("cualquier persona del equipo puede enviar; se valida y se registra de quién y desde qué pantalla", async () => {
    const t = await register("fb");
    const agent = await agentOf(t);
    expect((await fb(t, { kind: "idea", message: "Me gustaría ver las ventas por semana", page: "/reportes" })).status).toBe(201);
    expect((await fb({ cookie: agent }, { kind: "problema", message: "No me carga la bandeja" })).status).toBe(201);
    expect((await fb(t, { kind: "idea", message: "ab" })).status).toBe(400);
    expect((await fb(t, { kind: "queja", message: "texto largo suficiente" })).status).toBe(400);
    expect((await fb(t, { kind: "idea", message: "x".repeat(2001) })).status).toBe(400);
    expect((await fb(t, { kind: "idea", message: "página rara", page: "javascript:alert(1)" })).status).toBe(400);
    expect((await fb(t, { kind: "idea", message: "hola mundo" }, "https://malo.example")).status).toBe(403);
    expect((await feedbackPost(api("POST", "/api/feedback", undefined, { kind: "idea", message: "sin sesión" }))).status).toBe(401);
    const rows = (await oq(t, "SELECT kind, page FROM feedback WHERE tenant_id = $1 ORDER BY created_at", [t.tenantId])).rows;
    expect(rows).toEqual([{ kind: "idea", page: "/reportes" }, { kind: "problema", page: null }]);
  });

  it("la aplicación solo los agrega: no puede editarlos ni borrarlos, y un negocio no ve los de otro", async () => {
    const a = await register("fbA"), b = await register("fbB");
    await fb(a, { kind: "otro", message: "comentario de A" });
    await expect(withTenant(a.tenantId, (db) => db.query("UPDATE feedback SET message = 'x'"))).rejects.toThrow();
    await expect(withTenant(a.tenantId, (db) => db.query("DELETE FROM feedback"))).rejects.toThrow();
    expect((await withTenant(b.tenantId, (db) => db.query("SELECT 1 FROM feedback"))).rowCount).toBe(0);
  });

  it("solo un súper admin con 2FA los lee entre negocios; un dueño o un token inventado, no", async () => {
    const t = await register("fbadm");
    const msg = `visible para el súper admin ${RUN}`;
    await fb(t, { kind: "problema", message: msg });
    const cookieOf = (r: Response) => (r.headers.get("set-cookie") ?? "").split(";")[0]!;
    const hashOf = (c: string) => createHash("sha256").update(c.split("=")[1]!).digest();
    // Un dueño normal o un token inventado: rechazado por la base.
    await expect(getAdminFeedback(hashOf(t.cookie))).rejects.toMatchObject({ code: "42501" });
    await expect(getAdminFeedback(Buffer.alloc(32, 7))).rejects.toMatchObject({ code: "42501" });
    // Un súper admin con verificación en dos pasos sí.
    const addr = `dm-${RUN}-super@example.test`;
    const ins = await owner.query<{ id: string }>("INSERT INTO users (email, password_hash, is_super_admin) VALUES ($1,$2,true) RETURNING id", [addr, await hashPassword(PASSWORD)]);
    const secret = await enableMfaDirect(owner, ins.rows[0]!.id);
    const res = await login(api("POST", "/api/auth/login", undefined, { email: addr, password: PASSWORD }));
    const ver = await verify2fa(api("POST", "/api/auth/2fa/verify", cookieOf(res), { code: codeFor(secret) }));
    expect(ver.status).toBe(200);
    const list = await getAdminFeedback(hashOf(cookieOf(ver)));
    const mine = list.find((f) => f.message === msg)!;
    expect(mine).toMatchObject({ kind: "problema", business: "Negocio fbadm", email: t.email.toLowerCase() });
    // La aplicación tampoco puede leer la tabla sin pasar por la función.
    expect((await getPool().query("SELECT count(*)::int AS n FROM feedback")).rows[0].n).toBe(0);
  });
});
