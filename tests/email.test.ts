import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, describe, expect, it, vi } from "vitest";
import { POST as signup } from "@/app/api/auth/signup/route";
import { POST as login } from "@/app/api/auth/login/route";
import { POST as forgot } from "@/app/api/auth/forgot/route";
import { POST as reset } from "@/app/api/auth/reset/route";
import { POST as verify } from "@/app/api/auth/verify/route";
import { POST as resendVerify } from "@/app/api/account/verify-email/route";
import { POST as teamInvite } from "@/app/api/team/invite/route";
import { POST as inviteSignup } from "@/app/api/invitations/signup/route";
import { GET as me } from "@/app/api/me/route";
import { getPool } from "@/lib/db";
import { devProvider, resendProvider, type EmailProvider } from "@/lib/email/provider";
import { emailTemplates } from "@/lib/email/templates";
import { EMAIL_BACKOFF, enqueueEmail, queuePlanNotices, sendDueEmails } from "@/lib/email/outbox";
import { hashToken, newSessionToken } from "@/lib/auth/tokens";

const RUN = randomUUID().slice(0, 8);
const ORIGIN = new URL(process.env.APP_URL!).origin;
const PASSWORD = "contraseña-de-prueba-123";
const owner = new Pool({ connectionString: process.env.MIGRATION_DATABASE_URL, max: 2 });
const addr = (n: string) => `em-${RUN}-${n}@example.test`;
const tenantIds: string[] = [];

