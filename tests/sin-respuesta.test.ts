import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { POST as signup } from "@/app/api/auth/signup/route";
import { GET as me } from "@/app/api/me/route";
import { getPool, withTenant } from "@/lib/db";
import { encryptSecret } from "@/lib/crypto";

const RUN = randomUUID().slice(0, 8);
const ORIGIN = new URL(process.env.APP_URL!).origin;
const PASSWORD = "contraseña-de-prueba-123";
const owner = new Pool({ connectionString: process.env.MIGRATION_DATABASE_URL, max: 2 });
const tenantIds: string[] = [];
let seq = 0;

function api(method: string, path: string, cookie?: string, body?: unknown, origin = ORIGIN) {
  return new Request(`${ORIGIN}${path}`, {
    method,
    headers: { origin, ...(body !== undefined ? { "content-type": "application/json" } : {}), ...(cookie ? { cookie } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

async function register(name: string) {
  const email = `su-${RUN}-${name}@example.test`;
  const res = await signup(api("POST", "/api/auth/signup", undefined, { email, password: PASSWORD, businessName: `Negocio ${name}` }));
  expect(res.status).toBe(201);
  const cookie = (res.headers.get("set-cookie") ?? "").split(";")[0]!;
  const info = await (await me(api("GET", "/api/me", cookie))).json();
  tenantIds.push(info.tenant.id);
  const phoneId = `7${Date.now() % 1000000000}${seq++}`.slice(0, 16);
  const enc = encryptSecret("EAAtoken-de-prueba-1234567890", `wa:${info.tenant.id}:${phoneId}`);
  await owner.query("INSERT INTO tenant_integrations (tenant_id, provider, external_id, secret_enc, key_version) VALUES ($1,'whatsapp',$2,$3,$4)", [info.tenant.id, phoneId, enc.payload, enc.keyVersion]);
  return { tenantId: info.tenant.id as string, cookie, phoneId };
}
type T = Awaited<ReturnType<typeof register>>;import { POST as createRule } from "@/app/api/automations/route";
import { tickAutomations } from "@/lib/automations/tick";
import { actionError, isTimeTrigger } from "@/lib/automations/rules";

beforeAll(async () => { await getPool().query("SELECT 1"); });
afterAll(async () => {
  await owner.query("DELETE FROM users WHERE email LIKE $1", [`su-${RUN}-%`]);
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



afterEach(() => { vi.unstubAllEnvs(); });
const post = (h: (r: Request) => Promise<Response>, path: string, t: T | null, body: unknown, origin = ORIGIN) => h(api("POST", path, t?.cookie, body, origin));




const rcreate = (t: T, body: Record<string, unknown> = {}) => post(createRule, "/api/automations", t, { name: "Sin respuesta", triggerEvent: "conversation.unanswered", offsetMinutes: 30, actionType: "tarea", taskTitle: "Responder a {cliente}", ...body });
async function mkRule(t: T, o: Record<string, unknown> = {}) {
  const r = await rcreate(t, o);
  expect(r.status).toBe(201);
  const id = (await r.json()).id as string;
  await withTenant(t.tenantId, (db) => db.query("UPDATE automation_rules SET created_at = now() - interval '10 days' WHERE id = $1", [id]));
  return id;
}
const tasks = (t: T) => withTenant(t.tenantId, async (db) => (await db.query("SELECT * FROM work_items WHERE dedupe_key LIKE 'auto:%' ORDER BY created_at, id")).rows);
const tick = (t: T) => withTenant(t.tenantId, async (db) => Number((await db.query("SELECT run_time_automations($1) AS n", [t.tenantId])).rows[0].n));
/** Conversación con el último mensaje del cliente hace `ago` minutos (y opcionalmente una respuesta después). */
async function conv(t: T, o: { status?: string; ago?: number; name?: string; reply?: "out" | null } = {}) {
  const waId = `58414${String(Math.random()).slice(2, 9)}`;
  return withTenant(t.tenantId, async (db) => {
    const c = (await db.query("INSERT INTO contacts (tenant_id, wa_id, display_name) VALUES ($1,$2,$3) RETURNING id", [t.tenantId, waId, o.name ?? "Ana"])).rows[0].id as string;
    const cv = (await db.query("INSERT INTO conversations (tenant_id, contact_id, status) VALUES ($1,$2,$3) RETURNING id", [t.tenantId, c, o.status ?? "human"])).rows[0].id as string;
    const ago = o.ago ?? 45;
    await db.query("INSERT INTO messages (tenant_id, conversation_id, direction, msg_type, body, wa_message_id, created_at) VALUES ($1,$2,'in','text','necesito ayuda',$3, now() - make_interval(mins => $4))", [t.tenantId, cv, `wamid.IN.${randomUUID()}`, ago]);
    if (o.reply) await db.query("INSERT INTO messages (tenant_id, conversation_id, direction, msg_type, body, send_state, created_at) VALUES ($1,$2,'out','text','hola',$3, now() - make_interval(mins => $4))", [t.tenantId, cv, "sent", Math.max(ago - 5, 1)]);
    return { id: cv, contactId: c };
  });
}
const addIn = (t: T, convId: string, agoMin: number) => withTenant(t.tenantId, (db) => db.query("INSERT INTO messages (tenant_id, conversation_id, direction, msg_type, body, wa_message_id, created_at) VALUES ($1,$2,'in','text','sigo aquí',$3, now() - make_interval(mins => $4))", [t.tenantId, convId, `wamid.IN.${randomUUID()}`, agoMin]));

describe("cliente esperando a una persona", () => {
  it("crea UNA tarea cuando pasó el tiempo sin respuesta, con el nombre del cliente", async () => {
    const t = await register("a1");
    await mkRule(t);
    await conv(t, { ago: 45, name: "Luis" });
    expect(await tick(t)).toBe(1);
    expect(await tick(t)).toBe(1); // repetir el reloj no duplica
    const ws = await tasks(t);
    expect(ws).toHaveLength(1);
    expect(ws[0].title).toBe("Responder a Luis");
  });
  it("no avisa si aún no pasó el tiempo, si alguien ya respondió, si la conversación la lleva el asistente o está cerrada", async () => {
    const t = await register("a2");
    await mkRule(t);
    await conv(t, { ago: 10 });
    await conv(t, { ago: 45, reply: "out" });
    await conv(t, { ago: 45, status: "bot" });
    await conv(t, { ago: 45, status: "closed" });
    expect(await tick(t)).toBe(0);
    expect(await tasks(t)).toHaveLength(0);
  });
  it("no es retroactivo: mensajes anteriores a la regla o de hace más de 7 días no se reclaman", async () => {
    const t = await register("a3");
    await conv(t, { ago: 100 });
    await mkRule(t); // la regla se «crea» hace 10 días; este mensaje es más reciente → sí cuenta
    const t2 = await register("a3b");
    await conv(t2, { ago: 60 });
    const id = (await (await rcreate(t2)).json()).id as string; // regla recién creada: el mensaje es anterior
    expect(id).toBeTruthy();
    expect(await tick(t2)).toBe(0);
    const t3 = await register("a3c");
    await mkRule(t3);
    await conv(t3, { ago: 60 * 24 * 8 });
    expect(await tick(t3)).toBe(0);
  });
  it("si el cliente vuelve a escribir y otra vez nadie contesta, avisa de nuevo (otro mensaje, otro aviso)", async () => {
    const t = await register("a4");
    await mkRule(t);
    const c = await conv(t, { ago: 120 });
    expect(await tick(t)).toBe(1);
    await addIn(t, c.id, 40);
    expect(await tick(t)).toBe(1);
    expect(await tasks(t)).toHaveLength(2);
  });
  it("tareas ligadas al cliente; el aviso a una persona que responde deja de dispararse", async () => {
    const t = await register("a5");
    await mkRule(t);
    const c = await conv(t, { ago: 60 });
    await withTenant(t.tenantId, (db) => db.query("INSERT INTO messages (tenant_id, conversation_id, direction, msg_type, body, send_state) VALUES ($1,$2,'out','text','ya te atiendo','sent')", [t.tenantId, c.id]));
    expect(await tick(t)).toBe(0);
  });
  it("la regla no admite «avisar al cliente» y exige indicar los minutos", async () => {
    const t = await register("a6");
    expect((await rcreate(t, { actionType: "mensaje", messageTemplate: "Hola" })).status).toBe(422);
    expect((await rcreate(t, { offsetMinutes: null })).status).toBe(422);
    expect(isTimeTrigger("conversation.unanswered")).toBe(true);
    expect(actionError({ triggerEvent: "conversation.unanswered", actionType: "mensaje", messageTemplate: "x", offsetMinutes: 5 })).toMatch(/cliente/);
  });
  it("el reloj del worker procesa al negocio (índice de negocios con reglas de tiempo)", async () => {
    const t = await register("a7");
    await mkRule(t);
    await conv(t, { ago: 50 });
    await owner.query("UPDATE automation_time_index SET last_tick_at = NULL WHERE tenant_id = $1", [t.tenantId]);
    const r = await tickAutomations(50, 5);
    expect(r.events).toBeGreaterThanOrEqual(1);
    expect(await tasks(t)).toHaveLength(1);
  });
  it("aislamiento: la regla de un negocio no mira las conversaciones de otro", async () => {
    const a = await register("a8a");
    const b = await register("a8b");
    await mkRule(a);
    await conv(b, { ago: 90 });
    expect(await tick(a)).toBe(0);
    expect(await tasks(b)).toHaveLength(0);
  });
});
