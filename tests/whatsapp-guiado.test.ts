import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { POST as signup } from "@/app/api/auth/signup/route";
import { GET as me } from "@/app/api/me/route";
import { POST as connect, DELETE as disconnect } from "@/app/api/whatsapp/connect/route";
import { POST as embeddedRoute } from "@/app/api/whatsapp/embedded/route";
import { GET as statusRoute } from "@/app/api/whatsapp/status/route";
import { POST as testRoute } from "@/app/api/whatsapp/test/route";
import { decryptSecret } from "@/lib/crypto";
import { diagnosePhone, explainMetaError, looksLikePhoneNumber, normalizePhoneId, normalizeToken } from "@/lib/whatsapp/diagnose";
import { buildCsp, securityHeaders } from "@/lib/security/headers";

process.env.WHATSAPP_APP_SECRET = "secreto-de-prueba-de-la-app-meta";
process.env.WHATSAPP_VERIFY_TOKEN = "token-de-verificacion-de-prueba-123456";

const RUN = randomUUID().slice(0, 8);
const ORIGIN = new URL(process.env.APP_URL!).origin;
const PASSWORD = "contraseña-de-prueba-123";
const owner = new Pool({ connectionString: process.env.MIGRATION_DATABASE_URL, max: 2 });
const tenantIds: string[] = [];
let seq = 0;
const newPhoneId = () => `8${RUN.replace(/\D/g, "").padEnd(4, "5").slice(0, 4)}${Date.now() % 100000}${seq++}`.slice(0, 18);
const TOKEN = "EAAG-token-de-prueba-muy-largo-123456789";

