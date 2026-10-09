import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, describe, expect, it } from "vitest";
import { POST as verify2fa } from "@/app/api/auth/2fa/verify/route";
import { POST as setup2fa } from "@/app/api/auth/2fa/setup/route";
import { POST as confirm2fa } from "@/app/api/auth/2fa/confirm/route";
import { POST as disable2fa } from "@/app/api/auth/2fa/disable/route";
import { POST as regenCodes } from "@/app/api/auth/2fa/codes/route";
import { POST as login } from "@/app/api/auth/login/route";
import { POST as signup } from "@/app/api/auth/signup/route";
import { GET as listTenants } from "@/app/api/admin/tenants/route";
import { GET as me } from "@/app/api/me/route";
import { GET as teamGet } from "@/app/api/team/route";
import { POST as teamInvite } from "@/app/api/team/invite/route";
import { POST as teamInvitation } from "@/app/api/team/invitation/route";
import { POST as teamRole } from "@/app/api/team/role/route";
import { POST as teamRemove } from "@/app/api/team/remove/route";
import { POST as inviteSignup } from "@/app/api/invitations/signup/route";
import { POST as inviteAccept } from "@/app/api/invitations/accept/route";
import { hashPassword } from "@/lib/auth/password";
import { hashToken } from "@/lib/auth/tokens";
import { base32Encode, hotp, verifyTotp } from "@/lib/auth/totp";
import { getPool } from "@/lib/db";
import { codeFor, enableMfaDirect } from "./mfa-helpers";

const ORIGIN = new URL(process.env.APP_URL!).origin;
const RUN = randomUUID().slice(0, 8);
const email = (n: string) => `t2-${RUN}-${n}@example.test`;
const PASSWORD = "contraseña-de-prueba-123";
const owner = new Pool({ connectionString: process.env.MIGRATION_DATABASE_URL, max: 2 });
const tenantIds: string[] = [];

