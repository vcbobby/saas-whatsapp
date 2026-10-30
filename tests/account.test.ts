import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { POST as signup } from "@/app/api/auth/signup/route";
import { GET as me } from "@/app/api/me/route";
import { POST as teamInvite } from "@/app/api/team/invite/route";
import { POST as inviteSignup } from "@/app/api/invitations/signup/route";
import { POST as login } from "@/app/api/auth/login/route";
import { POST as changePassword } from "@/app/api/account/password/route";
import { PATCH as rename } from "@/app/api/account/business/route";
import { POST as verify2fa } from "@/app/api/auth/2fa/verify/route";
import { POST as impersonate } from "@/app/api/admin/impersonation/route";
import { hashPassword } from "@/lib/auth/password";
import { hashToken } from "@/lib/auth/tokens";
import { codeFor, enableMfaDirect } from "./mfa-helpers";
import { getPool, withTenant } from "@/lib/db";

const RUN = randomUUID().slice(0, 8);
const ORIGIN = new URL(process.env.APP_URL!).origin;
const PASSWORD = "contraseña-de-prueba-123";
// Derivadas de PASSWORD (sin literales nuevos): así los escáneres de secretos no las toman por claves reales.
const NEW_PASSWORD = `${PASSWORD}-nueva`;
const OTHER_PASSWORD = `${PASSWORD}-otra`;
const WRONG_PASSWORD = `${PASSWORD}-mala`;
const ADMIN_PASSWORD = `${PASSWORD}-admin`;
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
  const email = `ac-${RUN}-${name}@example.test`;
  const res = await signup(api("POST", "/api/auth/signup", undefined, { email, password: PASSWORD, businessName: `Negocio ${name}` }));
  expect(res.status).toBe(201);
  const cookie = (res.headers.get("set-cookie") ?? "").split(";")[0]!;
  const info = await (await me(api("GET", "/api/me", cookie))).json();
  tenantIds.push(info.tenant.id);
  return { tenantId: info.tenant.id as string, cookie };
}
type T = Awaited<ReturnType<typeof register>>;
async function member(t: T, role: "admin" | "agent"): Promise<T> {
  const inv = await teamInvite(api("POST", "/api/team/invite", t.cookie, { email: `ac-${RUN}-${role}-${randomUUID().slice(0, 6)}@example.test`, role }));
  expect(inv.status).toBe(201);
  const token = ((await inv.json()).inviteUrl as string).split("/").pop()!;
  const ok = await inviteSignup(api("POST", "/api/invitations/signup", undefined, { token, password: PASSWORD }));
  expect(ok.status).toBe(201);
  return { tenantId: t.tenantId, cookie: (ok.headers.get("set-cookie") ?? "").split(";")[0]! };
}
beforeAll(async () => { await getPool().query("SELECT 1"); });
afterAll(async () => {
  await owner.query("DELETE FROM users WHERE email LIKE $1", [`ac-${RUN}-%`]);
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




async function newUser(name: string) {
  const t = await register(name);
  const email = `ac-${RUN}-${name}@example.test`;
  return { ...t, email };
}
const loginAs = async (email: string, password: string) => login(api("POST", "/api/auth/login", undefined, { email, password }));
const cookieOf = (res: Response) => (res.headers.get("set-cookie") ?? "").split(";")[0]!;
const pw = (cookie: string | undefined, body: unknown, origin = ORIGIN) => changePassword(api("POST", "/api/account/password", cookie, body, origin));
const userRow = async (email: string) => (await owner.query("SELECT failed_logins, locked_until FROM users WHERE email = $1", [email])).rows[0];
const audit = async (tenantId: string, action: string) => {
  const c = await owner.connect();
  try {
    await c.query("BEGIN");
    await c.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
    const r = await c.query("SELECT metadata, actor_id FROM audit_log WHERE tenant_id = $1 AND action = $2", [tenantId, action]);
    await c.query("COMMIT");
    return r.rows;
  } finally { c.release(); }
};
const tenantName = (t: T) => withTenant(t.tenantId, async (db) => String((await db.query("SELECT name FROM tenants WHERE id = $1", [t.tenantId])).rows[0].name));

describe("cambiar contraseña", () => {
  it("con la actual correcta: cambia, cierra las otras sesiones y conserva la actual", async () => {
    const u = await newUser("pw1");
    const other = cookieOf(await loginAs(u.email, PASSWORD)); // otro dispositivo
    expect((await me(api("GET", "/api/me", other))).status).toBe(200);
    const res = await pw(u.cookie, { currentPassword: PASSWORD, newPassword: NEW_PASSWORD });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, otherSessionsClosed: 1 });
    expect((await me(api("GET", "/api/me", other))).status).toBe(401);       // el otro dispositivo quedó fuera
    expect((await me(api("GET", "/api/me", u.cookie))).status).toBe(200);    // este sigue dentro
    expect((await loginAs(u.email, PASSWORD)).status).toBe(401);             // la vieja ya no sirve
    expect((await loginAs(u.email, NEW_PASSWORD)).status).toBe(200);
    const a = await audit(u.tenantId, "account.password_changed");
    expect(a).toHaveLength(1);
    expect(a[0].metadata).toEqual({ sessions_closed: 1 });
    expect(JSON.stringify(a)).not.toContain(NEW_PASSWORD);
  });

  it("la contraseña guardada es un hash nuevo (no la anterior ni el texto)", async () => {
    const u = await newUser("pw2");
    const before = (await owner.query("SELECT password_hash FROM users WHERE email = $1", [u.email])).rows[0].password_hash as string;
    expect((await pw(u.cookie, { currentPassword: PASSWORD, newPassword: OTHER_PASSWORD })).status).toBe(200);
    const after = (await owner.query("SELECT password_hash FROM users WHERE email = $1", [u.email])).rows[0].password_hash as string;
    expect(after).not.toBe(before);
    expect(after).toMatch(/^\$argon2id\$/);
    expect(after).not.toContain(OTHER_PASSWORD);
  });

  it("contraseña actual incorrecta: 401, suma un intento fallido y no cambia nada", async () => {
    const u = await newUser("pw3");
    const res = await pw(u.cookie, { currentPassword: WRONG_PASSWORD, newPassword: NEW_PASSWORD });
    expect(res.status).toBe(401);
    expect((await userRow(u.email)).failed_logins).toBe(1);
    expect((await loginAs(u.email, PASSWORD)).status).toBe(200);
  });

  it("tras 10 fallos la cuenta se bloquea y ni la clave correcta cambia nada; un cambio correcto limpia los intentos", async () => {
    const u = await newUser("pw4");
    for (let i = 0; i < 9; i++) expect((await pw(u.cookie, { currentPassword: WRONG_PASSWORD, newPassword: NEW_PASSWORD })).status).toBe(401);
    expect((await userRow(u.email)).failed_logins).toBe(9);
    expect((await pw(u.cookie, { currentPassword: PASSWORD, newPassword: NEW_PASSWORD })).status).toBe(200);
    expect((await userRow(u.email)).failed_logins).toBe(0);
    const v = await newUser("pw5");
    for (let i = 0; i < 10; i++) await pw(v.cookie, { currentPassword: WRONG_PASSWORD, newPassword: NEW_PASSWORD });
    expect((await userRow(v.email)).locked_until).not.toBeNull();
    const res = await pw(v.cookie, { currentPassword: PASSWORD, newPassword: NEW_PASSWORD });
    expect(res.status).toBe(429);
    expect((await loginAs(v.email, PASSWORD)).status).toBe(401);
  });

  it("reglas de la nueva: distinta, larga, sin tu correo y no repetitiva", async () => {
    const u = await newUser("pw6");
    expect((await pw(u.cookie, { currentPassword: PASSWORD, newPassword: PASSWORD })).status).toBe(400);
    expect((await pw(u.cookie, { currentPassword: PASSWORD, newPassword: "corta-1" })).status).toBe(400);
    expect((await pw(u.cookie, { currentPassword: PASSWORD, newPassword: "aaaaaaaaaaaaaa" })).status).toBe(400);
    expect((await pw(u.cookie, { currentPassword: PASSWORD, newPassword: `clave-${u.email.split("@")[0]}-x` })).status).toBe(400);
    expect((await loginAs(u.email, PASSWORD)).status).toBe(200);
  });

  it("sin sesión 401; origen ajeno 403; cuerpo incompleto 400", async () => {
    expect((await pw(undefined, { currentPassword: PASSWORD, newPassword: NEW_PASSWORD })).status).toBe(401);
    const u = await newUser("pw7");
    expect((await pw(u.cookie, { currentPassword: PASSWORD, newPassword: NEW_PASSWORD }, "https://evil.example")).status).toBe(403);
    expect((await pw(u.cookie, { currentPassword: PASSWORD })).status).toBe(400);
    expect((await loginAs(u.email, PASSWORD)).status).toBe(200);
  });

  it("la función de la base rechaza una sesión inventada o revocada", async () => {
    await expect(getPool().query("SELECT auth_change_password($1, $2)", [hashToken("token-inventado"), "x".repeat(30)])).rejects.toMatchObject({ code: "42501" });
    const u = await newUser("pw8");
    const other = cookieOf(await loginAs(u.email, PASSWORD));
    await pw(u.cookie, { currentPassword: PASSWORD, newPassword: NEW_PASSWORD });
    const token = other.split("=")[1]!;
    await expect(getPool().query("SELECT auth_change_password($1, $2)", [hashToken(token), "$argon2id$v=19$m=19456,t=2,p=1$abcdefghijklmnop$abcdefghijklmnopqrstuvwxyz"])).rejects.toMatchObject({ code: "42501" });
  });
});

