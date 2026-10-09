import { createHash, randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, describe, expect, it } from "vitest";
import { POST as impersonate, DELETE as stopImpersonation } from "@/app/api/admin/impersonation/route";
import { POST as tenantStatus } from "@/app/api/admin/tenant-status/route";
import { GET as listTenants } from "@/app/api/admin/tenants/route";
import { POST as login } from "@/app/api/auth/login/route";
import { POST as logout } from "@/app/api/auth/logout/route";
import { POST as logoutAll } from "@/app/api/auth/logout-all/route";
import { POST as signup } from "@/app/api/auth/signup/route";
import { POST as verify2fa } from "@/app/api/auth/2fa/verify/route";
import { GET as me } from "@/app/api/me/route";
import { buildClearCookie, buildSessionCookie, sessionCookieName } from "@/lib/auth/cookies";
import { can, ROLES, type Permission } from "@/lib/auth/permissions";
import { hashPassword, verifyPassword } from "@/lib/auth/password";
import { getPool, withTenant } from "@/lib/db";
import { codeFor, enableMfaDirect } from "./mfa-helpers";

const ORIGIN = new URL(process.env.APP_URL!).origin;
const RUN = randomUUID().slice(0, 8);
const email = (n: string) => `test-${RUN}-${n}@example.test`;
const PASSWORD = "contraseña-de-prueba-123";

const owner = new Pool({ connectionString: process.env.MIGRATION_DATABASE_URL, max: 2 });
const tenantIds: string[] = [];

