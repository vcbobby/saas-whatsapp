import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { POST as signup } from "@/app/api/auth/signup/route";
import { POST as login } from "@/app/api/auth/login/route";
import { POST as logout } from "@/app/api/auth/logout/route";
import { POST as verify2fa } from "@/app/api/auth/2fa/verify/route";
import { POST as changePassword } from "@/app/api/account/password/route";
import { POST as accept } from "@/app/api/legal/accept/route";
import { GET as me } from "@/app/api/me/route";
import { GET as catalogConfig } from "@/app/api/catalog/config/route";
import { GET as adminTenants } from "@/app/api/admin/tenants/route";
import { getPool } from "@/lib/db";
import { getSessionFromHeaders } from "@/lib/auth/session";
import { hashPassword } from "@/lib/auth/password";
import { LEGAL_VERSION } from "@/lib/legal/docs";
import { describeDevice } from "@/lib/security/device";
import { emailTemplates } from "@/lib/email/templates";
import { notifyLoginDevice } from "@/lib/email/flows";
import { codeFor, enableMfaDirect } from "./mfa-helpers";

const RUN = randomUUID().slice(0, 8);
const ORIGIN = new URL(process.env.APP_URL!).origin;
const PASSWORD = "contraseña-de-prueba-123";
const NEW_PASSWORD = `${PASSWORD}-nueva`;
const owner = new Pool({ connectionString: process.env.MIGRATION_DATABASE_URL, max: 2 });
const tenantIds: string[] = [];
const emailOf = (n: string) => `sg36-${RUN}-${n}@example.test`;

const CHROME_WIN = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";
const CHROME_WIN_NEWER = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const SAFARI_IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";
const FIREFOX_LINUX = "Mozilla/5.0 (X11; Linux x86_64; rv:132.0) Gecko/20100101 Firefox/132.0";