async function makeSuperAdmin(name: string) {
  const addr = `ac-${RUN}-${name}@example.test`;
  const ins = await owner.query<{ id: string }>("INSERT INTO users (email, password_hash, is_super_admin) VALUES ($1, $2, true) RETURNING id", [addr, await hashPassword(PASSWORD)]);
  const secret = await enableMfaDirect(owner, ins.rows[0]!.id);
  const res = await loginAs(addr, PASSWORD);
  const ver = await verify2fa(api("POST", "/api/auth/2fa/verify", cookieOf(res), { code: codeFor(secret) }));
  expect(ver.status).toBe(200);
  return { cookie: cookieOf(ver), email: addr, secret };
}

describe("súper admin", () => {
  it("puede cambiar su propia contraseña (sin negocio activo no hay registro de negocio)", async () => {
    const admin = await makeSuperAdmin("sa1");
    const res = await pw(admin.cookie, { currentPassword: PASSWORD, newPassword: ADMIN_PASSWORD, code: codeFor(admin.secret, 1) });
    expect(res.status).toBe(200);
    expect((await loginAs(admin.email, ADMIN_PASSWORD)).status).toBe(200);
  });
  it("viendo un negocio como soporte NO puede cambiarle el nombre", async () => {
    const t = await newUser("sa2");
    const admin = await makeSuperAdmin("sa3");
    expect((await impersonate(api("POST", "/api/admin/impersonation", admin.cookie, { tenantId: t.tenantId, reason: "Ticket 1: revisar configuración" }))).status).toBe(200);
    expect((await rename(api("PATCH", "/api/account/business", admin.cookie, { name: "Nombre del soporte" }))).status).toBe(403);
    expect(await tenantName(t)).toBe("Negocio sa2");
  });
});