function post(path: string, body: unknown, cookie?: string, headers: Record<string, string> = {}) {
  return new Request(`${ORIGIN}${path}`, {
    method: "POST",
    headers: {
      origin: ORIGIN,
      "content-type": "application/json",
      ...(cookie ? { cookie } : {}),
      ...headers,
    },
    body: JSON.stringify(body),
  });
}
function call(method: string, path: string, cookie?: string, body?: unknown) {
  return new Request(`${ORIGIN}${path}`, {
    method,
    headers: {
      origin: ORIGIN,
      ...(body ? { "content-type": "application/json" } : {}),
      ...(cookie ? { cookie } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
}
const cookieOf = (res: Response) => (res.headers.get("set-cookie") ?? "").split(";")[0]!;

async function register(name: string) {
  const res = await signup(
    post("/api/auth/signup", { email: email(name), password: PASSWORD, businessName: `Negocio ${name}` }),
  );
  expect(res.status).toBe(201);
  const cookie = cookieOf(res);
  const info = await (await me(call("GET", "/api/me", cookie))).json();
  tenantIds.push(info.tenant.id);
  return { cookie, tenantId: info.tenant.id as string, email: email(name) };
}

async function makeSuperAdmin(name: string) {
  const addr = email(name);
  const ins = await owner.query<{ id: string }>(
    "INSERT INTO users (email, password_hash, is_super_admin) VALUES ($1, $2, true) RETURNING id",
    [addr, await hashPassword(PASSWORD)],
  );
  // El súper admin exige 2FA: se activa directo en la base y se entra con código.
  const secret = await enableMfaDirect(owner, ins.rows[0]!.id);
  const res = await login(post("/api/auth/login", { email: addr, password: PASSWORD }));
  expect(res.status).toBe(200);
  expect((await res.clone().json()).mfaRequired).toBe(true);
  const ver = await verify2fa(post("/api/auth/2fa/verify", { code: codeFor(secret) }, cookieOf(res)));
  expect(ver.status).toBe(200);
  return { cookie: cookieOf(ver), email: addr, res: ver, userId: ins.rows[0]!.id, secret };
}

async function limpiarAuditoria(tenantId: string) {
  const c = await owner.connect();
  try {
    await c.query("BEGIN");
    await c.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
    await c.query("ALTER TABLE audit_log DISABLE TRIGGER audit_log_sin_cambios");
    await c.query("DELETE FROM audit_log WHERE tenant_id = $1", [tenantId]);
    await c.query("ALTER TABLE audit_log ENABLE TRIGGER audit_log_sin_cambios");
    await c.query("COMMIT");
  } catch (e) {
    await c.query("ROLLBACK");
    throw e;
  } finally {
    c.release();
  }
}

async function codigo(p: Promise<unknown>) {
  try {
    await p;
    return undefined;
  } catch (e) {
    return (e as { code?: string }).code;
  }
}

afterAll(async () => {
  await owner.query("DELETE FROM users WHERE email LIKE $1", [`test-${RUN}-%`]);
  for (const id of tenantIds) {
    await withTenant(id, (db) => db.query("DELETE FROM tenants WHERE id = $1", [id]));
    await limpiarAuditoria(id);
  }
  await owner.end();
  await getPool().end();
});

describe("contraseñas", () => {
  it("usa argon2id, verifica bien y tolera hashes corruptos", async () => {
    const h = await hashPassword("una-clave-larga-123");
    expect(h.startsWith("$argon2id$")).toBe(true);
    expect(await verifyPassword(h, "una-clave-larga-123")).toBe(true);
    expect(await verifyPassword(h, "otra-clave")).toBe(false);
    expect(await verifyPassword("no-es-un-hash", "x")).toBe(false);
  });
});

describe("permisos por rol", () => {
  it("respeta la matriz de roles", () => {
    expect(can("owner", "billing:manage")).toBe(true);
    expect(can("admin", "billing:manage")).toBe(false);
    expect(can("agent", "billing:manage")).toBe(false);
    expect(can("agent", "team:manage")).toBe(false);
    expect(can("admin", "team:manage")).toBe(true);
    expect(can("agent", "conversations:reply")).toBe(true);
    expect(can(null, "conversations:read")).toBe(false);
    expect(can(undefined, "conversations:read")).toBe(false);
    const todos: Permission[] = ["tenant:delete", "settings:edit", "contacts:manage"];
    for (const p of todos) expect(can("agent", p)).toBe(false);
    expect(ROLES).toEqual(["owner", "admin", "agent"]);
  });
});

describe("cookie de sesión", () => {
  it("en producción es __Host-, Secure, HttpOnly y SameSite", () => {
    const c = buildSessionCookie("t".repeat(43), 100, false);
    expect(c).toBe(`__Host-sid=${"t".repeat(43)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=100; Secure`);
    expect(c).not.toContain("Domain");
    expect(buildClearCookie(false)).toMatch(/Max-Age=0.*Secure/);
  });
  it("en local funciona por http", () => {
    expect(buildSessionCookie("t".repeat(43), 100, true)).toBe(
      `sid=${"t".repeat(43)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=100`,
    );
  });
});

describe("registro", () => {
  it("crea cuenta, negocio en prueba de 7 días y sesión segura", async () => {
    const res = await signup(
      post("/api/auth/signup", { email: email("a"), password: PASSWORD, businessName: "Panadería La Esquina" }),
    );
    expect(res.status).toBe(201);
    const setCookie = res.headers.get("set-cookie")!;
    const local = process.env.APP_ENV === "local";
    expect(setCookie).toMatch(local ? /^sid=/ : /^__Host-sid=/);
    expect(setCookie).toMatch(/HttpOnly/);
    expect(setCookie).toMatch(/SameSite=Lax/);
    expect(/Secure/.test(setCookie)).toBe(!local);
    expect(setCookie).toMatch(/Path=\//);
    expect(setCookie).not.toMatch(/Domain=/);
    const text = await res.text();
    expect(text).not.toContain("hash");
    expect(text).not.toContain(PASSWORD);

    const info = await (await me(call("GET", "/api/me", cookieOf(res)))).json();
    tenantIds.push(info.tenant.id);
    expect(info.user.email).toBe(email("a"));
    expect(info.tenant.role).toBe("owner");
    expect(info.tenant.status).toBe("trial");

    const t = await withTenant(info.tenant.id, (db) =>
      db.query("SELECT slug, trial_ends_at FROM tenants"),
    );
    expect(t.rows[0].slug).toMatch(/^panaderia-la-esquina-[0-9a-f]{6}$/);
    const dias = (t.rows[0].trial_ends_at.getTime() - Date.now()) / 86_400_000;
    expect(dias).toBeGreaterThan(6.9);
    expect(dias).toBeLessThan(7.1);

    const u = await owner.query("SELECT password_hash FROM users WHERE email = $1", [email("a")]);
    expect(u.rows[0].password_hash).toMatch(/^\$argon2id\$/);
    expect(u.rows[0].password_hash).not.toContain(PASSWORD);

    // En la base solo existe el SHA-256 del token, nunca el token.
    const token = cookieOf(res).split("=")[1]!;
    const s = await owner.query("SELECT token_hash FROM sessions WHERE token_hash = $1", [
      createHash("sha256").update(token).digest(),
    ]);
    expect(s.rows).toHaveLength(1);
    expect(s.rows[0].token_hash.toString("utf8")).not.toContain(token);
  });

  it("rechaza datos inválidos", async () => {
    const mal = [
      { email: "no-es-correo", password: PASSWORD, businessName: "X1" },
      { email: email("b"), password: "corta", businessName: "Negocio" },
      { email: email("b"), password: "aaaaaaaaaaaaaaaa", businessName: "Negocio" },
      { email: email("b"), password: PASSWORD, businessName: "" },
      { email: `usuario${RUN}@example.test`, password: `usuario${RUN}-123456`, businessName: "Negocio" },
    ];
    for (const body of mal) {
      const res = await signup(post("/api/auth/signup", body));
      expect(res.status).toBe(400);
    }
  });

  it("no permite el mismo correo dos veces (ni cambiando mayúsculas)", async () => {
    await register("dup");
    const res = await signup(
      post("/api/auth/signup", {
        email: email("dup").toUpperCase(),
        password: PASSWORD,
        businessName: "Otro",
      }),
    );
    expect(res.status).toBe(409);
  });

  it("rechaza peticiones de otros sitios, sin origen y con tipo equivocado", async () => {
    const cuerpo = { email: email("csrf"), password: PASSWORD, businessName: "Negocio" };
    const otroSitio = await signup(post("/api/auth/signup", cuerpo, undefined, { origin: "https://malo.example" }));
    expect(otroSitio.status).toBe(403);
    const nullOrigin = await signup(post("/api/auth/signup", cuerpo, undefined, { origin: "null" }));
    expect(nullOrigin.status).toBe(403);

    const sinOrigen = new Request(`${ORIGIN}/api/auth/signup`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(cuerpo),
    });
    expect((await signup(sinOrigen)).status).toBe(403);

    const formulario = new Request(`${ORIGIN}/api/auth/signup`, {
      method: "POST",
      headers: { origin: ORIGIN, "content-type": "application/x-www-form-urlencoded" },
      body: "email=a",
    });
    expect((await signup(formulario)).status).toBe(415);

    const enorme = post("/api/auth/signup", { ...cuerpo, businessName: "x".repeat(20_000) });
    expect((await signup(enorme)).status).toBe(413);

    const existe = await owner.query("SELECT 1 FROM users WHERE email = $1", [email("csrf")]);
    expect(existe.rows).toHaveLength(0);
  });
});

describe("inicio de sesión", () => {
  it("entra con la contraseña correcta", async () => {
    await register("login");
    const res = await login(post("/api/auth/login", { email: email("login").toUpperCase(), password: PASSWORD }));
    expect(res.status).toBe(200);
    expect(res.headers.get("set-cookie")).toMatch(/HttpOnly/);
    const info = await (await me(call("GET", "/api/me", cookieOf(res)))).json();
    expect(info.user.email).toBe(email("login"));
  });

  it("da la misma respuesta si la clave es mala o el correo no existe", async () => {
    await register("enum");
    const mala = await login(post("/api/auth/login", { email: email("enum"), password: "incorrecta-123" }));
    const noExiste = await login(post("/api/auth/login", { email: email("fantasma"), password: "incorrecta-123" }));
    expect(mala.status).toBe(401);
    expect(noExiste.status).toBe(401);
    expect(await mala.json()).toEqual(await noExiste.json());
    expect(mala.headers.get("set-cookie")).toBeNull();
  });

  it("bloquea la cuenta tras 10 fallos, aunque luego llegue la clave correcta", async () => {
    await register("lock");
    for (let i = 0; i < 10; i++) {
      const r = await login(post("/api/auth/login", { email: email("lock"), password: "mala-clave-123" }));
      expect(r.status).toBe(401);
    }
    const bloqueada = await login(post("/api/auth/login", { email: email("lock"), password: PASSWORD }));
    expect(bloqueada.status).toBe(401);

    await owner.query("UPDATE users SET locked_until = now() - interval '1 minute' WHERE email = $1", [email("lock")]);
    const ok = await login(post("/api/auth/login", { email: email("lock"), password: PASSWORD }));
    expect(ok.status).toBe(200);
    const u = await owner.query("SELECT failed_logins, locked_until FROM users WHERE email = $1", [email("lock")]);
    expect(u.rows[0].failed_logins).toBe(0);
    expect(u.rows[0].locked_until).toBeNull();
  });

  it("un usuario desactivado no entra y sus sesiones dejan de valer", async () => {
    const { cookie } = await register("off");
    expect((await me(call("GET", "/api/me", cookie))).status).toBe(200);
    await owner.query("UPDATE users SET status = 'disabled' WHERE email = $1", [email("off")]);
    expect((await me(call("GET", "/api/me", cookie))).status).toBe(401);
    const res = await login(post("/api/auth/login", { email: email("off"), password: PASSWORD }));
    expect(res.status).toBe(401);
  });

  it("resiste 15 inicios de sesión simultáneos y deja máximo 10 sesiones activas", async () => {
    await register("conc");
    const resultados = await Promise.all(
      Array.from({ length: 15 }, () =>
        login(post("/api/auth/login", { email: email("conc"), password: PASSWORD })),
      ),
    );
    expect(resultados.every((r) => r.status === 200)).toBe(true);
    const activas = await owner.query(
      `SELECT count(*)::int AS n FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE u.email = $1 AND s.revoked_at IS NULL`,
      [email("conc")],
    );
    expect(activas.rows[0].n).toBeLessThanOrEqual(10);
  });
});

describe("sesiones", () => {
  it("sin cookie, con basura o con token inventado: 401", async () => {
    expect((await me(call("GET", "/api/me"))).status).toBe(401);
    expect((await me(call("GET", "/api/me", `${sessionCookieName()}=basura`))).status).toBe(401);
    const inventado = `${sessionCookieName()}=${"A".repeat(43)}`;
    expect((await me(call("GET", "/api/me", inventado))).status).toBe(401);
  });

  it("cerrar sesión la revoca en el servidor y borra la cookie", async () => {
    const { cookie } = await register("out");
    const res = await logout(post("/api/auth/logout", {}, cookie));
    expect(res.status).toBe(200);
    expect(res.headers.get("set-cookie")).toMatch(/Max-Age=0/);
    expect((await me(call("GET", "/api/me", cookie))).status).toBe(401);
  });

  it("cerrar sesión en todos lados revoca las demás", async () => {
    const a = await register("all");
    const b = await login(post("/api/auth/login", { email: a.email, password: PASSWORD }));
    const cookieB = cookieOf(b);
    expect((await me(call("GET", "/api/me", cookieB))).status).toBe(200);
    expect((await logoutAll(post("/api/auth/logout-all", {}, a.cookie))).status).toBe(200);
    expect((await me(call("GET", "/api/me", a.cookie))).status).toBe(401);
    expect((await me(call("GET", "/api/me", cookieB))).status).toBe(401);
  });

  it("caducan por tiempo total y por inactividad", async () => {
    const abs = await register("exp1");
    await owner.query(
      "UPDATE sessions SET expires_at = now() - interval '1 second' WHERE user_id = (SELECT id FROM users WHERE email = $1)",
      [abs.email],
    );
    expect((await me(call("GET", "/api/me", abs.cookie))).status).toBe(401);

    const idle = await register("exp2");
    await owner.query(
      "UPDATE sessions SET last_seen_at = now() - interval '8 days' WHERE user_id = (SELECT id FROM users WHERE email = $1)",
      [idle.email],
    );
    expect((await me(call("GET", "/api/me", idle.cookie))).status).toBe(401);
  });

  it("no se puede cambiar de negocio activo a uno ajeno", async () => {
    const a = await register("sw1");
    const b = await register("sw2");
    const token = a.cookie.split("=")[1]!;
    const hash = createHash("sha256").update(token).digest();
    const r = await getPool().query("SELECT auth_set_active_tenant($1, $2) AS ok", [hash, b.tenantId]);
    expect(r.rows[0].ok).toBe(false);
    const propio = await getPool().query("SELECT auth_set_active_tenant($1, $2) AS ok", [hash, a.tenantId]);
    expect(propio.rows[0].ok).toBe(true);
  });
});

describe("la aplicación no puede leer cuentas ni sesiones directamente", () => {
  it("app_user no accede a users, sessions ni puede crear membresías", async () => {
    const a = await register("priv");
    expect(await codigo(getPool().query("SELECT * FROM users"))).toBe("42501");
    expect(await codigo(getPool().query("SELECT * FROM sessions"))).toBe("42501");
    expect(await codigo(getPool().query("UPDATE users SET is_super_admin = true"))).toBe("42501");
    expect(
      await codigo(
        withTenant(a.tenantId, (db) =>
          db.query("INSERT INTO memberships (tenant_id, user_id, role) VALUES ($1, $2, 'owner')", [
            a.tenantId,
            randomUUID(),
          ]),
        ),
      ),
    ).toBe("42501");
    expect(await codigo(getPool().query("SELECT auth_session_user($1)", [Buffer.alloc(32)]))).toBe("42501");
    expect(await codigo(getPool().query("SELECT admin_require($1)", [Buffer.alloc(32)]))).toBe("42501");
  });

  it("un token desconocido no devuelve nada", async () => {
    const r = await getPool().query("SELECT * FROM auth_get_session($1)", [Buffer.alloc(32, 7)]);
    expect(r.rows).toHaveLength(0);
  });
});

describe("súper admin y suplantación", () => {
  it("un usuario normal no puede usar rutas ni funciones de admin", async () => {
    const a = await register("noadm");
    expect((await listTenants(call("GET", "/api/admin/tenants", a.cookie))).status).toBe(404);
    const res = await impersonate(
      post("/api/admin/impersonation", { tenantId: a.tenantId, reason: "intento indebido de entrar" }, a.cookie),
    );
    expect(res.status).toBe(404);
    const hash = createHash("sha256").update(a.cookie.split("=")[1]!).digest();
    expect(await codigo(getPool().query("SELECT * FROM admin_list_tenants($1)", [hash]))).toBe("42501");
    expect(
      await codigo(getPool().query("SELECT admin_start_impersonation($1, $2, 'motivo suficientemente largo')", [hash, a.tenantId])),
    ).toBe("42501");
    expect(await codigo(getPool().query("SELECT admin_set_tenant_status($1, $2, 'active')", [hash, a.tenantId]))).toBe("42501");
  });

  it("el súper admin tiene sesión corta y ve todos los negocios", async () => {
    const a = await register("lista");
    const admin = await makeSuperAdmin("adm1");
    expect(admin.res.headers.get("set-cookie")).toMatch(/Max-Age=28800/);
    const res = await listTenants(call("GET", "/api/admin/tenants", admin.cookie));
    expect(res.status).toBe(200);
    const { tenants } = await res.json();
    expect(tenants.some((t: { id: string }) => t.id === a.tenantId)).toBe(true);
  });

  it("suplantar exige motivo, queda auditado y da acceso solo a ese negocio", async () => {
    const a = await register("imp");
    const otro = await register("imp2");
    const admin = await makeSuperAdmin("adm2");
    await withTenant(a.tenantId, (db) =>
      db.query("INSERT INTO contacts (tenant_id, wa_id, display_name) VALUES ($1, '584140000001', 'Cliente A')", [a.tenantId]),
    );

    const corto = await impersonate(post("/api/admin/impersonation", { tenantId: a.tenantId, reason: "corto" }, admin.cookie));
    expect(corto.status).toBe(400);
    const inexistente = await impersonate(
      post("/api/admin/impersonation", { tenantId: randomUUID(), reason: "motivo suficientemente largo" }, admin.cookie),
    );
    expect(inexistente.status).toBe(404);

    const ok = await impersonate(
      post("/api/admin/impersonation", { tenantId: a.tenantId, reason: "Ticket 123: revisar configuración" }, admin.cookie),
    );
    expect(ok.status).toBe(200);

    const info = await (await me(call("GET", "/api/me", admin.cookie))).json();
    expect(info.tenant).toMatchObject({ id: a.tenantId, role: "admin", impersonating: true });

    const audit = await withTenant(a.tenantId, (db) =>
      db.query("SELECT action, metadata FROM audit_log WHERE action LIKE 'admin.%'"),
    );
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0].action).toBe("admin.impersonation.start");
    expect(audit.rows[0].metadata.reason).toBe("Ticket 123: revisar configuración");
    // El otro negocio no ve nada de esto.
    const ajeno = await withTenant(otro.tenantId, (db) =>
      db.query("SELECT 1 FROM audit_log WHERE action LIKE 'admin.%'"),
    );
    expect(ajeno.rows).toHaveLength(0);

    const parar = await stopImpersonation(call("DELETE", "/api/admin/impersonation", admin.cookie));
    expect(parar.status).toBe(200);
    const despues = await (await me(call("GET", "/api/me", admin.cookie))).json();
    expect(despues.tenant).toBeNull();
    const acciones = await withTenant(a.tenantId, (db) =>
      db.query("SELECT action FROM audit_log WHERE action LIKE 'admin.%' ORDER BY created_at"),
    );
    expect(acciones.rows.map((r) => r.action)).toEqual([
      "admin.impersonation.start",
      "admin.impersonation.stop",
    ]);
  });

  it("la suplantación caduca sola", async () => {
    const a = await register("imp3");
    const admin = await makeSuperAdmin("adm3");
    await impersonate(post("/api/admin/impersonation", { tenantId: a.tenantId, reason: "revisión de rutina larga" }, admin.cookie));
    expect((await (await me(call("GET", "/api/me", admin.cookie))).json()).tenant?.impersonating).toBe(true);
    await owner.query("UPDATE sessions SET acting_until = now() - interval '1 second' WHERE acting_tenant_id = $1", [a.tenantId]);
    expect((await (await me(call("GET", "/api/me", admin.cookie))).json()).tenant).toBeNull();
  });

  it("suspender un negocio queda auditado y se refleja en la sesión del dueño", async () => {
    const a = await register("susp");
    const admin = await makeSuperAdmin("adm4");
    const res = await tenantStatus(post("/api/admin/tenant-status", { tenantId: a.tenantId, status: "suspended" }, admin.cookie));
    expect(res.status).toBe(200);
    const info = await (await me(call("GET", "/api/me", a.cookie))).json();
    expect(info.tenant.status).toBe("suspended");
    const mal = await tenantStatus(post("/api/admin/tenant-status", { tenantId: a.tenantId, status: "inventado" }, admin.cookie));
    expect(mal.status).toBe(400);
    const log = await withTenant(a.tenantId, (db) =>
      db.query("SELECT metadata FROM audit_log WHERE action = 'admin.tenant.status'"),
    );
    expect(log.rows[0].metadata).toEqual({ from: "trial", to: "suspended" });
  });
});
