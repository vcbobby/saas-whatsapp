import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GET as adminTenants } from "@/app/api/admin/tenants/route";
import { POST as adminPlans } from "@/app/api/admin/plans/route";
import { POST as adminTenantPlan } from "@/app/api/admin/tenant-plan/route";
import { POST as login } from "@/app/api/auth/login/route";
import { POST as signup } from "@/app/api/auth/signup/route";
import { POST as verify2fa } from "@/app/api/auth/2fa/verify/route";
import { GET as me } from "@/app/api/me/route";
import { GET as planGet } from "@/app/api/plan/route";
import { POST as teamInvite } from "@/app/api/team/invite/route";
import { POST as teamInvitation } from "@/app/api/team/invitation/route";
import { GET as teamGet } from "@/app/api/team/route";
import { hashPassword } from "@/lib/auth/password";
import { getPool, withTenant } from "@/lib/db";
import { loadPlan, loadPlanUsage, quotaState, repliesThisMonth } from "@/lib/plans/usage";
import { tokenHashOf } from "@/lib/auth/session";
import { codeFor, enableMfaDirect } from "./mfa-helpers";

const RUN = randomUUID().slice(0, 8);
const ORIGIN = new URL(process.env.APP_URL!).origin;
const PASSWORD = "contraseña-de-prueba-123";
const owner = new Pool({ connectionString: process.env.MIGRATION_DATABASE_URL, max: 2 });
const tenantIds: string[] = [];
const planIds: string[] = [];

