import { createHash, randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { afterAll, describe, expect, it } from "vitest";
import { POST as login } from "@/app/api/auth/login/route";
import { POST as signup } from "@/app/api/auth/signup/route";
import { POST as verify2fa } from "@/app/api/auth/2fa/verify/route";
import { GET as me } from "@/app/api/me/route";
import { recordAiError } from "@/lib/ai/errors";
import { adoptionPct, formatTokens, getAdminUsage, healthItems, safetyItems, type AdminUsage } from "@/lib/admin/usage";
import { hashPassword } from "@/lib/auth/password";
import { getPool } from "@/lib/db";
import { codeFor, enableMfaDirect } from "./mfa-helpers";

const RUN = randomUUID().slice(0, 8);
const ORIGIN = new URL(process.env.APP_URL!).origin;
const PASSWORD = "contraseña-de-prueba-123";
const owner = new Pool({ connectionString: process.env.MIGRATION_DATABASE_URL, max: 2 });

const req = (method: string, path: string, cookie?: string, body?: unknown) =>
  new Request(`${ORIGIN}${path}`, { method, headers: { origin: ORIGIN, ...(body !== undefined ? { "content-type": "application/json" } : {}), ...(cookie ? { cookie } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
const cookieOf = (res: Response) => (res.headers.get("set-cookie") ?? "").split(";")[0]!;
const hashOf = (cookie: string) => createHash("sha256").update(cookie.split("=")[1]!).digest();

async function register(name: string) {
  const res = await signup(req("POST", "/api/auth/signup", undefined, { email: `us-${RUN}-${name}@example.test`, password: PASSWORD, businessName: `Uso ${name} ${RUN}` }));
  expect(res.status).toBe(201);
  const cookie = cookieOf(res);
  const info = await (await me(req("GET", "/api/me", cookie))).json();
  return { cookie, tenantId: info.tenant.id as string };
}
type T = Awaited<ReturnType<typeof register>>;

async function superAdmin(name: string) {
  const addr = `us-${RUN}-${name}@example.test`;
  const ins = await owner.query<{ id: string }>("INSERT INTO users (email, password_hash, is_super_admin) VALUES ($1,$2,true) RETURNING id", [addr, await hashPassword(PASSWORD)]);
  const secret = await enableMfaDirect(owner, ins.rows[0]!.id);
  const res = await login(req("POST", "/api/auth/login", undefined, { email: addr, password: PASSWORD }));
  const ver = await verify2fa(req("POST", "/api/auth/2fa/verify", cookieOf(res), { code: codeFor(secret) }));
  expect(ver.status).toBe(200);
  return cookieOf(ver);
}

/** Datos de un negocio como dueño de la base (con el contexto del negocio, por el RLS forzado). */
async function seed(t: T, fn: (c: PoolClient) => Promise<void>) {
  const c = await owner.connect();
  try {
    await c.query("BEGIN");
    await c.query("SELECT set_config('app.tenant_id', $1, true)", [t.tenantId]);
    await fn(c);
    await c.query("COMMIT");
  } catch (e) { await c.query("ROLLBACK"); throw e; } finally { c.release(); }
}
const ID = (r: { rows: { id: string }[] }) => r.rows[0]!.id;

afterAll(async () => { await owner.end(); });

const mod = (u: AdminUsage, key: string) => u.modules.find((m) => m.key === key)!.tenants;

async function scenario(h: Buffer, tag: string) {
    const before = await getAdminUsage(h);
    const A = await register(`a${tag}`);
    const B = await register(`b${tag}`);
    try {
    await scenarioBody(h, before, A, B, tag);
    } finally {
      // Los consumos enormes se borran: si no, llenarían el «top 10» de las ejecuciones siguientes.
      for (const t of [A, B]) await seed(t, async (c) => { await c.query("DELETE FROM agent_usage_daily"); await c.query("DELETE FROM copilot_usage_daily"); });
    }
}

async function scenarioBody(h: Buffer, before: AdminUsage, A: T, B: T, tag: string) {

    await seed(A, async (c) => {
      await c.query("INSERT INTO agent_usage_daily (tenant_id, day, replies, input_tokens, output_tokens, ai_errors) VALUES ($1, (now() AT TIME ZONE 'utc')::date, 5, 900000000000, 100000000000, 2)", [A.tenantId]);
      await c.query("INSERT INTO copilot_usage_daily (tenant_id, day, questions, input_tokens, output_tokens, ai_errors) VALUES ($1, (now() AT TIME ZONE 'utc')::date, 3, 200, 100, 1)", [A.tenantId]);
      const contact = ID(await c.query("INSERT INTO contacts (tenant_id, wa_id) VALUES ($1, $2) RETURNING id", [A.tenantId, `5841${RUN}1`]));
      const conv = ID(await c.query("INSERT INTO conversations (tenant_id, contact_id) VALUES ($1,$2) RETURNING id", [A.tenantId, contact]));
      for (let i = 0; i < 4; i++) await c.query("INSERT INTO messages (tenant_id, conversation_id, direction) VALUES ($1,$2,'in')", [A.tenantId, conv]);
      await c.query("INSERT INTO messages (tenant_id, conversation_id, direction, process_state) VALUES ($1,$2,'in','failed')", [A.tenantId, conv]);
      await c.query("INSERT INTO messages (tenant_id, conversation_id, direction, send_state) VALUES ($1,$2,'out','failed')", [A.tenantId, conv]);
      await c.query("INSERT INTO messages (tenant_id, conversation_id, direction, delivery_status) VALUES ($1,$2,'out','failed')", [A.tenantId, conv]);
      await c.query("INSERT INTO messages (tenant_id, conversation_id, direction, send_state) VALUES ($1,$2,'out','sent')", [A.tenantId, conv]);
      // Un mensaje de hace 40 días no cuenta en los 30 días ni en los 7.
      await c.query("INSERT INTO messages (tenant_id, conversation_id, direction, created_at, send_state) VALUES ($1,$2,'out', now() - interval '40 days', 'failed')", [A.tenantId, conv]);
      const m1 = ID(await c.query("INSERT INTO messages (tenant_id, conversation_id, direction) VALUES ($1,$2,'in') RETURNING id", [A.tenantId, conv]));
      for (const kind of ["inyeccion", "inyeccion", "fuga_prompt", "salida_bloqueada", "salida_bloqueada", "salida_bloqueada", "limite_contacto", "limite_contacto", "limite_contacto", "limite_contacto"]) {
        const mid = ID(await c.query("INSERT INTO messages (tenant_id, conversation_id, direction) VALUES ($1,$2,'in') RETURNING id", [A.tenantId, conv]));
        await c.query("INSERT INTO agent_events (tenant_id, conversation_id, message_id, kind) VALUES ($1,$2,$3,$4)", [A.tenantId, conv, mid, kind]);
      }
      void m1;
      await c.query("INSERT INTO kb_documents (tenant_id, title, content, status) VALUES ($1,'ok','x','ready'), ($1,'mal','x','failed')", [A.tenantId]);
      await c.query("INSERT INTO automation_rules (tenant_id, name, trigger_event, task_title, active) VALUES ($1,'r','order.created','t', true), ($1,'r2','order.created','t', false)", [A.tenantId]);
      const svc = ID(await c.query("INSERT INTO agenda_services (tenant_id, name, duration_minutes) VALUES ($1,'s',30) RETURNING id", [A.tenantId]));
      await c.query("INSERT INTO appointments (tenant_id, service_id, customer_name, starts_at, ends_at, source) VALUES ($1,$2,'c', now() + interval '1 day', now() + interval '1 day 30 minutes', 'manual')", [A.tenantId, svc]);
      await c.query("INSERT INTO webhook_endpoints (tenant_id, url, events, secret_enc, key_version, active) VALUES ($1, 'https://example.test/hook', '{order.created}', 'x', 1, true)", [A.tenantId]);
    });
    await seed(B, async (c) => {
      await c.query("INSERT INTO agent_usage_daily (tenant_id, day, replies, input_tokens, output_tokens) VALUES ($1, (now() AT TIME ZONE 'utc')::date, 2, 100000000000, 50000000000)", [B.tenantId]);
      const contact = ID(await c.query("INSERT INTO contacts (tenant_id, wa_id) VALUES ($1, $2) RETURNING id", [B.tenantId, `5841${RUN}2`]));
      const conv = ID(await c.query("INSERT INTO conversations (tenant_id, contact_id) VALUES ($1,$2) RETURNING id", [B.tenantId, contact]));
      await c.query("INSERT INTO messages (tenant_id, conversation_id, direction) VALUES ($1,$2,'out')", [B.tenantId, conv]); // solo salientes: no cuenta como «con actividad»
      // Casos que NO deben contar: copiloto sin preguntas, regla y conexión apagadas, cita de hace 40 días, documento fallido, negocio suspendido.
      await c.query("INSERT INTO copilot_usage_daily (tenant_id, day, questions) VALUES ($1, (now() AT TIME ZONE 'utc')::date, 0)", [B.tenantId]);
      await c.query("INSERT INTO automation_rules (tenant_id, name, trigger_event, task_title, active) VALUES ($1,'r','order.created','t', false)", [B.tenantId]);
      await c.query("INSERT INTO webhook_endpoints (tenant_id, url, events, secret_enc, key_version, active) VALUES ($1, 'https://example.test/hook', '{order.created}', 'x', 1, false)", [B.tenantId]);
      const svcB = ID(await c.query("INSERT INTO agenda_services (tenant_id, name, duration_minutes) VALUES ($1,'s',30) RETURNING id", [B.tenantId]));
      await c.query("INSERT INTO appointments (tenant_id, service_id, customer_name, starts_at, ends_at, source, created_at) VALUES ($1,$2,'c', now() + interval '1 day', now() + interval '1 day 30 minutes', 'manual', now() - interval '40 days')", [B.tenantId, svcB]);
      await c.query("UPDATE tenants SET status = 'suspended' WHERE id = $1", [B.tenantId]);
      const prod = ID(await c.query("INSERT INTO catalog_products (tenant_id, name, price_minor) VALUES ($1, 'p', 500) RETURNING id", [B.tenantId]));
      const ord = ID(await c.query("INSERT INTO orders (tenant_id, number, customer_name, source, currency, total_minor) VALUES ($1, 1, 'c', 'manual', 'USD', 500) RETURNING id", [B.tenantId]));
      await c.query("INSERT INTO order_items (tenant_id, order_id, product_id, position, name, unit_price_minor, quantity, line_total_minor) VALUES ($1,$2,$3,1,'p',500,1,500)", [B.tenantId, ord, prod]);
      await c.query("INSERT INTO kb_documents (tenant_id, title, content, status) VALUES ($1,'mal','x','failed')", [B.tenantId]);
    });

    // Un tercer negocio con una conexión apagada: así «solo las activas» se distingue de «solo las apagadas».
    const C = await register(`c${tag}`);
    await seed(C, async (c) => {
      await c.query("INSERT INTO webhook_endpoints (tenant_id, url, events, secret_enc, key_version, active) VALUES ($1, 'https://example.test/hook', '{order.created}', 'x', 1, false)", [C.tenantId]);
    });

    const after = await getAdminUsage(h);
    const d = (f: (u: AdminUsage) => number) => f(after) - f(before);
    expect(d((u) => u.totals30.activeTenants)).toBe(1); // B solo tiene mensajes salientes
    expect(d((u) => u.totals30.liveTenants)).toBe(2); // A y C; B está suspendido
    expect(d((u) => u.totals30.messagesIn)).toBe(4 + 1 + 1 + 10); // A: 4 + 1 sin procesar + 1 + 10 de los eventos; B: ninguno
    expect(d((u) => u.totals30.messagesOut)).toBe(4); // A: 3 de hoy (el de hace 40 días no cuenta) + 1 de B
    expect(d((u) => u.totals30.agentReplies)).toBe(7);
    expect(d((u) => u.totals30.agentTokens)).toBe(1_150_000_000_000);
    expect(d((u) => u.totals30.copilotQuestions)).toBe(3);
    expect(d((u) => u.totals30.copilotTokens)).toBe(300);
    expect(d((u) => u.totals30.agentErrors)).toBe(2);
    expect(d((u) => u.totals30.copilotErrors)).toBe(1);
    // Módulos
    expect(mod(after, "asistente") - mod(before, "asistente")).toBe(2);
    expect(mod(after, "copiloto") - mod(before, "copiloto")).toBe(1);
    expect(mod(after, "agenda") - mod(before, "agenda")).toBe(1);
    expect(mod(after, "pedidos") - mod(before, "pedidos")).toBe(1);
    expect(mod(after, "conocimiento") - mod(before, "conocimiento")).toBe(1); // el documento fallido de B no cuenta
    expect(mod(after, "automatizaciones") - mod(before, "automatizaciones")).toBe(1); // la regla apagada no cuenta
    expect(mod(after, "conexiones") - mod(before, "conexiones")).toBe(1); // la conexión apagada de B no cuenta
    // Salud
    const hd = (k: keyof AdminUsage["health7"]) => after.health7[k] - before.health7[k];
    expect(hd("sendFailed")).toBe(1); // el de hace 40 días no cuenta
    expect(hd("deliveryFailed")).toBe(1);
    expect(hd("processFailed")).toBe(1);
    expect(hd("aiErrors")).toBe(3);
    expect(hd("kbFailed")).toBe(2);
    expect(hd("injection")).toBe(2);
    expect(hd("promptLeak")).toBe(1);
    expect(hd("blockedOutput")).toBe(3);
    expect(hd("contactLimited")).toBe(4);
    // Gráfica diaria: los de hoy
    const last = (u: AdminUsage) => u.daily.at(-1)!;
    expect(after.daily).toHaveLength(14);
    expect(last(after).day).toBe(after.today);
    expect(last(after).replies - last(before).replies).toBe(7);
    expect(last(after).tokens - last(before).tokens).toBe(1_150_000_000_300);
    expect(last(after).errors - last(before).errors).toBe(3);
    // Top: A por encima de B, con sus cifras (consumos enormes a propósito: así entran al top 10 aunque otras pruebas dejen datos)
    const topA = after.top.find((r) => r.name.includes(`a${tag} ${RUN}`));
    const topB = after.top.find((r) => r.name.includes(`b${tag} ${RUN}`));
    expect(topA).toMatchObject({ replies: 5, questions: 3, tokens: 1_000_000_000_300, errors: 3 });
    expect(topB).toMatchObject({ replies: 2, tokens: 150_000_000_000, errors: 0 });
    expect(after.top.length).toBeLessThanOrEqual(10);
    expect(after.top.map((r) => r.tokens)).toEqual([...after.top.map((r) => r.tokens)].sort((x, y) => y - x));
    // No sale ningún texto de mensajes ni datos de clientes.
    expect(JSON.stringify(after)).not.toContain(`5841${RUN}`);
}

describe("uso y salud (admin_usage)", () => {
  it("solo lo lee un súper admin con verificación en dos pasos", async () => {
    const a = await register("normal");
    await expect(getPool().query("SELECT admin_usage($1)", [hashOf(a.cookie)])).rejects.toMatchObject({ code: "42501" });
    await expect(getPool().query("SELECT admin_usage($1)", [Buffer.alloc(32, 2)])).rejects.toMatchObject({ code: "42501" });
  });

  it("suma consumo, módulos y salud entre negocios, y muestra el top de IA", async () => {
    const adm = await superAdmin("adm1");
    const h = hashOf(adm);
    // Otras pruebas corren a la vez y también escriben mensajes: si una cifra global se descuadra por eso, se repite con negocios nuevos.
    let last: unknown;
    for (let i = 0; i < 4; i++) {
      try { await scenario(h, `${i}`); return; } catch (e) { last = e; }
    }
    throw last;
  });

  it("la lectura entre negocios no existe fuera de admin_usage", async () => {
    const a = await register("aislado");
    // Aunque alguien active la marca, la aplicación no puede leer filas de otros negocios.
    const rows = await getPool().connect();
    try {
      await rows.query("BEGIN");
      await rows.query("SELECT set_config('app.admin_read', '1', true)");
      await rows.query("SELECT set_config('app.tenant_id', $1, true)", [a.tenantId]);
      const r = await rows.query("SELECT DISTINCT tenant_id FROM messages");
      expect(r.rows.every((x) => x.tenant_id === a.tenantId)).toBe(true);
      await rows.query("ROLLBACK");
    } finally { rows.release(); }
    // Y el dueño de la base de datos (conexión directa) tampoco gana acceso por la marca.
    const c = await owner.connect();
    try {
      await c.query("BEGIN");
      await c.query("SELECT set_config('app.admin_read', '1', true)");
      await c.query("SELECT set_config('app.tenant_id', $1, true)", [a.tenantId]);
      const r = await c.query("SELECT DISTINCT tenant_id FROM agent_usage_daily");
      expect(r.rows.every((x) => x.tenant_id === a.tenantId)).toBe(true);
      await c.query("ROLLBACK");
    } finally { c.release(); }
  });

  it("anotar un fallo de IA suma 1 por día y nunca lanza", async () => {
    const a = await register("err");
    await recordAiError(a.tenantId, "agent");
    await recordAiError(a.tenantId, "agent");
    await recordAiError(a.tenantId, "copilot");
    const q = (tbl: string) => seedRead(a, `SELECT ai_errors FROM ${tbl}`);
    expect(await q("agent_usage_daily")).toBe(2);
    expect(await q("copilot_usage_daily")).toBe(1);
    // Un negocio que no existe: no lanza (el error se anota en el registro del servidor).
    await expect(recordAiError(randomUUID(), "agent")).resolves.toBeUndefined();
  });
});

async function seedRead(t: T, sql: string): Promise<number> {
  let out = -1;
  await seed(t, async (c) => { out = Number((await c.query(sql)).rows[0].ai_errors); });
  return out;
}

const base: AdminUsage["health7"] = { sendFailed: 0, deliveryFailed: 0, processFailed: 0, aiErrors: 0, kbFailed: 0, webhooksFailed: 0, notificationsFailed: 0, injection: 0, promptLeak: 0, blockedOutput: 0, contactLimited: 0 };

describe("textos y cálculos del panel", () => {
  it("el semáforo: verde en 0, aviso con cualquier fallo, y cada fallo en su línea", () => {
    expect(healthItems(base).every((i) => i.level === "ok")).toBe(true);
    const w = healthItems({ ...base, aiErrors: 3, kbFailed: 1 }).filter((i) => i.level === "warn");
    expect(w.map((i) => [i.key, i.n])).toEqual([["aiErrors", 3], ["kbFailed", 1]]);
    for (const i of healthItems(base)) expect(i.hint.length).toBeGreaterThan(20);
  });

  it("los frenos de seguridad se cuentan aparte de los errores", () => {
    expect(safetyItems({ ...base, injection: 4, promptLeak: 1, blockedOutput: 2, contactLimited: 3 }).map((s) => s.n)).toEqual([4, 1, 2, 3]);
    expect(healthItems({ ...base, injection: 9 }).every((i) => i.level === "ok")).toBe(true);
  });

  it("tokens legibles", () => {
    expect(formatTokens(950)).toBe("950");
    expect(formatTokens(9999)).toBe((9999).toLocaleString("es"));
    expect(formatTokens(12_300)).toBe("12,3 mil");
    expect(formatTokens(1_250_000)).toBe("1,25 M");
    expect(formatTokens(999_999_999)).toBe("1000 M");
    expect(formatTokens(4_600_000_060_000)).toBe("4600 mil M");
  });

  it("adopción de un módulo: porcentaje acotado y sin dividir entre cero", () => {
    expect(adoptionPct(1, 4)).toBe(25);
    expect(adoptionPct(5, 4)).toBe(100);
    expect(adoptionPct(3, 0)).toBe(0);
  });
});