function api(method: string, path: string, cookie?: string, body?: unknown) {
  return new Request(`${ORIGIN}${path}`, {
    method,
    headers: { origin: ORIGIN, ...(body !== undefined ? { "content-type": "application/json" } : {}), ...(cookie ? { cookie } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}
async function register(name: string) {
  const email = addr(name);
  const res = await signup(api("POST", "/api/auth/signup", undefined, { email, password: PASSWORD, businessName: `Negocio ${name}` }));
  expect(res.status).toBe(201);
  const cookie = (res.headers.get("set-cookie") ?? "").split(";")[0]!;
  const info = await (await me(api("GET", "/api/me", cookie))).json();
  tenantIds.push(info.tenant.id);
  const userId = (await owner.query("SELECT id FROM users WHERE email = $1", [email])).rows[0].id as string;
  return { email, cookie, tenantId: info.tenant.id as string, userId };
}
/** Otros correos pendientes (de otras pruebas o de tu uso en desarrollo) se bloquean 2 minutos para que esta prueba solo envíe los suyos. */
const isolate = () => owner.query("UPDATE email_outbox SET locked_until = now() + interval '2 minutes' WHERE status = 'pendiente' AND to_email NOT LIKE $1", [`em-${RUN}-%`]);
async function ownerTenantExec(tenantId: string, sql: string, params: unknown[] = []) {
  const c = await owner.connect();
  try {
    await c.query("BEGIN");
    await c.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
    await c.query(sql, params);
    await c.query("COMMIT");
  } finally {
    c.release();
  }
}
const outbox = (to: string) => owner.query("SELECT * FROM email_outbox WHERE to_email = $1 ORDER BY created_at", [to]).then((r) => r.rows);
const linkOf = (text: string, part: string) => text.match(new RegExp(`https?://\\S*${part}/([A-Za-z0-9_-]{43})`))![1]!;

class Fake implements EmailProvider {
  name = "resend" as const;
  purgeAfterSend = true;
  sent: string[] = [];
  mode: "ok" | "retry" | "fail" = "ok";
  async send(m: { to: string }) {
    if (this.mode === "retry") return { ok: false as const, retry: true, error: "caído" };
    if (this.mode === "fail") return { ok: false as const, retry: false, error: "rechazado" };
    this.sent.push(m.to);
    return { ok: true as const, id: "id-1" };
  }
}

afterAll(async () => {
  await owner.end();
});

describe("plantillas", () => {
  it("escapan el HTML y mantienen el asunto en una línea", () => {
    const m = emailTemplates.invitation({ url: "https://x.test/invitacion/abc", business: 'Pizzería <script>alert(1)</script>\r\nBcc: a@b.c', role: "agent", inviter: "a@b.c" });
    expect(m.html).not.toContain("<script>");
    expect(m.subject).not.toMatch(/[\r\n]/);
    expect(m.text).toContain("https://x.test/invitacion/abc");
    const t = emailTemplates.trialEnded({ business: "A&B \"x\"", url: "https://x.test/plan" });
    expect(t.html).toContain("A&amp;B");
  });
});

describe("proveedor Resend", () => {
  const cfg = { apiKey: "re_clave_de_prueba", from: "Yo <hola@ejemplo.test>" };
  const msg = { to: "a@b.test", subject: "s", text: "t", html: "<p>t</p>" };
  const res = (status: number, body: unknown = {}) => vi.fn(async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;
  it("traduce los códigos de respuesta", async () => {
    expect(await resendProvider(cfg, res(200, { id: "abc" })).send(msg)).toEqual({ ok: true, id: "abc" });
    expect(await resendProvider(cfg, res(429)).send(msg)).toMatchObject({ ok: false, retry: true });
    expect(await resendProvider(cfg, res(503)).send(msg)).toMatchObject({ ok: false, retry: true });
    expect(await resendProvider(cfg, res(401)).send(msg)).toMatchObject({ ok: false, retry: false });
    expect(await resendProvider(cfg, res(422, { message: "dominio no verificado" })).send(msg)).toMatchObject({ ok: false, retry: false, error: expect.stringContaining("dominio no verificado") });
    const down = vi.fn(async () => { throw new Error("red"); }) as unknown as typeof fetch;
    expect(await resendProvider(cfg, down).send(msg)).toMatchObject({ ok: false, retry: true });
  });
  it("manda la clave solo en la cabecera y a la dirección oficial", async () => {
    const f = vi.fn(async () => new Response("{}", { status: 200 }));
    await resendProvider(cfg, f as unknown as typeof fetch).send(msg);
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.resend.com/emails");
    expect((init.headers as Record<string, string>).authorization).toBe(`Bearer ${cfg.apiKey}`);
    expect(String(init.body)).not.toContain(cfg.apiKey);
  });
});

describe("bandeja de salida", () => {
  it("la aplicación no puede leerla ni escribirla directamente", async () => {
    await expect(getPool().query("SELECT * FROM email_outbox")).rejects.toMatchObject({ code: "42501" });
    await expect(getPool().query("INSERT INTO email_outbox (to_email, template, subject) VALUES ('a@b.test','t','s')")).rejects.toMatchObject({ code: "42501" });
  });

  it("envía, borra el cuerpo con enlaces y no repite", async () => {
    const to = addr("bandeja");
    const msg = emailTemplates.resetPassword("https://x.test/restablecer/" + "a".repeat(43));
    expect(await enqueueEmail(to, msg)).toBe(true);
    const p = new Fake();
    await isolate();
    await sendDueEmails(50, { provider: p });
    expect(p.sent).toContain(to);
    const [row] = await outbox(to);
    expect(row.status).toBe("enviado");
    expect(row.body_text).toBeNull();
    expect(row.body_html).toBeNull();
    const before = p.sent.length;
    await sendDueEmails(50, { provider: p });
    expect(p.sent.length).toBe(before);
  });

  it("el proveedor de desarrollo conserva el cuerpo (es la bandeja visible)", async () => {
    const to = addr("dev");
    await enqueueEmail(to, emailTemplates.passwordChanged());
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    await isolate();
    await sendDueEmails(50, { provider: devProvider });
    log.mockRestore();
    const [row] = await outbox(to);
    expect(row.status).toBe("enviado");
    expect(row.body_text).toContain("contraseña");
  });

  it("reintenta con espera creciente y al final marca fallido", async () => {
    const to = addr("reintento");
    await enqueueEmail(to, emailTemplates.passwordChanged());
    const p = new Fake();
    p.mode = "retry";
    await isolate();
    await sendDueEmails(50, { provider: p });
    let [row] = await outbox(to);
    expect(row.status).toBe("pendiente");
    expect(row.attempts).toBe(1);
    expect(new Date(row.next_attempt_at).getTime()).toBeGreaterThan(Date.now() + (EMAIL_BACKOFF[0] - 5) * 1000);
    // error definitivo → fallido y se borra el cuerpo
    await owner.query("UPDATE email_outbox SET next_attempt_at = now(), locked_until = NULL WHERE to_email = $1", [to]);
    p.mode = "fail";
    await isolate();
    await sendDueEmails(50, { provider: p });
    [row] = await outbox(to);
    expect(row.status).toBe("fallido");
    expect(row.last_error).toBe("rechazado");
    expect(row.body_text).toBeNull();
  });

  it("la clave de aviso evita duplicados", async () => {
    const to = addr("dup");
    const key = `test:${RUN}:dup`;
    expect(await enqueueEmail(to, emailTemplates.passwordChanged(), { dedupeKey: key })).toBe(true);
    expect(await enqueueEmail(to, emailTemplates.passwordChanged(), { dedupeKey: key })).toBe(false);
    expect((await outbox(to)).length).toBe(1);
  });
});

describe("verificar correo", () => {
  it("el registro manda el enlace; confirmarlo funciona una sola vez", async () => {
    const u = await register("ver");
    const [mail] = await outbox(u.email);
    expect(mail.template).toBe("verificar_correo");
    const token = linkOf(mail.body_text, "verificar");
    const hashRow = await owner.query("SELECT encode(token_hash,'hex') h FROM email_verifications WHERE user_id = $1", [u.userId]);
    expect(hashRow.rows[0].h).toBe(hashToken(token).toString("hex")); // solo el hash queda guardado
    expect((await getPool().query("SELECT auth_email_verified($1) v", [u.userId])).rows[0].v).toBe(false);

    expect((await verify(api("POST", "/api/auth/verify", undefined, { token: "z".repeat(43) }))).status).toBe(400);
    expect((await verify(api("POST", "/api/auth/verify", undefined, { token }))).status).toBe(200);
    expect((await getPool().query("SELECT auth_email_verified($1) v", [u.userId])).rows[0].v).toBe(true);
    expect((await verify(api("POST", "/api/auth/verify", undefined, { token }))).status).toBe(400);
  });

  it("reenviar: manda otro enlace; ya verificado no manda nada", async () => {
    const u = await register("reenvio");
    const r = await (await resendVerify(api("POST", "/api/account/verify-email", u.cookie, {}))).json();
    expect(r.sent).toBe(true);
    expect((await outbox(u.email)).length).toBe(2);
    await getPool().query("SELECT auth_mark_verified($1)", [u.userId]);
    const r2 = await (await resendVerify(api("POST", "/api/account/verify-email", u.cookie, {}))).json();
    expect(r2.sent).toBe(false);
  });

  it("un enlace vencido no sirve", async () => {
    const u = await register("venc");
    const { token, hash } = newSessionToken();
    await owner.query("INSERT INTO email_verifications (token_hash, user_id, expires_at) VALUES ($1, $2, now() - interval '1 minute')", [hash, u.userId]);
    expect((await verify(api("POST", "/api/auth/verify", undefined, { token }))).status).toBe(400);
  });
});

describe("recuperar contraseña", () => {
  it("responde igual exista o no la cuenta (y solo manda correo si existe)", async () => {
    const u = await register("rec");
    const a = await forgot(api("POST", "/api/auth/forgot", undefined, { email: u.email }));
    const b = await forgot(api("POST", "/api/auth/forgot", undefined, { email: addr("no-existe") }));
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(await a.json()).toEqual(await b.json());
    expect((await outbox(addr("no-existe"))).length).toBe(0);
    expect((await outbox(u.email)).some((m) => m.template === "recuperar_clave")).toBe(true);
  });

  it("cambia la contraseña una sola vez, cierra todas las sesiones y avisa", async () => {
    const u = await register("rec2");
    await forgot(api("POST", "/api/auth/forgot", undefined, { email: u.email }));
    const mail = (await outbox(u.email)).find((m) => m.template === "recuperar_clave")!;
    const token = linkOf(mail.body_text, "restablecer");
    const NEW = "otra-contraseña-larga-456";

    // contraseña floja o con el correo → no gasta el enlace
    expect((await reset(api("POST", "/api/auth/reset", undefined, { token, password: "corta" }))).status).toBe(400);
    const local = u.email.split("@")[0]!;
    expect((await reset(api("POST", "/api/auth/reset", undefined, { token, password: `${local}-xyz-123456` }))).status).toBe(400);
    expect((await reset(api("POST", "/api/auth/reset", undefined, { token: "z".repeat(43), password: NEW }))).status).toBe(400);

    expect((await reset(api("POST", "/api/auth/reset", undefined, { token, password: NEW }))).status).toBe(200);
    expect((await me(api("GET", "/api/me", u.cookie))).status).toBe(401); // la sesión vieja ya no sirve
    expect((await reset(api("POST", "/api/auth/reset", undefined, { token, password: NEW + "x" }))).status).toBe(400); // un solo uso
    expect((await login(api("POST", "/api/auth/login", undefined, { email: u.email, password: PASSWORD }))).status).toBe(401);
    expect((await login(api("POST", "/api/auth/login", undefined, { email: u.email, password: NEW }))).status).toBe(200);
    expect((await outbox(u.email)).some((m) => m.template === "clave_cambiada")).toBe(true);
  });

  it("máximo 3 enlaces por hora por cuenta, y un enlace vencido no sirve", async () => {
    const u = await register("rec3");
    for (let i = 0; i < 5; i++) await getPool().query("SELECT auth_request_reset($1, $2)", [u.email, newSessionToken().hash]);
    const n = await owner.query("SELECT count(*)::int c FROM password_resets WHERE user_id = $1", [u.userId]);
    expect(n.rows[0].c).toBe(3);
    const { token, hash } = newSessionToken();
    await owner.query("INSERT INTO password_resets (token_hash, user_id, expires_at) VALUES ($1, $2, now() - interval '1 minute')", [hash, u.userId]);
    expect((await reset(api("POST", "/api/auth/reset", undefined, { token, password: "otra-contraseña-larga-456" }))).status).toBe(400);
  });
});

describe("invitaciones por correo", () => {
  it("la invitación se encola y quien se registra con el enlace queda verificado", async () => {
    const o = await register("inv");
    const to = addr("invitada");
    const r = await teamInvite(api("POST", "/api/team/invite", o.cookie, { email: to, role: "agent" }));
    expect(r.status).toBe(201);
    const body = await r.json();
    expect(body.emailQueued).toBe(true);
    expect(body.inviteUrl).toContain("/invitacion/");
    const mail = (await outbox(to))[0];
    expect(mail.template).toBe("invitacion");
    expect(mail.body_text).toContain(body.inviteUrl);
    const s = await inviteSignup(api("POST", "/api/invitations/signup", undefined, { token: body.inviteUrl.split("/").pop(), password: PASSWORD, acceptTerms: true }));
    expect(s.status).toBeLessThan(300);
    const u = await owner.query("SELECT email_verified_at FROM users WHERE email = $1", [to]);
    expect(u.rows[0].email_verified_at).not.toBeNull();
  });
});

describe("avisos de plan", () => {
  it("avisa una sola vez de una prueba por vencer", async () => {
    const o = await register("aviso");
    await ownerTenantExec(o.tenantId, "UPDATE tenants SET trial_ends_at = now() + interval '2 days' WHERE id = $1", [o.tenantId]);
    // El tope es de 200 por vuelta: se repite hasta vaciar (en una base con muchos negocios de prueba hay más de una vuelta).
    for (let i = 0; i < 40 && (await queuePlanNotices()) > 0; i++);
    const got = (await outbox(o.email)).filter((m) => m.template === "prueba_por_vencer");
    expect(got.length).toBe(1);
    await queuePlanNotices();
    expect((await outbox(o.email)).filter((m) => m.template === "prueba_por_vencer").length).toBe(1);
  });
});