describe("nombre del negocio", () => {
  const ren = (t: T | { cookie: string }, name: unknown, origin = ORIGIN) => rename(api("PATCH", "/api/account/business", t.cookie, { name }, origin));

  it("el dueño lo cambia: se guarda, se audita con el antes y el después, y los espacios sobrantes se limpian", async () => {
    const t = await newUser("n1");
    const res = await ren(t, "  Clínica   del   Sol  ");
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, name: "Clínica del Sol", changed: true });
    expect(await tenantName(t)).toBe("Clínica del Sol");
    const a = await audit(t.tenantId, "tenant.renamed");
    expect(a).toHaveLength(1);
    expect(a[0].metadata).toEqual({ from: "Negocio n1", to: "Clínica del Sol" });
  });

  it("un salto de línea o tabulación se convierte en un espacio", async () => {
    const t = await newUser("n2b");
    expect(await (await ren(t, "Hola\nmundo\tuno")).json()).toMatchObject({ name: "Hola mundo uno" });
  });

  it("guardar el mismo nombre no cambia nada ni llena el registro", async () => {
    const t = await newUser("n2");
    const res = await ren(t, "Negocio n2");
    expect(await res.json()).toMatchObject({ ok: true, changed: false });
    expect(await audit(t.tenantId, "tenant.renamed")).toHaveLength(0);
  });

  it("nombres inválidos: vacío, de 1 letra, larguísimo, con < > o con caracteres de control", async () => {
    const t = await newUser("n3");
    for (const bad of ["", " ", "A", "x".repeat(121), "<b>Hola</b>", "Hola\u0000mundo", "Hola\u0007mundo", 123, null]) expect((await ren(t, bad)).status).toBe(400);
    expect(await tenantName(t)).toBe("Negocio n3");
  });

  it("un administrador sí puede; un agente no (403); sin sesión 401; origen ajeno 403", async () => {
    const t = await newUser("n4");
    const adm = await member(t, "admin");
    expect((await ren(adm, "Nombre por admin")).status).toBe(200);
    const ag = await member(t, "agent");
    expect((await ren(ag, "Nombre por agente")).status).toBe(403);
    expect(await tenantName(t)).toBe("Nombre por admin");
    expect((await rename(api("PATCH", "/api/account/business", undefined, { name: "Hola" }))).status).toBe(401);
    expect((await ren(t, "Otro nombre", "https://evil.example")).status).toBe(403);
  });

  it("aislamiento: renombrar un negocio no toca a otro", async () => {
    const a = await newUser("n5a");
    const b = await newUser("n5b");
    await ren(a, "Solo el A");
    expect(await tenantName(b)).toBe("Negocio n5b");
  });
});