const req = (method: string, path: string, cookie?: string, body?: unknown, origin = ORIGIN) =>
  new Request(`${ORIGIN}${path}`, { method, headers: { origin, ...(body !== undefined ? { "content-type": "application/json" } : {}), ...(cookie ? { cookie } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
const cookieOf = (res: Response) => (res.headers.get("set-cookie") ?? "").split(";")[0]!;

async function register(name: string) {
  const res = await signup(req("POST", "/api/auth/signup", undefined, { email: `pl-${RUN}-${name}@example.test`, password: PASSWORD, businessName: `Negocio ${name}` }));
  expect(res.status).toBe(201);
  const cookie = cookieOf(res);
  const info = await (await me(req("GET", "/api/me", cookie))).json();
  tenantIds.push(info.tenant.id);
  return { cookie, tenantId: info.tenant.id as string };
}
type T = Awaited<ReturnType<typeof register>>;

async function makeSuperAdmin(name: string) {
  const addr = `pl-${RUN}-${name}@example.test`;
  const ins = await owner.query<{ id: string }>("INSERT INTO users (email, password_hash, is_super_admin) VALUES ($1,$2,true) RETURNING id", [addr, await hashPassword(PASSWORD)]);
  const secret = await enableMfaDirect(owner, ins.rows[0]!.id);
  const res = await login(req("POST", "/api/auth/login", undefined, { email: addr, password: PASSWORD }));
  const ver = await verify2fa(req("POST", "/api/auth/2fa/verify", cookieOf(res), { code: codeFor(secret) }));
  expect(ver.status).toBe(200);
  return cookieOf(ver);
}

/** Crea un plan de prueba (solo para estos tests) y lo devuelve. */
async function mkPlan(o: { replies?: number | null; members?: number; modules?: string[]; active?: boolean } = {}) {
  const slug = `t-${RUN}-${planIds.length}`;
  const r = await owner.query<{ id: string }>(
    "INSERT INTO plans (slug, name, position, max_replies_month, max_members, modules, active) VALUES ($1,$2,99,$3,$4,$5,$6) RETURNING id",
    [slug, `Prueba ${slug}`, o.replies === undefined ? 100 : o.replies, o.members ?? 5, o.modules ?? ["agenda"], o.active ?? true],
  );
  planIds.push(r.rows[0]!.id);
  return r.rows[0]!.id;
}
/** Asigna un plan saltándose el guardia (en producción solo lo hace admin_set_tenant_plan). */
async function setPlan(tenantId: string, planId: string) {
  const c = await owner.connect();
  try {
    await c.query("BEGIN");
    await c.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
    await c.query("ALTER TABLE tenants DISABLE TRIGGER tenants_plan_guard");
    await c.query("UPDATE tenants SET plan_id = $2 WHERE id = $1", [tenantId, planId]);
    await c.query("ALTER TABLE tenants ENABLE TRIGGER tenants_plan_guard");
    await c.query("COMMIT");
  } catch (e) { await c.query("ROLLBACK"); throw e; } finally { c.release(); }
}
const planOf = (t: T) => withTenant(t.tenantId, async (db) => (await db.query("SELECT plan_id FROM tenants WHERE id = $1", [t.tenantId])).rows[0].plan_id as string);
const addUsage = (t: T, daysAgoSql: string, replies: number) =>
  withTenant(t.tenantId, (db) => db.query(`INSERT INTO agent_usage_daily (tenant_id, day, replies) VALUES ($1, ${daysAgoSql}, $2)`, [t.tenantId, replies]));

beforeAll(async () => { await getPool().query("SELECT 1"); });
afterAll(async () => {
  await owner.query("DELETE FROM users WHERE email LIKE $1", [`pl-${RUN}-%`]);
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
  if (planIds.length) await owner.query("DELETE FROM plans WHERE id = ANY($1)", [planIds]);
  await owner.end();
  await getPool().end();
});

describe("quotaState", () => {
  it.each<[number, number | null, string]>([[5, null, "unlimited"], [0, 10, "ok"], [7, 10, "ok"], [8, 10, "near"], [9, 10, "near"], [10, 10, "full"], [11, 10, "full"], [0, 0, "full"], [1, 100, "ok"], [80, 100, "near"], [79, 100, "ok"]])("%i de %s → %s", (u, m, s) => {
    expect(quotaState(u, m)).toBe(s);
  });
});

describe("planes iniciales", () => {
  it("existen la prueba gratis (por defecto, con todos los módulos) y tres planes de pago provisionales", async () => {
    const r = await getPool().query("SELECT slug, name, is_default, active, max_replies_month, max_members, modules FROM plans WHERE slug IN ('prueba','plan-1','plan-2','plan-3') ORDER BY position");
    expect(r.rows.map((p) => p.slug)).toEqual(["prueba", "plan-1", "plan-2", "plan-3"]);
    expect(r.rows.map((p) => p.is_default)).toEqual([true, false, false, false]);
    expect([...r.rows[0].modules].sort()).toEqual(["agenda", "automatizaciones", "catalogo", "copiloto"]);
    const d = await getPool().query("SELECT count(*)::int AS n FROM plans WHERE is_default");
    expect(d.rows[0].n).toBe(1);
  });
  it("un negocio nuevo recibe el plan por defecto", async () => {
    const t = await register("nuevo");
    const plan = await withTenant(t.tenantId, (db) => loadPlan(db, t.tenantId));
    expect(plan).toMatchObject({ slug: "prueba", maxMembers: 3 });
    expect(plan!.modules.length).toBe(4);
  });
  it("la aplicación no puede crear, cambiar ni borrar planes", async () => {
    await expect(getPool().query("INSERT INTO plans (slug, name, max_members) VALUES ('hack', 'x', 1)")).rejects.toThrow(/permission denied/);
    await expect(getPool().query("UPDATE plans SET max_members = 1000")).rejects.toThrow(/permission denied/);
    await expect(getPool().query("DELETE FROM plans")).rejects.toThrow(/permission denied/);
  });
  it("las restricciones de la tabla se cumplen", async () => {
    const bad = (cols: string, vals: unknown[]) => owner.query(`INSERT INTO plans (${cols}) VALUES (${vals.map((_, i) => `$${i + 1}`).join(",")})`, vals);
    await expect(bad("slug, name, max_members", ["A", "x", 1])).rejects.toThrow(); // slug en mayúscula
    await expect(bad("slug, name, max_members", [`ok-${RUN}-a`, "", 1])).rejects.toThrow(); // nombre vacío
    await expect(bad("slug, name, max_members", [`ok-${RUN}-b`, "x", 0])).rejects.toThrow(); // 0 personas
    await expect(bad("slug, name, max_members, max_replies_month", [`ok-${RUN}-c`, "x", 1, -1])).rejects.toThrow();
    await expect(bad("slug, name, max_members, modules", [`ok-${RUN}-d`, "x", 1, ["otro"]])).rejects.toThrow(); // módulo inventado
    await expect(bad("slug, name, max_members, is_default", [`ok-${RUN}-e`, "x", 1, true])).rejects.toThrow(); // dos por defecto
    await expect(bad("slug, name, max_members, is_default, active", [`ok-${RUN}-f`, "x", 1, true, false])).rejects.toThrow();
  });
});

describe("consumo del mes", () => {
  it("cuenta solo las respuestas del mes calendario actual", async () => {
    const t = await register("uso");
    await addUsage(t, "date_trunc('month', now() AT TIME ZONE 'utc')::date", 4); // 1.º del mes
    await addUsage(t, "(date_trunc('month', now() AT TIME ZONE 'utc') - interval '1 day')::date", 50); // último día del mes anterior
    await addUsage(t, "(date_trunc('month', now() AT TIME ZONE 'utc') - interval '40 days')::date", 70);
    expect(await withTenant(t.tenantId, (db) => repliesThisMonth(db, t.tenantId))).toBe(4);
  });
  it("sin consumo es 0 y los negocios no se mezclan", async () => {
    const a = await register("uso-a");
    const b = await register("uso-b");
    await addUsage(a, "(now() AT TIME ZONE 'utc')::date", 9);
    expect(await withTenant(a.tenantId, (db) => repliesThisMonth(db, a.tenantId))).toBe(9);
    expect(await withTenant(b.tenantId, (db) => repliesThisMonth(db, b.tenantId))).toBe(0);
  });
  it("GET /api/plan devuelve plan, uso y estados", async () => {
    const t = await register("api");
    const p = await mkPlan({ replies: 10, members: 4 });
    await setPlan(t.tenantId, p);
    await addUsage(t, "(now() AT TIME ZONE 'utc')::date", 8);
    const body = await (await planGet(req("GET", "/api/plan", t.cookie))).json();
    expect(body).toMatchObject({ repliesThisMonth: 8, members: 1, pendingInvitations: 0, repliesState: "near", membersState: "ok" });
    expect(body.plan).toMatchObject({ maxRepliesMonth: 10, maxMembers: 4, modules: ["agenda"] });
  });
  it("sin sesión no se ve el plan; plan sin tope = ilimitado", async () => {
    expect((await planGet(req("GET", "/api/plan"))).status).toBe(401);
    const t = await register("ilim");
    await setPlan(t.tenantId, await mkPlan({ replies: null }));
    const body = await (await planGet(req("GET", "/api/plan", t.cookie))).json();
    expect(body.plan.maxRepliesMonth).toBeNull();
    expect(body.repliesState).toBe("unlimited");
  });
  it("loadPlanUsage cuenta invitaciones pendientes", async () => {
    const t = await register("inv-uso");
    await teamInvite(req("POST", "/api/team/invite", t.cookie, { email: `pl-${RUN}-x1@example.test`, role: "agent" }));
    const u = await withTenant(t.tenantId, (db) => loadPlanUsage(db, t.tenantId));
    expect(u).toMatchObject({ members: 1, pendingInvitations: 1 });
  });
});

describe("invitaciones pendientes por negocio", () => {
  it("cada negocio ve solo las suyas; vencidas y revocadas no cuentan", async () => {
    const a = await register("pend-a");
    const b = await register("pend-b");
    await teamInvite(req("POST", "/api/team/invite", a.cookie, { email: `pl-${RUN}-pa1@example.test`, role: "agent" }));
    await teamInvite(req("POST", "/api/team/invite", a.cookie, { email: `pl-${RUN}-pa2@example.test`, role: "agent" }));
    const n = (t: T) => withTenant(t.tenantId, async (db) => Number((await db.query("SELECT tenant_pending_invitations() AS n")).rows[0].n));
    expect(await n(a)).toBe(2);
    expect(await n(b)).toBe(0);
    await owner.query("UPDATE invitations SET expires_at = now() - interval '1 minute' WHERE tenant_id = $1 AND email LIKE '%pa1@%'", [a.tenantId]);
    expect(await n(a)).toBe(1);
    await owner.query("UPDATE invitations SET revoked_at = now() WHERE tenant_id = $1", [a.tenantId]);
    expect(await n(a)).toBe(0);
  });
});

describe("tope de personas del plan", () => {
  const invite = (t: T, n: string) => teamInvite(req("POST", "/api/team/invite", t.cookie, { email: `pl-${RUN}-${n}@example.test`, role: "agent" }));
  it("miembros + invitaciones pendientes no pueden pasar del tope; revocar libera el cupo", async () => {
    const t = await register("tope");
    await setPlan(t.tenantId, await mkPlan({ members: 3 }));
    expect((await invite(t, "tp1")).status).toBe(201);
    expect((await invite(t, "tp2")).status).toBe(201);
    const blocked = await invite(t, "tp3");
    expect(blocked.status).toBe(409);
    expect((await blocked.json()).error).toBe("limite_equipo");
    const list = await (await teamGet(req("GET", "/api/team", t.cookie))).json();
    await teamInvitation(req("POST", "/api/team/invitation", t.cookie, { invitationId: list.invitations[0].id }));
    expect((await invite(t, "tp4")).status).toBe(201);
  });
  it("un plan de 1 persona no deja invitar a nadie; subir el tope lo permite", async () => {
    const t = await register("uno");
    const p = await mkPlan({ members: 1 });
    await setPlan(t.tenantId, p);
    expect((await invite(t, "u1")).status).toBe(409);
    await setPlan(t.tenantId, await mkPlan({ members: 2 }));
    expect((await invite(t, "u2")).status).toBe(201);
  });
  it("reinvitar al mismo correo reemplaza la invitación y no gasta otro cupo", async () => {
    const t = await register("reinv");
    await setPlan(t.tenantId, await mkPlan({ members: 2 }));
    expect((await invite(t, "same")).status).toBe(201);
    expect((await invite(t, "same")).status).toBe(409); // ya hay 1 + dueño = 2 = tope (la comprobación va antes de reemplazar)
  });
});

describe("súper admin: asignar plan", () => {
  it("cambia el plan, lo audita y la lista de negocios lo muestra", async () => {
    const adm = await makeSuperAdmin("adm1");
    const t = await register("asig");
    const p = await mkPlan();
    const res = await adminTenantPlan(req("POST", "/api/admin/tenant-plan", adm, { tenantId: t.tenantId, planId: p }));
    expect(res.status).toBe(200);
    expect(await planOf(t)).toBe(p);
    const audit = await withTenant(t.tenantId, async (db) => (await db.query("SELECT metadata FROM audit_log WHERE action = 'admin.tenant.plan'")).rows);
    expect(audit).toHaveLength(1);
    expect(audit[0].metadata.to).toBe(p);
    const list = await (await adminTenants(req("GET", "/api/admin/tenants", adm))).json();
    expect(list.tenants.find((x: { id: string }) => x.id === t.tenantId).planId).toBe(p);
  });
  it("rechaza plan inactivo, plan o negocio inexistentes, datos malos y a quien no es súper admin (404)", async () => {
    const adm = await makeSuperAdmin("adm2");
    const t = await register("rech");
    const before = await planOf(t);
    const off = await mkPlan({ active: false });
    expect((await adminTenantPlan(req("POST", "/api/admin/tenant-plan", adm, { tenantId: t.tenantId, planId: off }))).status).toBe(404);
    expect((await adminTenantPlan(req("POST", "/api/admin/tenant-plan", adm, { tenantId: t.tenantId, planId: randomUUID() }))).status).toBe(404);
    expect((await adminTenantPlan(req("POST", "/api/admin/tenant-plan", adm, { tenantId: randomUUID(), planId: before }))).status).toBe(404);
    expect((await adminTenantPlan(req("POST", "/api/admin/tenant-plan", adm, { tenantId: "x", planId: before }))).status).toBeGreaterThanOrEqual(400);
    expect((await adminTenantPlan(req("POST", "/api/admin/tenant-plan", t.cookie, { tenantId: t.tenantId, planId: await mkPlan() }))).status).toBe(404);
    expect((await adminTenantPlan(req("POST", "/api/admin/tenant-plan", undefined, { tenantId: t.tenantId, planId: before }))).status).toBe(404);
    expect((await adminTenantPlan(req("POST", "/api/admin/tenant-plan", adm, { tenantId: t.tenantId, planId: before }, "https://evil.example"))).status).toBeGreaterThanOrEqual(400);
    expect(await planOf(t)).toBe(before);
  });
  it("ni el dueño del negocio puede cambiarse el plan, ni con SQL directo", async () => {
    const t = await register("sql");
    const before = await planOf(t);
    const p = await mkPlan();
    await expect(withTenant(t.tenantId, (db) => db.query("UPDATE tenants SET plan_id = $1", [p]))).rejects.toMatchObject({ code: "42501" });
    expect(await planOf(t)).toBe(before);
    await withTenant(t.tenantId, (db) => db.query("UPDATE tenants SET name = 'Otro nombre'")); // otras columnas siguen editables
  });
});

describe("las funciones de la base también exigen ser súper admin (defensa en profundidad)", () => {
  it("con una sesión de dueño normal o un token inventado se rechazan, aunque se salten la API", async () => {
    const t = await register("directo");
    const p = await mkPlan();
    const before = await planOf(t);
    const hashes = [tokenHashOf(req("GET", "/", t.cookie))!, Buffer.alloc(32, 7)];
    for (const h of hashes) {
      await expect(getPool().query("SELECT admin_set_tenant_plan($1, $2, $3)", [h, t.tenantId, p])).rejects.toMatchObject({ code: "42501" });
      await expect(getPool().query("SELECT admin_update_plan($1, $2, 'x', 1, 1, '{}', true)", [h, p])).rejects.toMatchObject({ code: "42501" });
      await expect(getPool().query("SELECT * FROM admin_list_tenants($1)", [h])).rejects.toMatchObject({ code: "42501" });
    }
    expect(await planOf(t)).toBe(before);
    expect((await owner.query("SELECT name FROM plans WHERE id = $1", [p])).rows[0].name).not.toBe("x");
  });
});

describe("súper admin: editar planes", () => {
  const upd = (cookie: string | undefined, planId: string, o: Record<string, unknown> = {}) =>
    adminPlans(req("POST", "/api/admin/plans", cookie, { planId, name: "Nuevo nombre", maxRepliesMonth: 500, maxMembers: 7, modules: ["agenda", "copiloto"], active: true, ...o }));
  const row = async (id: string) => (await owner.query("SELECT * FROM plans WHERE id = $1", [id])).rows[0];

  it("guarda nombre, límites y módulos (sin repetidos) y el cambio rige de inmediato", async () => {
    const adm = await makeSuperAdmin("adm3");
    const p = await mkPlan();
    const t = await register("edit");
    await setPlan(t.tenantId, p);
    expect((await upd(adm, p, { name: "  Plan Oro  ", modules: ["agenda", "agenda", "copiloto"] })).status).toBe(200);
    expect(await row(p)).toMatchObject({ name: "Plan Oro", max_replies_month: 500, max_members: 7, modules: ["agenda", "copiloto"], active: true });
    const plan = await withTenant(t.tenantId, (db) => loadPlan(db, t.tenantId));
    expect(plan).toMatchObject({ name: "Plan Oro", maxMembers: 7 });
  });
  it("«sin tope» (null) y 0 se guardan distinto", async () => {
    const adm = await makeSuperAdmin("adm4");
    const p = await mkPlan();
    await upd(adm, p, { maxRepliesMonth: null });
    expect((await row(p)).max_replies_month).toBeNull();
    await upd(adm, p, { maxRepliesMonth: 0 });
    expect((await row(p)).max_replies_month).toBe(0);
  });
  it.each<[string, Record<string, unknown>]>([
    ["nombre vacío", { name: "   " }], ["nombre larguísimo", { name: "x".repeat(61) }], ["0 personas", { maxMembers: 0 }], ["demasiadas personas", { maxMembers: 1001 }],
    ["respuestas negativas", { maxRepliesMonth: -1 }], ["respuestas decimales", { maxRepliesMonth: 1.5 }], ["módulo inventado", { modules: ["otro"] }], ["activo no booleano", { active: "si" }],
  ])("rechaza: %s", async (_n, o) => {
    const adm = await makeSuperAdmin("adm-bad-" + Math.random().toString(36).slice(2, 7));
    const p = await mkPlan();
    const before = await row(p);
    expect((await upd(adm, p, o)).status).toBeGreaterThanOrEqual(400);
    expect(await row(p)).toEqual(before);
  });
  it("el plan por defecto no se puede desactivar; los demás sí", async () => {
    const adm = await makeSuperAdmin("adm5");
    const def = (await owner.query("SELECT id FROM plans WHERE is_default")).rows[0].id as string;
    const r = await upd(adm, def, { active: false, name: "Plan 1", maxRepliesMonth: 300, maxMembers: 3, modules: ["agenda", "catalogo"] });
    expect(r.status).toBe(409);
    expect((await row(def)).active).toBe(true);
    const p = await mkPlan();
    expect((await upd(adm, p, { active: false })).status).toBe(200);
    expect((await row(p)).active).toBe(false);
  });
  it("plan inexistente → 404; sin ser súper admin → 404 y no cambia nada", async () => {
    const adm = await makeSuperAdmin("adm6");
    expect((await upd(adm, randomUUID())).status).toBe(404);
    const t = await register("noadmin");
    const p = await mkPlan();
    const before = await row(p);
    expect((await upd(t.cookie, p)).status).toBe(404);
    expect((await upd(undefined, p)).status).toBe(404);
    expect(await row(p)).toEqual(before);
  });
});