function api(method: string, path: string, cookie?: string, body?: unknown) {
  return new Request(`${ORIGIN}${path}`, {
    method,
    headers: { origin: ORIGIN, ...(body !== undefined ? { "content-type": "application/json" } : {}), ...(cookie ? { cookie } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}
async function register(name: string) {
  const email = `wg-${RUN}-${name}@example.test`;
  const res = await signup(api("POST", "/api/auth/signup", undefined, { email, password: PASSWORD, businessName: `Negocio ${name}` }));
  expect(res.status).toBe(201);
  const cookie = (res.headers.get("set-cookie") ?? "").split(";")[0]!;
  const info = await (await me(api("GET", "/api/me", cookie))).json();
  tenantIds.push(info.tenant.id);
  return { cookie, tenantId: info.tenant.id as string };
}
const ownerExec = async (tenantId: string, sql: string, params: unknown[] = []) => {
  const c = await owner.connect();
  try {
    await c.query("BEGIN");
    await c.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
    const r = await c.query(sql, params);
    await c.query("COMMIT");
    return r;
  } catch (e) { await c.query("ROLLBACK"); throw e; } finally { c.release(); }
};
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const phoneOk = (id: string) => json({ id, display_phone_number: "+58 412-1234567", verified_name: "Mi Negocio", quality_rating: "GREEN" });
const metaErr = (code: number, status = 400) => json({ error: { code, message: "x" } }, status);

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
afterAll(async () => {
  await owner.query("DELETE FROM users WHERE email LIKE $1", [`wg-${RUN}-%`]);
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
});

describe("limpieza de lo que la gente pega", () => {
  it("token: quita Bearer, comillas y saltos de línea", () => {
    expect(normalizeToken('  "Bearer EAAG abc\ndef"  ')).toBe("EAAGabcdef");
    expect(normalizeToken("EAAGxyz")).toBe("EAAGxyz");
  });
  it("ID: quita espacios y detecta un teléfono en vez del ID", () => {
    expect(normalizePhoneId(" 1234 5678 ")).toBe("12345678");
    expect(looksLikePhoneNumber("+58 412 1234567")).toBe(true);
    expect(looksLikePhoneNumber("0412-1234567")).toBe(true);
    expect(looksLikePhoneNumber("584141234567")).toBe(true);
    expect(looksLikePhoneNumber("109876543210987")).toBe(false);
  });
});

describe("explicar errores de Meta", () => {
  it("cada código tiene una instrucción propia", () => {
    expect(explainMetaError(401, 190).reason).toBe("token");
    expect(explainMetaError(400, 100).reason).toBe("id");
    expect(explainMetaError(403, 10).reason).toBe("permisos");
    expect(explainMetaError(400, 200).reason).toBe("permisos");
    expect(explainMetaError(429, 4).reason).toBe("limite");
    expect(explainMetaError(500, null).reason).toBe("otro");
    for (const c of [190, 100, 10, 4]) expect(explainMetaError(400, c).message.length).toBeGreaterThan(40);
  });
  it("diagnosePhone: éxito, ID mal puesto, token vencido, sin red y otro ID", async () => {
    const ok = await diagnosePhone("12345", TOKEN, (async () => phoneOk("12345")) as unknown as typeof fetch, true);
    expect(ok.ok && ok.info.quality).toBe("GREEN");
    expect((await diagnosePhone("+58412", TOKEN, fetch)).ok).toBe(false);
    const exp = await diagnosePhone("12345", TOKEN, (async () => metaErr(190, 401)) as unknown as typeof fetch);
    expect(!exp.ok && exp.reason).toBe("token");
    const net = await diagnosePhone("12345", TOKEN, (async () => { throw new Error("x"); }) as unknown as typeof fetch);
    expect(!net.ok && net.reason).toBe("red");
    const other = await diagnosePhone("12345", TOKEN, (async () => phoneOk("99999")) as unknown as typeof fetch);
    expect(!other.ok && other.reason).toBe("id");
  });
});

describe("conectar con el asistente", () => {
  it("pegar el teléfono en vez del ID explica qué copiar, sin llamar a Meta", async () => {
    const t = await register("a1");
    const f = vi.fn(); vi.stubGlobal("fetch", f);
    const res = await connect(api("POST", "/api/whatsapp/connect", t.cookie, { phoneNumberId: "+58 412 1234567", accessToken: TOKEN }));
    expect(res.status).toBe(400);
    const j = await res.json();
    expect(j.error).toBe("id_es_telefono"); expect(j.message).toContain("Phone number ID");
    expect(f).not.toHaveBeenCalled();
  });
  it("token muy corto y token vencido tienen su mensaje", async () => {
    const t = await register("a2");
    const phone = newPhoneId();
    expect((await (await connect(api("POST", "/api/whatsapp/connect", t.cookie, { phoneNumberId: phone, accessToken: "corto" }))).json()).error).toBe("token_corto");
    vi.stubGlobal("fetch", vi.fn(async () => metaErr(190, 401)));
    const r = await connect(api("POST", "/api/whatsapp/connect", t.cookie, { phoneNumberId: phone, accessToken: TOKEN }));
    const j = await r.json();
    expect(r.status).toBe(400); expect(j.error).toBe("token_no_valido"); expect(j.message).toContain("24 horas");
  });
  it("limpia comillas y «Bearer», guarda cifrado y marca cómo se conectó", async () => {
    const t = await register("a3");
    const phone = newPhoneId();
    const f = vi.fn(async () => phoneOk(phone)); vi.stubGlobal("fetch", f);
    const res = await connect(api("POST", "/api/whatsapp/connect", t.cookie, { phoneNumberId: ` ${phone} `, accessToken: `"Bearer ${TOKEN}"\n` }));
    expect(res.status).toBe(201);
    const row = (await ownerExec(t.tenantId, "SELECT secret_enc, key_version, connected_via, waba_id FROM tenant_integrations WHERE external_id = $1", [phone])).rows[0];
    expect(decryptSecret(row.secret_enc, `wa:${t.tenantId}:${phone}`, row.key_version)).toBe(TOKEN);
    expect(row.connected_via).toBe("manual"); expect(row.waba_id).toBeNull();
  });
});

describe("comprobar conexión y mensaje de prueba", () => {
  async function connected(name: string) {
    const t = await register(name);
    const phone = newPhoneId();
    vi.stubGlobal("fetch", vi.fn(async () => phoneOk(phone)));
    expect((await connect(api("POST", "/api/whatsapp/connect", t.cookie, { phoneNumberId: phone, accessToken: TOKEN }))).status).toBe(201);
    return { ...t, phone };
  }
  it("status: dice que va bien, muestra la calidad y NUNCA devuelve el token", async () => {
    const t = await connected("s1");
    vi.stubGlobal("fetch", vi.fn(async () => phoneOk(t.phone)));
    const j = await (await statusRoute(api("GET", "/api/whatsapp/status", t.cookie))).json();
    expect(j.ok).toBe(true); expect(j.quality).toBe("GREEN");
    expect(JSON.stringify(j)).not.toContain(TOKEN);
  });
  it("status: si el token venció lo explica; sin número da 404", async () => {
    const t = await connected("s2");
    vi.stubGlobal("fetch", vi.fn(async () => metaErr(190, 401)));
    const j = await (await statusRoute(api("GET", "/api/whatsapp/status", t.cookie))).json();
    expect(j.ok).toBe(false); expect(j.problem.reason).toBe("token");
    const empty = await register("s3");
    expect((await statusRoute(api("GET", "/api/whatsapp/status", empty.cookie))).status).toBe(404);
  });
  it("prueba: envía el texto y valida el teléfono", async () => {
    const t = await connected("p1");
    const f = vi.fn(async () => json({ messages: [{ id: "wamid.TEST123456" }] })); vi.stubGlobal("fetch", f);
    expect((await testRoute(api("POST", "/api/whatsapp/test", t.cookie, { to: "abc" }))).status).toBe(422);
    const res = await testRoute(api("POST", "/api/whatsapp/test", t.cookie, { to: "+58 414-1234567" }));
    expect(res.status).toBe(200);
    const sent = JSON.parse((f.mock.calls[0] as unknown as [string, RequestInit])[1].body as string);
    expect(sent.to).toBe("584141234567"); expect(sent.type).toBe("text");
  });
  it("prueba: sin ventana de 24 h usa la plantilla hello_world", async () => {
    const t = await connected("p2");
    const f = vi.fn().mockResolvedValueOnce(metaErr(131047)).mockResolvedValueOnce(json({ messages: [{ id: "wamid.TPL1234567" }] }));
    vi.stubGlobal("fetch", f);
    const j = await (await testRoute(api("POST", "/api/whatsapp/test", t.cookie, { to: "584141234567" }))).json();
    expect(j.via).toBe("plantilla");
    expect(JSON.parse((f.mock.calls[1] as unknown as [string, RequestInit])[1].body as string).template.name).toBe("hello_world");
  });
  it("prueba: errores de Meta traducidos (destinatario no permitido, token vencido) y sin número", async () => {
    const t = await connected("p3");
    vi.stubGlobal("fetch", vi.fn(async () => metaErr(131030)));
    const a = await testRoute(api("POST", "/api/whatsapp/test", t.cookie, { to: "584141234567" }));
    expect(a.status).toBe(422); expect((await a.json()).message).toContain("lista de destinatarios");
    vi.stubGlobal("fetch", vi.fn(async () => metaErr(190, 401)));
    expect((await (await testRoute(api("POST", "/api/whatsapp/test", t.cookie, { to: "584141234567" }))).json()).message).toContain("token");
    const empty = await register("p4");
    expect((await testRoute(api("POST", "/api/whatsapp/test", empty.cookie, { to: "584141234567" }))).status).toBe(409);
  });
  it("prueba: máximo 5 por hora", async () => {
    const t = await connected("p5");
    vi.stubGlobal("fetch", vi.fn(async () => json({ messages: [{ id: "wamid.LIMITE1234" }] })));
    for (let i = 0; i < 5; i++) expect((await testRoute(api("POST", "/api/whatsapp/test", t.cookie, { to: "584141234567" }))).status).toBe(200);
    expect((await testRoute(api("POST", "/api/whatsapp/test", t.cookie, { to: "584141234567" }))).status).toBe(429);
  });
});

describe("conexión con un clic (Embedded Signup)", () => {
  const enable = () => { vi.stubEnv("EMBEDDED_SIGNUP_ENABLED", "true"); vi.stubEnv("META_APP_ID", "123456789012345"); vi.stubEnv("META_ES_CONFIG_ID", "987654321098765"); };
  const BIZ = "EAAB-token-del-negocio-largo-1234567890";
  const WABA = "555000111222";
  function metaFlow(phone: string, over: { oauth?: Response; subscribe?: Response; register?: Response } = {}) {
    return vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const u = String(input);
      if (u.includes("/oauth/access_token")) return over.oauth ?? json({ access_token: BIZ });
      if (u.includes("/subscribed_apps")) return over.subscribe ?? json({ success: true });
      if (u.includes("/register")) return over.register ?? json({ success: true });
      if (u.includes(`/${phone}?`)) { expect((init?.headers as Record<string, string>).Authorization).toBe(`Bearer ${BIZ}`); return phoneOk(phone); }
      throw new Error("llamada inesperada " + u);
    });
  }
  it("apagado por defecto: la ruta no existe", async () => {
    const t = await register("e0");
    expect((await embeddedRoute(api("POST", "/api/whatsapp/embedded", t.cookie, { code: "x".repeat(20), phoneNumberId: "12345", wabaId: "12345" }))).status).toBe(404);
  });
  it("flujo completo: cambia el código, comprueba, suscribe, registra y guarda con la cuenta WABA", async () => {
    enable();
    const t = await register("e1"); const phone = newPhoneId();
    const f = metaFlow(phone); vi.stubGlobal("fetch", f);
    const res = await embeddedRoute(api("POST", "/api/whatsapp/embedded", t.cookie, { code: "codigo-de-un-solo-uso-123", phoneNumberId: phone, wabaId: WABA }));
    expect(res.status).toBe(201);
    const row = (await ownerExec(t.tenantId, "SELECT secret_enc, key_version, connected_via, waba_id FROM tenant_integrations WHERE external_id = $1", [phone])).rows[0];
    expect(row.connected_via).toBe("embedded"); expect(row.waba_id).toBe(WABA);
    expect(decryptSecret(row.secret_enc, `wa:${t.tenantId}:${phone}`, row.key_version)).toBe(BIZ);
    // El secreto de la app viaja por POST (cuerpo), nunca en la dirección.
    const oauth = f.mock.calls.find((c) => String(c[0]).includes("/oauth/access_token"))!;
    expect(String(oauth[0])).not.toContain("secreto-de-prueba"); expect(String((oauth[1] as RequestInit).body)).toContain("client_secret=");
    const urls = f.mock.calls.map((c) => String(c[0]));
    expect(urls.some((u) => u.includes(`/${WABA}/subscribed_apps`))).toBe(true);
    expect(urls.some((u) => u.includes(`/${phone}/register`))).toBe(true);
    expect((await disconnect(api("DELETE", "/api/whatsapp/connect", t.cookie))).status).toBe(200);
  });
  it("código inválido o suscripción fallida: no se guarda nada", async () => {
    enable();
    const t = await register("e2"); const phone = newPhoneId();
    vi.stubGlobal("fetch", metaFlow(phone, { oauth: metaErr(100) }));
    const bad = await embeddedRoute(api("POST", "/api/whatsapp/embedded", t.cookie, { code: "codigo-de-un-solo-uso-123", phoneNumberId: phone, wabaId: WABA }));
    expect(bad.status).toBe(400); expect((await bad.json()).error).toBe("codigo_invalido");
    vi.stubGlobal("fetch", metaFlow(phone, { subscribe: metaErr(100) }));
    expect((await embeddedRoute(api("POST", "/api/whatsapp/embedded", t.cookie, { code: "codigo-de-un-solo-uso-123", phoneNumberId: phone, wabaId: WABA }))).status).toBe(502);
    expect((await ownerExec(t.tenantId, "SELECT count(*)::int AS n FROM tenant_integrations WHERE tenant_id = $1", [t.tenantId])).rows[0].n).toBe(0);
  });
  it("si el registro del número falla, conecta igual y avisa", async () => {
    enable();
    const t = await register("e3"); const phone = newPhoneId();
    vi.stubGlobal("fetch", metaFlow(phone, { register: metaErr(100) }));
    const res = await embeddedRoute(api("POST", "/api/whatsapp/embedded", t.cookie, { code: "codigo-de-un-solo-uso-123", phoneNumberId: phone, wabaId: WABA }));
    expect(res.status).toBe(201); expect((await res.json()).warnings.length).toBe(1);
  });
  it("datos mal formados se rechazan", async () => {
    enable();
    const t = await register("e4");
    expect((await embeddedRoute(api("POST", "/api/whatsapp/embedded", t.cookie, { code: "corto", phoneNumberId: "abc", wabaId: "1" }))).status).toBe(400);
  });
});

describe("seguridad de la página con la conexión de un clic", () => {
  const prod = { appEnv: "production", dev: false };
  it("apagada: nada de Facebook en la política de seguridad y ventanas aisladas", () => {
    const csp = buildCsp(prod);
    expect(csp).not.toContain("facebook"); expect(csp).toContain("frame-src 'none'");
    expect(securityHeaders(prod)["Cross-Origin-Opener-Policy"]).toBe("same-origin");
  });
  it("encendida: solo lo mínimo de Facebook y ventanas emergentes permitidas", () => {
    const csp = buildCsp({ ...prod, embeddedSignup: true });
    expect(csp).toContain("script-src 'self' 'unsafe-inline' https://connect.facebook.net");
    expect(csp).toContain("frame-src https://www.facebook.com https://web.facebook.com");
    expect(csp).toContain("object-src 'none'");
    expect(securityHeaders({ ...prod, embeddedSignup: true })["Cross-Origin-Opener-Policy"]).toBe("same-origin-allow-popups");
  });
});