function req(method: string, path: string, cookie?: string, body?: unknown) {
  return new Request(`${ORIGIN}${path}`, {
    method,
    headers: {
      origin: ORIGIN,
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
      ...(cookie ? { cookie } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}
const cookieOf = (res: Response) => (res.headers.get("set-cookie") ?? "").split(";")[0]!;

async function register(name: string) {
  const res = await signup(req("POST", "/api/auth/signup", undefined,
    { email: email(name), password: PASSWORD, businessName: `Negocio ${name}` }));
  expect(res.status).toBe(201);
  const cookie = cookieOf(res);
  const info = await (await me(req("GET", "/api/me", cookie))).json();
  tenantIds.push(info.tenant.id);
  const u = await owner.query("SELECT id FROM users WHERE email = $1", [email(name)]);
  return { cookie, tenantId: info.tenant.id as string, userId: u.rows[0].id as string, email: email(name) };
}

async function loginRaw(addr: string) {
  return login(req("POST", "/api/auth/login", undefined, { email: addr, password: PASSWORD }));
}

/** Crea un usuario con 2FA ya activo (directo en la base) y lo deja con sesión completa. */
async function userWithMfa(name: string) {
  const a = await register(name);
  const secret = await enableMfaDirect(owner, a.userId);
  return { ...a, secret };
}

afterAll(async () => {
  await owner.query("DELETE FROM users WHERE email LIKE $1", [`t2-${RUN}-%`]);
  for (const id of tenantIds) {
    const c = await owner.connect();
    try {
      await c.query("BEGIN");
      await c.query("ALTER TABLE audit_log DISABLE TRIGGER audit_log_sin_cambios");
      await c.query("DELETE FROM audit_log WHERE tenant_id = $1", [id]);
      await c.query("ALTER TABLE audit_log ENABLE TRIGGER audit_log_sin_cambios");
      await c.query("DELETE FROM tenants WHERE id = $1", [id]);
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

describe("TOTP (RFC 6238)", () => {
  const rfc = base32Encode(Buffer.from("12345678901234567890"));
  it("coincide con los vectores oficiales", () => {
    expect(hotp(rfc, Math.floor(59 / 30))).toBe("287082");
    expect(hotp(rfc, Math.floor(1111111109 / 30))).toBe("081804");
    expect(hotp(rfc, Math.floor(2000000000 / 30))).toBe("279037");
  });
  it("acepta ±1 paso y rechaza el resto o formatos raros", () => {
    const now = 1_700_000_000_000;
    const step = Math.floor(now / 30000);
    expect(verifyTotp(rfc, hotp(rfc, step), now)).toBe(step);
    expect(verifyTotp(rfc, hotp(rfc, step - 1), now)).toBe(step - 1);
    expect(verifyTotp(rfc, hotp(rfc, step + 1), now)).toBe(step + 1);
    expect(verifyTotp(rfc, hotp(rfc, step - 2), now)).toBeNull();
    expect(verifyTotp(rfc, "abcdef", now)).toBeNull();
    expect(verifyTotp(rfc, "12345", now)).toBeNull();
  });
});

describe("inicio de sesión con 2FA", () => {
  it("la contraseña sola solo da una sesión pendiente que no sirve para nada", async () => {
    const u = await userWithMfa("a1");
    const res = await loginRaw(u.email);
    expect(res.status).toBe(200);
    expect((await res.json()).mfaRequired).toBe(true);
    const pending = cookieOf(res);
    expect((await me(req("GET", "/api/me", pending))).status).toBe(401);
    expect((await teamGet(req("GET", "/api/team", pending))).status).toBe(401);
  });

  it("código correcto: cambia a una sesión NUEVA y la pendiente muere; el código no se reutiliza", async () => {
    const u = await userWithMfa("a2");
    const pending = cookieOf(await loginRaw(u.email));
    const code = codeFor(u.secret);
    const ok = await verify2fa(req("POST", "/api/auth/2fa/verify", pending, { code }));
    expect(ok.status).toBe(200);
    const full = cookieOf(ok);
    expect(full).not.toBe(pending);
    expect((await me(req("GET", "/api/me", full))).status).toBe(200);
    expect((await me(req("GET", "/api/me", pending))).status).toBe(401);

    // Mismo código otra vez (repetición) con otra sesión pendiente.
    const pending2 = cookieOf(await loginRaw(u.email));
    const replay = await verify2fa(req("POST", "/api/auth/2fa/verify", pending2, { code }));
    expect(replay.status).toBe(401);
  });

  it("5 códigos malos bloquean 15 minutos, incluso con el código bueno", async () => {
    const u = await userWithMfa("a3");
    const pending = cookieOf(await loginRaw(u.email));
    const bad = codeFor(u.secret, 5) === "000000" ? "111111" : "000000";
    let last = 0;
    for (let i = 0; i < 5; i++) {
      last = (await verify2fa(req("POST", "/api/auth/2fa/verify", pending, { code: bad }))).status;
    }
    expect(last).toBe(429);
    const again = cookieOf(await loginRaw(u.email));
    const good = await verify2fa(req("POST", "/api/auth/2fa/verify", again, { code: codeFor(u.secret, 1) }));
    expect(good.status).toBe(429);
  });

  it("código de recuperación: sirve una vez", async () => {
    const u = await userWithMfa("a4");
    const code = "ABCDE-FGHJK-LMNPQ";
    const { hashRecovery } = await import("@/lib/auth/mfa");
    await owner.query("INSERT INTO mfa_recovery_codes (user_id, code_hash) VALUES ($1, $2)", [u.userId, hashRecovery(code)]);
    const p1 = cookieOf(await loginRaw(u.email));
    const ok = await verify2fa(req("POST", "/api/auth/2fa/verify", p1, { recoveryCode: code.toLowerCase() }));
    expect(ok.status).toBe(200);
    expect((await me(req("GET", "/api/me", cookieOf(ok)))).status).toBe(200);
    const p2 = cookieOf(await loginRaw(u.email));
    const again = await verify2fa(req("POST", "/api/auth/2fa/verify", p2, { recoveryCode: code }));
    expect(again.status).toBe(401);
  });

  it("sin sesión pendiente, verify responde 401", async () => {
    const res = await verify2fa(req("POST", "/api/auth/2fa/verify", undefined, { code: "123456" }));
    expect(res.status).toBe(401);
  });
});

describe("activar, apagar y regenerar 2FA", () => {
  it("flujo completo: setup, confirmar, códigos, secreto cifrado y cierre de otras sesiones", async () => {
    const u = await register("b1");
    const other = cookieOf(await loginRaw(u.email)); // otra sesión del mismo usuario
    expect((await me(req("GET", "/api/me", other))).status).toBe(200);

    const s = await setup2fa(req("POST", "/api/auth/2fa/setup", u.cookie, {}));
    expect(s.status).toBe(200);
    const sj = await s.json();
    expect(sj.secret).toMatch(/^[A-Z2-7]{32}$/);
    expect(sj.qr).toMatch(/^data:image\/png;base64,/);

    const badConfirm = await confirm2fa(req("POST", "/api/auth/2fa/confirm", u.cookie, { code: "000000" }));
    expect(badConfirm.status).toBe(401);

    const ok = await confirm2fa(req("POST", "/api/auth/2fa/confirm", u.cookie, { code: hotp(sj.secret, Math.floor(Date.now() / 30000)) }));
    expect(ok.status).toBe(200);
    const { recoveryCodes } = await ok.json();
    expect(recoveryCodes).toHaveLength(10);
    expect(new Set(recoveryCodes).size).toBe(10);

    // En la base el secreto está cifrado y los códigos solo como hash.
    const row = await owner.query("SELECT secret_enc FROM user_mfa WHERE user_id = $1", [u.userId]);
    expect(row.rows[0].secret_enc).not.toContain(sj.secret);
    const codes = await owner.query("SELECT count(*)::int AS n FROM mfa_recovery_codes WHERE user_id = $1", [u.userId]);
    expect(codes.rows[0].n).toBe(10);

    // La sesión actual sigue; las demás se cerraron.
    expect((await me(req("GET", "/api/me", u.cookie))).status).toBe(200);
    expect((await me(req("GET", "/api/me", other))).status).toBe(401);
    // Ya activo: no se puede iniciar otra configuración.
    expect((await setup2fa(req("POST", "/api/auth/2fa/setup", u.cookie, {}))).status).toBe(409);
  });

  it("app_user no puede leer ni escribir las tablas de 2FA ni de invitaciones", async () => {
    const pool = getPool();
    for (const t of ["user_mfa", "mfa_recovery_codes", "invitations"]) {
      await expect(pool.query(`SELECT * FROM ${t}`)).rejects.toMatchObject({ code: "42501" });
    }
    await expect(pool.query("SELECT auth_issue_session($1, $2, 'x', false)", [randomUUID(), Buffer.alloc(32)]))
      .rejects.toMatchObject({ code: "42501" });
    await expect(pool.query("SELECT auth_tenant_role($1, $2)", [Buffer.alloc(32), randomUUID()]))
      .rejects.toMatchObject({ code: "42501" });
  });

  it("apagar exige contraseña Y código; regenerar invalida los anteriores", async () => {
    const u = await userWithMfa("b2");
    const full = async () => {
      const p = cookieOf(await loginRaw(u.email));
      return cookieOf(await verify2fa(req("POST", "/api/auth/2fa/verify", p, { code: codeFor(u.secret, full.n++) })));
    };
    full.n = 0;
    const c1 = await full();

    const wrongPw = await disable2fa(req("POST", "/api/auth/2fa/disable", c1, { password: "mala-contraseña-1", code: codeFor(u.secret, 1) }));
    expect(wrongPw.status).toBe(401);

    const { hashRecovery } = await import("@/lib/auth/mfa");
    await owner.query("INSERT INTO mfa_recovery_codes (user_id, code_hash) VALUES ($1, $2)", [u.userId, hashRecovery("AAAAA-BBBBB-CCCCC")]);
    const regen = await regenCodes(req("POST", "/api/auth/2fa/codes", c1, { password: PASSWORD, code: codeFor(u.secret, 1) }));
    expect(regen.status).toBe(200);
    expect((await regen.json()).recoveryCodes).toHaveLength(10);
    const old = await owner.query("SELECT count(*)::int AS n FROM mfa_recovery_codes WHERE user_id = $1 AND code_hash = $2", [u.userId, hashRecovery("AAAAA-BBBBB-CCCCC")]);
    expect(old.rows[0].n).toBe(0);

    const off = await disable2fa(req("POST", "/api/auth/2fa/disable", c1, { password: PASSWORD, code: codeFor(u.secret, 2) }));
    // el offset 2 queda fuera de la ventana: debe fallar
    expect(off.status).toBe(401);
  });

  it("apagar con contraseña y código válidos lo desactiva", async () => {
    const u = await userWithMfa("b3");
    const p = cookieOf(await loginRaw(u.email));
    const c = cookieOf(await verify2fa(req("POST", "/api/auth/2fa/verify", p, { code: codeFor(u.secret, -1) })));
    const off = await disable2fa(req("POST", "/api/auth/2fa/disable", c, { password: PASSWORD, code: codeFor(u.secret, 1) }));
    expect(off.status).toBe(200);
    const res = await loginRaw(u.email);
    expect((await res.json()).mfaRequired).toBe(false);
  });

  it("el súper admin no puede apagar su 2FA y sin 2FA no tiene poderes", async () => {
    const addr = email("sa1");
    const ins = await owner.query("INSERT INTO users (email, password_hash, is_super_admin) VALUES ($1, $2, true) RETURNING id", [addr, await hashPassword(PASSWORD)]);
    const res = await loginRaw(addr);
    const cookie = cookieOf(res);
    const info = await (await me(req("GET", "/api/me", cookie))).json();
    expect(info.user.isSuperAdmin).toBe(false);
    expect(info.user.needsMfaSetup).toBe(true);
    expect((await listTenants(req("GET", "/api/admin/tenants", cookie))).status).toBe(404);

    // Activa 2FA por la ruta normal y recupera poderes en la sesión actual.
    const s = await (await setup2fa(req("POST", "/api/auth/2fa/setup", cookie, {}))).json();
    const ok = await confirm2fa(req("POST", "/api/auth/2fa/confirm", cookie, { code: hotp(s.secret, Math.floor(Date.now() / 30000)) }));
    expect(ok.status).toBe(200);
    expect((await listTenants(req("GET", "/api/admin/tenants", cookie))).status).toBe(200);

    const off = await disable2fa(req("POST", "/api/auth/2fa/disable", cookie, { password: PASSWORD, code: hotp(s.secret, Math.floor(Date.now() / 30000) + 1) }));
    expect(off.status).toBe(403);
    // Aunque se salte la ruta, la base también lo impide.
    await expect(getPool().query("SELECT mfa_disable($1, 99999999999)", [hashToken(cookie.split("=")[1]!)]))
      .rejects.toMatchObject({ code: "42501" });
    const still = await owner.query("SELECT 1 FROM user_mfa WHERE user_id = $1 AND enabled_at IS NOT NULL", [ins.rows[0].id]);
    expect(still.rowCount).toBe(1);
  });
});

describe("equipo e invitaciones", () => {
  async function invite(cookie: string, to: string, role: "admin" | "agent") {
    const r = await teamInvite(req("POST", "/api/team/invite", cookie, { email: to, role }));
    return { status: r.status, body: await r.json() };
  }
  const tokenOf = (url: string) => url.split("/").pop()!;

  it("el dueño invita; la persona se registra con el correo de la invitación y entra al negocio", async () => {
    const o = await register("c1");
    const inv = await invite(o.cookie, email("c1-agente"), "agent");
    expect(inv.status).toBe(201);
    expect(inv.body.inviteUrl).toContain("/invitacion/");
    const token = tokenOf(inv.body.inviteUrl);

    // En la base solo existe el hash del token.
    const raw = await owner.query("SELECT encode(token_hash,'hex') AS h FROM invitations WHERE tenant_id = $1", [o.tenantId]);
    expect(raw.rows[0].h).toBe(hashToken(token).toString("hex"));

    const bad = await inviteSignup(req("POST", "/api/invitations/signup", undefined, { token: "z".repeat(43), password: PASSWORD }));
    expect(bad.status).toBe(404);

    const ok = await inviteSignup(req("POST", "/api/invitations/signup", undefined, { token, password: PASSWORD }));
    expect(ok.status).toBe(201);
    const info = await (await me(req("GET", "/api/me", cookieOf(ok)))).json();
    expect(info.user.email).toBe(email("c1-agente"));
    expect(info.tenant.id).toBe(o.tenantId);
    expect(info.tenant.role).toBe("agent");

    // Una invitación se usa una sola vez.
    const again = await inviteSignup(req("POST", "/api/invitations/signup", undefined, { token, password: PASSWORD }));
    expect(again.status).toBe(404);

    const team = await (await teamGet(req("GET", "/api/team", o.cookie))).json();
    expect(team.members.map((m: { email: string }) => m.email)).toContain(email("c1-agente"));
    expect(team.invitations).toHaveLength(0);
  });

  it("un agente no ve ni gestiona el equipo", async () => {
    const o = await register("c2");
    const token = tokenOf((await invite(o.cookie, email("c2-ag"), "agent")).body.inviteUrl);
    const ag = cookieOf(await inviteSignup(req("POST", "/api/invitations/signup", undefined, { token, password: PASSWORD })));
    expect((await teamGet(req("GET", "/api/team", ag))).status).toBe(403);
    expect((await teamInvite(req("POST", "/api/team/invite", ag, { email: email("x"), role: "agent" }))).status).toBe(403);
  });

  it("un admin solo invita y quita agentes; solo el dueño cambia roles; el dueño no se toca", async () => {
    const o = await register("c3");
    const tAdmin = tokenOf((await invite(o.cookie, email("c3-adm"), "admin")).body.inviteUrl);
    const admin = cookieOf(await inviteSignup(req("POST", "/api/invitations/signup", undefined, { token: tAdmin, password: PASSWORD })));
    const tAg = tokenOf((await invite(o.cookie, email("c3-ag"), "agent")).body.inviteUrl);
    await inviteSignup(req("POST", "/api/invitations/signup", undefined, { token: tAg, password: PASSWORD }));

    expect((await invite(admin, email("c3-otro-adm"), "admin")).status).toBe(403);
    expect((await invite(admin, email("c3-otro-ag"), "agent")).status).toBe(201);

    const team = await (await teamGet(req("GET", "/api/team", o.cookie))).json();
    const idOf = (e: string) => team.members.find((m: { email: string }) => m.email === e).userId as string;

    expect((await teamRole(req("POST", "/api/team/role", admin, { userId: idOf(email("c3-ag")), role: "admin" }))).status).toBe(403);
    expect((await teamRemove(req("POST", "/api/team/remove", admin, { userId: o.userId }))).status).toBe(403);
    expect((await teamRemove(req("POST", "/api/team/remove", o.cookie, { userId: o.userId }))).status).toBe(400);
    expect((await teamRole(req("POST", "/api/team/role", o.cookie, { userId: o.userId, role: "agent" }))).status).toBe(403);

    expect((await teamRole(req("POST", "/api/team/role", o.cookie, { userId: idOf(email("c3-ag")), role: "admin" }))).status).toBe(200);
    // Ahora ese admin ya no puede ser quitado por otro admin.
    expect((await teamRemove(req("POST", "/api/team/remove", admin, { userId: idOf(email("c3-ag")) }))).status).toBe(403);
    expect((await teamRemove(req("POST", "/api/team/remove", o.cookie, { userId: idOf(email("c3-ag")) }))).status).toBe(200);
  });

  it("quitar a alguien le corta el acceso al negocio de inmediato", async () => {
    const o = await register("c4");
    const t = tokenOf((await invite(o.cookie, email("c4-ag"), "agent")).body.inviteUrl);
    const ag = cookieOf(await inviteSignup(req("POST", "/api/invitations/signup", undefined, { token: t, password: PASSWORD })));
    const team = await (await teamGet(req("GET", "/api/team", o.cookie))).json();
    const id = team.members.find((m: { email: string }) => m.email === email("c4-ag")).userId;
    expect((await teamRemove(req("POST", "/api/team/remove", o.cookie, { userId: id }))).status).toBe(200);
    const info = await (await me(req("GET", "/api/me", ag))).json();
    expect(info.tenant).toBeNull();
  });

  it("revocar invita­ción la invalida; no se puede invitar a un miembro ni pasar de 25", async () => {
    const o = await register("c5");
    const inv = await invite(o.cookie, email("c5-x"), "agent");
    const list = await (await teamGet(req("GET", "/api/team", o.cookie))).json();
    const rev = await teamInvitation(req("POST", "/api/team/invitation", o.cookie, { invitationId: list.invitations[0].id }));
    expect(rev.status).toBe(200);
    const dead = await inviteSignup(req("POST", "/api/invitations/signup", undefined, { token: tokenOf(inv.body.inviteUrl), password: PASSWORD }));
    expect(dead.status).toBe(404);
    expect((await invite(o.cookie, o.email, "agent")).status).toBe(409);

    for (let i = 0; i < 24; i++) {
      const r = await invite(o.cookie, email(`c5-m${i}`), "agent");
      expect(r.status).toBe(201);
    }
    expect((await invite(o.cookie, email("c5-extra"), "agent")).status).toBe(409);
  });

  it("invitación vencida no sirve", async () => {
    const o = await register("c6");
    const t = tokenOf((await invite(o.cookie, email("c6-x"), "agent")).body.inviteUrl);
    await owner.query("UPDATE invitations SET expires_at = now() - interval '1 minute' WHERE tenant_id = $1", [o.tenantId]);
    expect((await inviteSignup(req("POST", "/api/invitations/signup", undefined, { token: t, password: PASSWORD }))).status).toBe(404);
  });

  it("quien ya tiene cuenta acepta con su sesión; con otro correo no", async () => {
    const o = await register("c7");
    const other = await register("c7-b");
    const stranger = await register("c7-c");
    const t = tokenOf((await invite(o.cookie, other.email, "admin")).body.inviteUrl);

    const signupExisting = await inviteSignup(req("POST", "/api/invitations/signup", undefined, { token: t, password: PASSWORD }));
    expect(signupExisting.status).toBe(409);

    expect((await inviteAccept(req("POST", "/api/invitations/accept", stranger.cookie, { token: t }))).status).toBe(404);
    expect((await inviteAccept(req("POST", "/api/invitations/accept", undefined, { token: t }))).status).toBe(401);
    expect((await inviteAccept(req("POST", "/api/invitations/accept", other.cookie, { token: t }))).status).toBe(200);
    const info = await (await me(req("GET", "/api/me", other.cookie))).json();
    expect(info.tenant.id).toBe(o.tenantId);
    expect(info.tenant.role).toBe("admin");
  });

  it("aislamiento: llamar las funciones de equipo de OTRO negocio falla en la base", async () => {
    const a = await register("c8-a");
    const b = await register("c8-b");
    const hashB = hashToken(b.cookie.split("=")[1]!);
    const pool = getPool();
    await expect(pool.query("SELECT * FROM team_members($1, $2)", [hashB, a.tenantId])).rejects.toMatchObject({ code: "42501" });
    await expect(pool.query("SELECT team_invite($1, $2, 'x@y.zz', 'agent', $3)", [hashB, a.tenantId, Buffer.alloc(32, 1)])).rejects.toMatchObject({ code: "42501" });
    await expect(pool.query("SELECT team_remove($1, $2, $3)", [hashB, a.tenantId, a.userId])).rejects.toMatchObject({ code: "42501" });
  });
});

describe("defensa en la base (aunque falle la capa web)", () => {
  it("una sesión pendiente de 2FA no sirve ni llamando directo a las funciones", async () => {
    const u = await userWithMfa("d1");
    const pending = cookieOf(await loginRaw(u.email));
    const h = hashToken(pending.split("=")[1]!);
    await expect(getPool().query("SELECT * FROM team_members($1, $2)", [h, u.tenantId])).rejects.toMatchObject({ code: "42501" });
    expect((await getPool().query("SELECT * FROM mfa_status($1)", [h])).rowCount).toBe(0);
    await expect(getPool().query("SELECT mfa_setup_start($1, 'x', 1)", [h])).rejects.toMatchObject({ code: "42501" });
  });

  it("mfa_complete rechaza en la base un paso ya usado", async () => {
    const u = await userWithMfa("d2");
    await owner.query("UPDATE user_mfa SET last_step = 5000000000 WHERE user_id = $1", [u.userId]);
    const pending = cookieOf(await loginRaw(u.email));
    const h = hashToken(pending.split("=")[1]!);
    const r = await getPool().query("SELECT mfa_complete($1, 4999999999, $2, 'x') AS age", [h, Buffer.alloc(32, 9)]);
    expect(r.rows[0].age).toBeNull();
    const ok = await getPool().query("SELECT mfa_complete($1, 5000000001, $2, 'x') AS age", [h, Buffer.alloc(32, 9)]);
    expect(ok.rows[0].age).toBeGreaterThan(0);
  });

  it("la suplantación vencida ya no da rol en el negocio", async () => {
    const sa = await (async () => {
      const addr = email("d3-sa");
      const ins = await owner.query("INSERT INTO users (email, password_hash, is_super_admin) VALUES ($1, $2, true) RETURNING id", [addr, await hashPassword(PASSWORD)]);
      const secret = await enableMfaDirect(owner, ins.rows[0].id);
      const p = cookieOf(await loginRaw(addr));
      const c = cookieOf(await verify2fa(req("POST", "/api/auth/2fa/verify", p, { code: codeFor(secret) })));
      return c;
    })();
    const t = await register("d3-t");
    const h = hashToken(sa.split("=")[1]!);
    expect((await getPool().query("SELECT admin_start_impersonation($1, $2, 'soporte de prueba largo')", [h, t.tenantId])).rowCount).toBe(1);
    expect((await getPool().query("SELECT * FROM team_members($1, $2)", [h, t.tenantId])).rowCount).toBeGreaterThan(0);
    await owner.query("UPDATE sessions SET acting_until = now() - interval '1 minute' WHERE token_hash = $1", [h]);
    await expect(getPool().query("SELECT * FROM team_members($1, $2)", [h, t.tenantId])).rejects.toMatchObject({ code: "42501" });
  });
});