function api(method: string, path: string, cookie?: string, body?: unknown, ua?: string) {
  return new Request(`${ORIGIN}${path}`, {
    method,
    headers: { origin: ORIGIN, ...(ua ? { "user-agent": ua } : {}), ...(body !== undefined ? { "content-type": "application/json" } : {}), ...(cookie ? { cookie } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}
const cookieOf = (res: Response) => (res.headers.get("set-cookie") ?? "").split(";")[0]!;

async function register(name: string, extra: Record<string, unknown> = {}) {
  const email = emailOf(name);
  const res = await signup(api("POST", "/api/auth/signup", undefined, { email, password: PASSWORD, businessName: `Seg ${name}`, ...extra }));
  expect(res.status).toBe(201);
  const cookie = cookieOf(res);
  const info = await (await me(api("GET", "/api/me", cookie))).json();
  tenantIds.push(info.tenant.id);
  const userId = (await owner.query<{ id: string }>("SELECT id FROM users WHERE email = $1", [email])).rows[0]!.id;
  return { email, cookie, tenantId: info.tenant.id as string, userId };
}
const mails = (email: string) => owner.query("SELECT template, status, subject FROM email_outbox WHERE to_email = $1 ORDER BY created_at", [email]).then((r) => r.rows);
const deviceMails = async (email: string) => (await mails(email)).filter((m) => m.template === "nuevo_dispositivo");

afterEach(() => { vi.unstubAllEnvs(); });
afterAll(async () => {
  await owner.query("DELETE FROM email_outbox WHERE to_email LIKE $1", [`sg36-${RUN}-%`]);
  await owner.query("DELETE FROM users WHERE email LIKE $1", [`sg36-${RUN}-%`]);
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

describe("cambiar la contraseña con verificación en dos pasos", () => {
  it("pide el código, rechaza uno malo o repetido y no cambia nada hasta que es válido", async () => {
    const u = await register("pw2fa");
    const secret = await enableMfaDirect(owner, u.userId);
    const pw = (body: Record<string, unknown>) => changePassword(api("POST", "/api/account/password", u.cookie, { currentPassword: PASSWORD, newPassword: NEW_PASSWORD, ...body }));
    const hashOf = async () => (await owner.query("SELECT password_hash FROM users WHERE id = $1", [u.userId])).rows[0].password_hash as string;
    const before = await hashOf();

    const none = await pw({});
    expect(none.status).toBe(400);
    expect((await none.json()).error).toBe("codigo_requerido");
    const bad = await pw({ code: "000000" });
    expect(bad.status).toBe(401);
    const wrongPw = await changePassword(api("POST", "/api/account/password", u.cookie, { currentPassword: "contraseña-equivocada-1", newPassword: NEW_PASSWORD, code: codeFor(secret) }));
    expect(wrongPw.status).toBe(401);
    expect(await hashOf()).toBe(before);

    const code = codeFor(secret);
    const ok = await pw({ code });
    expect(ok.status).toBe(200);
    expect(await hashOf()).not.toBe(before);
    // el mismo código no sirve dos veces (otro cambio inmediato con el mismo código)
    const replay = await changePassword(api("POST", "/api/account/password", u.cookie, { currentPassword: NEW_PASSWORD, newPassword: `${NEW_PASSWORD}-2`, code }));
    expect(replay.status).toBe(401);
  });

  it("sin 2FA sigue funcionando solo con la contraseña actual, y la función de la base exige sesión válida", async () => {
    const u = await register("pw-sin2fa");
    const ok = await changePassword(api("POST", "/api/account/password", u.cookie, { currentPassword: PASSWORD, newPassword: NEW_PASSWORD }));
    expect(ok.status).toBe(200);
    await expect(getPool().query("SELECT auth_change_password_mfa($1, $2, $3)", [Buffer.alloc(32, 1), "x".repeat(30), 5])).rejects.toMatchObject({ code: "42501" });
  });
});

describe("términos nuevos: bloqueo hasta aceptar", () => {
  it("con LEGAL_CONSENT=required bloquea la API y las páginas hasta aceptar; permite aceptar, ver quién soy y salir", async () => {
    const u = await register("legal-block"); // se registró sin aceptar (modo de pruebas «optional»)
    expect((await catalogConfig(api("GET", "/api/catalog/config", u.cookie))).status).toBe(200);

    vi.stubEnv("LEGAL_CONSENT", "required");
    const blocked = await catalogConfig(api("GET", "/api/catalog/config", u.cookie));
    expect(blocked.status).toBe(403);
    expect((await blocked.json()).error).toBe("terminos_pendientes");
    const who = await me(api("GET", "/api/me", u.cookie));
    expect(who.status).toBe(200);
    expect((await who.json()).user.legalPending).toBe(true);

    // páginas: redirige a la pantalla de aceptación (salvo ella misma)
    await expect(getSessionFromHeaders(new Headers({ cookie: u.cookie }))).rejects.toMatchObject({ digest: expect.stringContaining("/terminos-nuevos") });
    expect((await getSessionFromHeaders(new Headers({ cookie: u.cookie }), { allowLegalPending: true }))?.session.legalPending).toBe(true);

    expect((await accept(api("POST", "/api/legal/accept", u.cookie, { version: "1999-01-01" }))).status).toBe(409);
    expect((await accept(api("POST", "/api/legal/accept", u.cookie, { version: LEGAL_VERSION }))).status).toBe(200);
    expect((await catalogConfig(api("GET", "/api/catalog/config", u.cookie))).status).toBe(200);
    expect((await getSessionFromHeaders(new Headers({ cookie: u.cookie })))?.session.legalPending).toBe(false);
  });

  it("quien aceptó al registrarse no se bloquea; en modo «optional» nadie se bloquea; salir siempre se puede", async () => {
    vi.stubEnv("LEGAL_CONSENT", "required");
    const ok = await register("legal-ok", { acceptTerms: true });
    expect((await catalogConfig(api("GET", "/api/catalog/config", ok.cookie))).status).toBe(200);

    vi.unstubAllEnvs();
    const pending = await register("legal-out");
    vi.stubEnv("LEGAL_CONSENT", "required");
    expect((await catalogConfig(api("GET", "/api/catalog/config", pending.cookie))).status).toBe(403);
    expect((await logout(api("POST", "/api/auth/logout", pending.cookie, {}))).status).toBe(200);
    vi.unstubAllEnvs();
    const other = await register("legal-opt");
    expect((await catalogConfig(api("GET", "/api/catalog/config", other.cookie))).status).toBe(200);
  });

  it("también se bloquean las rutas de súper admin hasta aceptar", async () => {
    const addr = emailOf("legal-admin");
    const ins = await owner.query<{ id: string }>("INSERT INTO users (email, password_hash, is_super_admin) VALUES ($1, $2, true) RETURNING id", [addr, await hashPassword(PASSWORD)]);
    const secret = await enableMfaDirect(owner, ins.rows[0]!.id);
    const l = await login(api("POST", "/api/auth/login", undefined, { email: addr, password: PASSWORD }));
    const v = await verify2fa(api("POST", "/api/auth/2fa/verify", cookieOf(l), { code: codeFor(secret) }));
    const cookie = cookieOf(v);
    expect((await adminTenants(api("GET", "/api/admin/tenants", cookie))).status).toBe(200);
    vi.stubEnv("LEGAL_CONSENT", "required");
    const res = await adminTenants(api("GET", "/api/admin/tenants", cookie));
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe("terminos_pendientes");
  });
});

describe("aviso de inicio de sesión desde un dispositivo nuevo", () => {
  it("describe el dispositivo sin versiones ni texto completo", () => {
    expect(describeDevice(CHROME_WIN).label).toBe("Chrome en Windows");
    expect(describeDevice(CHROME_WIN_NEWER).hash).toBe(describeDevice(CHROME_WIN).hash);
    expect(describeDevice(SAFARI_IPHONE).label).toBe("Safari en iOS");
    expect(describeDevice(FIREFOX_LINUX).label).toBe("Firefox en Linux");
    expect(describeDevice("Mozilla/5.0 (Windows NT 10.0) Chrome/130 Safari/537 Edg/130").label).toBe("Edge en Windows");
    expect(describeDevice("curl/8.0").label).toBe("Programa o script en sistema desconocido");
    expect(describeDevice(undefined).label).toBe("Navegador desconocido en sistema desconocido");
    expect(describeDevice(CHROME_WIN).hash).toMatch(/^[0-9a-f]{32}$/);
  });

  it("la plantilla no se deja inyectar y menciona qué hacer", () => {
    const m = emailTemplates.newDevice({ device: "Chrome en Windows\r\nBcc: x@y.z", ip: "1.2.3.4", when: new Date() });
    expect(m.subject).not.toMatch(/[\r\n]/);
    expect(m.text).toContain("Seguridad");
    expect(m.html).not.toContain("<script");
  });

  it("el primer dispositivo no avisa; uno nuevo sí (una vez); el mismo navegador actualizado no; máximo un aviso por hora", async () => {
    const u = await register("dev-pw");
    const log = (ua: string) => login(api("POST", "/api/auth/login", undefined, { email: u.email, password: PASSWORD }, ua));
    expect((await log(CHROME_WIN)).status).toBe(200);
    expect(await deviceMails(u.email)).toHaveLength(0); // primer dispositivo conocido
    expect((await log(CHROME_WIN_NEWER)).status).toBe(200); // mismo navegador y sistema
    expect(await deviceMails(u.email)).toHaveLength(0);
    expect((await log(SAFARI_IPHONE)).status).toBe(200); // nuevo
    const sent = await deviceMails(u.email);
    expect(sent).toHaveLength(1);
    expect(sent[0].subject).toContain("Nuevo inicio de sesión");
    expect((await log(SAFARI_IPHONE)).status).toBe(200); // ya conocido
    expect(await deviceMails(u.email)).toHaveLength(1);
    expect((await log(FIREFOX_LINUX)).status).toBe(200); // otro nuevo, pero dentro de la misma hora: no se repite el correo
    expect(await deviceMails(u.email)).toHaveLength(1);
    // quedó registrado: Firefox ya no es nuevo, y un navegador nunca visto sí lo sería
    const seen = (ua: string) => { const d = describeDevice(ua); return getPool().query("SELECT is_new FROM login_device_seen($1, $2, $3, $4)", [u.userId, d.hash, d.label, "1.2.3.4"]).then((r) => r.rows[0].is_new as boolean); };
    expect(await seen(FIREFOX_LINUX)).toBe(false);
    expect(await seen("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605 Safari/605")).toBe(true);
  });

  it("con 2FA el aviso sale al completar el código, no con solo la contraseña", async () => {
    const u = await register("dev-2fa");
    const secret = await enableMfaDirect(owner, u.userId);
    const full = async (ua: string, offset: number) => {
      const l = await login(api("POST", "/api/auth/login", undefined, { email: u.email, password: PASSWORD }, ua));
      expect((await l.json()).mfaRequired).toBe(true);
      const pendingCookie = cookieOf(l);
      return { pendingCookie, verify: () => verify2fa(api("POST", "/api/auth/2fa/verify", pendingCookie, { code: codeFor(secret, offset) }, ua)) };
    };
    const first = await full(CHROME_WIN, -1);
    expect((await first.verify()).status).toBe(200);
    expect(await deviceMails(u.email)).toHaveLength(0);
    const second = await full(SAFARI_IPHONE, 0);
    expect(await deviceMails(u.email)).toHaveLength(0); // solo contraseña: sin aviso (así no pueden llenarte la bandeja)
    expect((await second.verify()).status).toBe(200);
    expect(await deviceMails(u.email)).toHaveLength(1);
  });

  it("un fallo al avisar nunca rompe el inicio de sesión, y los dispositivos de un usuario no se ven desde la aplicación", async () => {
    const u = await register("dev-priv");
    await expect(getPool().query("SELECT * FROM login_devices")).rejects.toMatchObject({ code: "42501" });
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const spy = vi.spyOn(getPool(), "query").mockRejectedValueOnce(new Error("base caída"));
    await expect(notifyLoginDevice(u.userId, api("POST", "/api/auth/login", undefined, {}, CHROME_WIN))).resolves.toBeUndefined();
    spy.mockRestore(); err.mockRestore();
    expect((await login(api("POST", "/api/auth/login", undefined, { email: u.email, password: PASSWORD }, CHROME_WIN))).status).toBe(200);
  });
});
