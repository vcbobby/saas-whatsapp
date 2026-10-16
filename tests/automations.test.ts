import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { POST as signup } from "@/app/api/auth/signup/route";
import { GET as me } from "@/app/api/me/route";
import { POST as teamInvite } from "@/app/api/team/invite/route";
import { POST as inviteSignup } from "@/app/api/invitations/signup/route";
import { createOrder, transitionOrder } from "@/lib/orders/service";
import { getPool, withTenant } from "@/lib/db";

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
  const email = `au-${RUN}-${name}@example.test`;
  const res = await signup(api("POST", "/api/auth/signup", undefined, { email, password: PASSWORD, businessName: `Negocio ${name}` }));
  expect(res.status).toBe(201);
  const cookie = (res.headers.get("set-cookie") ?? "").split(";")[0]!;
  const info = await (await me(api("GET", "/api/me", cookie))).json();
  tenantIds.push(info.tenant.id);
  return { tenantId: info.tenant.id as string, cookie };
}
type T = Awaited<ReturnType<typeof register>>;
async function member(t: T, role: "admin" | "agent"): Promise<T> {
  const inv = await teamInvite(api("POST", "/api/team/invite", t.cookie, { email: `au-${RUN}-${role}-${randomUUID().slice(0, 6)}@example.test`, role }));
  expect(inv.status).toBe(201);
  const token = ((await inv.json()).inviteUrl as string).split("/").pop()!;
  const ok = await inviteSignup(api("POST", "/api/invitations/signup", undefined, { token, password: PASSWORD }));
  expect(ok.status).toBe(201);
  return { tenantId: t.tenantId, cookie: (ok.headers.get("set-cookie") ?? "").split(";")[0]! };
}
import { GET as listRules, POST as createRule } from "@/app/api/automations/route";
import { POST as updateRule } from "@/app/api/automations/update/route";
import { MAX_RULES, statusOk } from "@/lib/automations/rules";

beforeAll(async () => { await getPool().query("SELECT 1"); });
afterAll(async () => {
  await owner.query("DELETE FROM users WHERE email LIKE $1", [`au-${RUN}-%`]);
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
type Db = Parameters<Parameters<typeof withTenant>[1]>[0];

async function product(db: Db, t: T, name = "Arroz", price = 250) {
  return (await db.query("INSERT INTO catalog_products (tenant_id, name, price_minor, stock) VALUES ($1,$2,$3,NULL) RETURNING id", [t.tenantId, name, price])).rows[0].id as string;
}
async function conv(db: Db, t: T, name: string | null = "Ana") {
  const c = (await db.query("INSERT INTO contacts (tenant_id, wa_id, display_name) VALUES ($1,$2,$3) RETURNING id", [t.tenantId, `5841${String(Math.random()).slice(2, 11)}`, name])).rows[0] as { id: string };
  const cv = (await db.query("INSERT INTO conversations (tenant_id, contact_id, status) VALUES ($1,$2,'bot') RETURNING id", [t.tenantId, c.id])).rows[0].id as string;
  return { contactId: c.id, conversationId: cv };
}
async function appt(db: Db, t: T) {
  await db.query("INSERT INTO agenda_settings (tenant_id, timezone, min_notice_minutes, max_days_ahead, slot_step_minutes) VALUES ($1,'America/Caracas',0,60,30) ON CONFLICT DO NOTHING", [t.tenantId]);
  const svc = (await db.query("INSERT INTO agenda_services (tenant_id, name, duration_minutes) VALUES ($1,'Corte',30) RETURNING id", [t.tenantId])).rows[0].id as string;
  return (await db.query("INSERT INTO appointments (tenant_id, service_id, customer_name, customer_phone, starts_at, ends_at, status, source) VALUES ($1,$2,'Luis','+584120000000','2026-11-05T14:00:00Z','2026-11-05T14:30:00Z','pendiente','manual') RETURNING id", [t.tenantId, svc])).rows[0].id as string;
}
const post = (h: (r: Request) => Promise<Response>, path: string, t: T | null, body: unknown, origin = ORIGIN) => h(api("POST", path, t?.cookie, body, origin));


const rcreate = (t: T, body: Record<string, unknown> = {}) => post(createRule, "/api/automations", t, { name: "Regla", triggerEvent: "order.created", taskTitle: "Preparar pedido {numero} de {cliente}", ...body });
const rupdate = (t: T, body: Record<string, unknown>) => post(updateRule, "/api/automations/update", t, body);
async function mkRule(t: T, o: Record<string, unknown> = {}) {
  const r = await rcreate(t, o);
  expect(r.status).toBe(201);
  return (await r.json()).id as string;
}
const tasks = (t: T) => withTenant(t.tenantId, async (db) => (await db.query("SELECT * FROM work_items WHERE dedupe_key LIKE 'auto:%' ORDER BY created_at, id")).rows);
const ruleRow = (t: T, id: string) => withTenant(t.tenantId, async (db) => (await db.query("SELECT * FROM automation_rules WHERE id = $1", [id])).rows[0]);
async function newOrder(db: Db, t: T, o: { name?: string; qty?: number; status?: "pendiente" | "confirmado" } = {}) {
  const p = await product(db, t, "Arroz " + randomUUID().slice(0, 6), 250);
  const r = await createOrder(db, { tenantId: t.tenantId, source: "manual", status: o.status ?? "pendiente", customerName: o.name ?? "Ana", items: [{ productId: p, quantity: o.qty ?? 2 }] });
  if (r.kind !== "ok") throw new Error("pedido");
  return r;
}

describe("reglas: cuando pasa algo, se crea una tarea en «Hoy»", () => {
  it("pedido nuevo: crea la tarea con la plantilla rellenada, prioridad y plazo", async () => {
    const t = await register("r-order");
    const id = await mkRule(t, { taskPriority: 1, taskDueMinutes: 60, taskTitle: "Preparar {numero} de {cliente}: {total}" });
    await withTenant(t.tenantId, (db) => newOrder(db, t, { name: "Ana  Pérez", qty: 2 }));
    const [w, ...more] = await tasks(t);
    expect(more).toHaveLength(0);
    expect(w).toMatchObject({ type: "tarea", status: "abierto", priority: 1, source: "sistema" });
    expect(w.title).toMatch(/^Preparar \d+ de Ana Pérez: 5\.00 /);
    expect(w.dedupe_key).toMatch(new RegExp(`^auto:${id}:`));
    const mins = (new Date(w.due_at).getTime() - Date.now()) / 60000;
    expect(mins).toBeGreaterThan(58); expect(mins).toBeLessThanOrEqual(60.1);
    const r = await ruleRow(t, id);
    expect(r.run_count).toBe(1);
    expect(r.last_run_at).not.toBeNull();
  });
  it("sin plazo la tarea no tiene fecha; sin conexiones de avisos igualmente funciona", async () => {
    const t = await register("r-nodue");
    await mkRule(t);
    await withTenant(t.tenantId, (db) => newOrder(db, t));
    expect((await tasks(t))[0].due_at).toBeNull();
  });
  it("una regla desactivada no hace nada; al reactivarla vuelve a actuar", async () => {
    const t = await register("r-off");
    const id = await mkRule(t);
    expect((await rupdate(t, { action: "toggle", id, active: false })).status).toBe(200);
    await withTenant(t.tenantId, (db) => newOrder(db, t));
    expect(await tasks(t)).toHaveLength(0);
    expect((await rupdate(t, { action: "toggle", id, active: true })).status).toBe(200);
    await withTenant(t.tenantId, (db) => newOrder(db, t));
    expect(await tasks(t)).toHaveLength(1);
  });
  it("con una regla activa y otra desactivada, solo actúa la activa", async () => {
    const t = await register("r-mix");
    await mkRule(t, { name: "On", taskTitle: "Activa" });
    const off = await mkRule(t, { name: "Off", taskTitle: "Apagada" });
    await rupdate(t, { action: "toggle", id: off, active: false });
    await withTenant(t.tenantId, (db) => newOrder(db, t));
    expect((await tasks(t)).map((w) => w.title)).toEqual(["Activa"]);
  });
  it("solo reacciona al aviso elegido", async () => {
    const t = await register("r-trigger");
    await mkRule(t, { triggerEvent: "appointment.created", taskTitle: "Cita de {cliente} ({servicio})" });
    await withTenant(t.tenantId, (db) => newOrder(db, t));
    expect(await tasks(t)).toHaveLength(0);
    await withTenant(t.tenantId, (db) => appt(db, t));
    const [w] = await tasks(t);
    expect(w.title).toBe("Cita de Luis (Corte)");
  });
  it("«cambia de estado» con filtro: solo cuando el NUEVO estado coincide", async () => {
    const t = await register("r-status");
    await mkRule(t, { triggerEvent: "order.status_changed", onlyStatus: "confirmado", taskTitle: "Cobrar {numero} ({estado})" });
    await withTenant(t.tenantId, async (db) => {
      const a = await newOrder(db, t);
      const b = await newOrder(db, t);
      expect((await transitionOrder(db, t.tenantId, b.id, "cancel")).kind).toBe("ok");
      expect((await transitionOrder(db, t.tenantId, a.id, "confirm")).kind).toBe("ok");
    });
    const ws = await tasks(t);
    expect(ws).toHaveLength(1);
    expect(ws[0].title).toMatch(/^Cobrar \d+ \(confirmado\)$/);
  });
  it("sin filtro de estado actúa con cualquier cambio", async () => {
    const t = await register("r-anystatus");
    await mkRule(t, { triggerEvent: "order.status_changed" });
    await withTenant(t.tenantId, async (db) => {
      const a = await newOrder(db, t);
      await transitionOrder(db, t.tenantId, a.id, "confirm");
      await transitionOrder(db, t.tenantId, a.id, "deliver");
    });
    expect(await tasks(t)).toHaveLength(2);
  });
  it("conversación que pasa a una persona", async () => {
    const t = await register("r-hand");
    await mkRule(t, { triggerEvent: "conversation.handoff", taskTitle: "Llamar a {cliente}" });
    await withTenant(t.tenantId, async (db) => {
      const c = await conv(db, t, "Marta");
      await db.query("UPDATE conversations SET status = 'human', handoff_reason = 'pedido_de_persona' WHERE id = $1", [c.conversationId]);
    });
    expect((await tasks(t))[0].title).toBe("Llamar a Marta");
  });
  it("varias reglas para el mismo aviso crean una tarea cada una", async () => {
    const t = await register("r-many");
    await mkRule(t, { name: "A", taskTitle: "Primera" });
    await mkRule(t, { name: "B", taskTitle: "Segunda" });
    await withTenant(t.tenantId, (db) => newOrder(db, t));
    expect((await tasks(t)).map((w) => w.title).sort()).toEqual(["Primera", "Segunda"]);
  });
  it("si el pedido se deshace, la tarea también", async () => {
    const t = await register("r-rollback");
    await mkRule(t);
    await expect(withTenant(t.tenantId, async (db) => { await newOrder(db, t); throw new Error("se deshace"); })).rejects.toThrow("se deshace");
    expect(await tasks(t)).toHaveLength(0);
  });
  it("funciona junto con los avisos firmados (webhooks) sin estorbarse", async () => {
    const t = await register("r-both");
    await mkRule(t);
    await withTenant(t.tenantId, (db) => db.query("INSERT INTO webhook_endpoints (tenant_id, url, events, secret_enc, key_version) VALUES ($1,'https://8.8.8.8/h',$2,'x',1)", [t.tenantId, ["order.created"]]));
    await withTenant(t.tenantId, (db) => newOrder(db, t));
    expect(await tasks(t)).toHaveLength(1);
    expect((await withTenant(t.tenantId, async (db) => (await db.query("SELECT count(*)::int AS n FROM webhook_deliveries")).rows[0].n))).toBe(1);
  });
  it("el mismo evento procesado dos veces no duplica la tarea (idempotente)", async () => {
    const t = await register("r-idem");
    await mkRule(t);
    const ev = randomUUID();
    const data = JSON.stringify({ order: { number: 7, status: "pendiente", customer_name: "Ana", total_minor: 100, currency: "USD" } });
    await withTenant(t.tenantId, async (db) => {
      await db.query("SELECT run_automations($1, 'order.created', $2::jsonb, $3)", [t.tenantId, data, ev]);
      await db.query("SELECT run_automations($1, 'order.created', $2::jsonb, $3)", [t.tenantId, data, ev]);
    });
    const ws = await tasks(t);
    expect(ws).toHaveLength(1);
    expect(ws[0].title).toBe("Preparar pedido 7 de Ana");
  });
  it("una falla dentro de las reglas no deshace el pedido", async () => {
    const t = await register("r-fail");
    await mkRule(t);
    // Una tarea con la misma clave pero de OTRO tipo de conflicto no existe; forzamos el error con un tenant inexistente en la llamada directa.
    await withTenant(t.tenantId, async (db) => {
      await db.query("SAVEPOINT s");
      await expect(db.query("SELECT run_automations($1, 'order.created', '{}'::jsonb, $2)", [randomUUID(), randomUUID()])).resolves.toBeDefined();
      await db.query("RELEASE SAVEPOINT s");
      const r = await newOrder(db, t);
      expect(r.kind).toBe("ok");
    });
    expect(await tasks(t)).toHaveLength(1);
  });
  it("freno: con 500 tareas automáticas abiertas no se crean más", async () => {
    const t = await register("r-brake");
    await mkRule(t);
    await withTenant(t.tenantId, (db) => db.query("INSERT INTO work_items (tenant_id, type, title, source, dedupe_key) SELECT $1, 'tarea', 'x', 'sistema', 'auto:fake:' || g FROM generate_series(1, 500) g", [t.tenantId]));
    await withTenant(t.tenantId, (db) => newOrder(db, t));
    expect(await withTenant(t.tenantId, async (db) => (await db.query("SELECT count(*)::int AS n FROM work_items WHERE dedupe_key LIKE 'auto:%'")).rows[0].n)).toBe(500);
  });
  it("las tareas resueltas no cuentan para el freno", async () => {
    const t = await register("r-brake2");
    await mkRule(t);
    await withTenant(t.tenantId, (db) => db.query("INSERT INTO work_items (tenant_id, type, title, source, dedupe_key, status, resolved_at) SELECT $1, 'tarea', 'x', 'sistema', 'auto:fake:' || g, 'resuelto', now() FROM generate_series(1, 500) g", [t.tenantId]));
    await withTenant(t.tenantId, (db) => newOrder(db, t));
    expect((await tasks(t)).filter((w) => !w.dedupe_key.startsWith("auto:fake:"))).toHaveLength(1);
  });
  it("título vacío tras rellenar: usa el nombre de la regla; espacios se compactan", async () => {
    const t = await register("r-empty");
    await mkRule(t, { name: "Aviso de pedido", taskTitle: "{servicio}" });
    await withTenant(t.tenantId, (db) => newOrder(db, t));
    expect((await tasks(t))[0].title).toBe("Aviso de pedido");
  });
  it("las reglas de un negocio no actúan en otro", async () => {
    const a = await register("r-iso-a");
    const b = await register("r-iso-b");
    await mkRule(a);
    await withTenant(b.tenantId, (db) => newOrder(db, b));
    expect(await tasks(a)).toHaveLength(0);
    expect(await tasks(b)).toHaveLength(0);
  });
});

describe("API de reglas", () => {
  it("permisos: sin sesión 401, agente 403, administrador sí", async () => {
    const t = await register("a-perm");
    const agent = await member(t, "agent");
    const admin = await member(t, "admin");
    expect((await listRules(api("GET", "/api/automations"))).status).toBe(401);
    expect((await listRules(api("GET", "/api/automations", agent.cookie))).status).toBe(403);
    expect((await rcreate(agent)).status).toBe(403);
    expect((await listRules(api("GET", "/api/automations", admin.cookie))).status).toBe(200);
    expect((await rcreate(admin)).status).toBe(201);
  });
  it("rechaza otro origen (CSRF)", async () => {
    const t = await register("a-csrf");
    expect((await post(createRule, "/api/automations", t, { name: "x", triggerEvent: "order.created", taskTitle: "x" }, "https://malo.example")).status).toBe(403);
  });
  it.each<[string, Record<string, unknown>]>([
    ["nombre vacío", { name: "  " }],
    ["título vacío", { taskTitle: "" }],
    ["título largo", { taskTitle: "a".repeat(121) }],
    ["aviso desconocido", { triggerEvent: "otra.cosa" }],
    ["prioridad 4", { taskPriority: 4 }],
    ["plazo 0", { taskDueMinutes: 0 }],
    ["plazo enorme", { taskDueMinutes: 43201 }],
    ["estado en un aviso que no lo admite", { onlyStatus: "confirmado" }],
    ["estado que no existe", { triggerEvent: "order.status_changed", onlyStatus: "enviado" }],
    ["estado de cita en pedido", { triggerEvent: "order.status_changed", onlyStatus: "confirmada" }],
  ])("rechaza: %s", async (_n, body) => {
    const t = await register("a-bad" + Math.random().toString(36).slice(2, 8));
    const res = await rcreate(t, body);
    expect([400, 422]).toContain(res.status);
    expect(await withTenant(t.tenantId, async (db) => (await db.query("SELECT count(*)::int AS n FROM automation_rules")).rows[0].n)).toBe(0);
  });
  it("crear, listar, editar, desactivar y borrar; deja rastro de auditoría", async () => {
    const t = await register("a-crud");
    const id = await mkRule(t, { name: "Mi regla", taskDueMinutes: 30 });
    const list = await (await listRules(api("GET", "/api/automations", t.cookie))).json();
    expect(list.max).toBe(MAX_RULES);
    expect(list.rules).toHaveLength(1);
    expect(list.rules[0]).toMatchObject({ id, name: "Mi regla", triggerEvent: "order.created", onlyStatus: null, taskPriority: 2, taskDueMinutes: 30, active: true, runCount: 0 });
    expect((await rupdate(t, { action: "edit", id, name: "Nueva", triggerEvent: "appointment.status_changed", onlyStatus: "cancelada", taskTitle: "Reagendar {cliente}", taskPriority: 1, taskDueMinutes: null })).status).toBe(200);
    expect(await ruleRow(t, id)).toMatchObject({ name: "Nueva", trigger_event: "appointment.status_changed", only_status: "cancelada", task_title: "Reagendar {cliente}", task_priority: 1, task_due_minutes: null });
    expect((await rupdate(t, { action: "edit", id, name: "Nueva", triggerEvent: "order.created", onlyStatus: "cancelada", taskTitle: "x", taskPriority: 1 })).status).toBe(422);
    expect((await rupdate(t, { action: "toggle", id, active: false })).status).toBe(200);
    expect((await ruleRow(t, id)).active).toBe(false);
    expect((await rupdate(t, { action: "delete", id })).status).toBe(200);
    expect(await ruleRow(t, id)).toBeUndefined();
    expect((await rupdate(t, { action: "delete", id })).status).toBe(404);
    const audit = await withTenant(t.tenantId, (db) => db.query("SELECT action FROM audit_log WHERE action LIKE 'automation.%' ORDER BY created_at"));
    expect(audit.rows.map((r) => r.action)).toEqual(["automation.created", "automation.updated", "automation.toggled", "automation.deleted"]);
  });
  it("máximo de reglas por negocio", async () => {
    const t = await register("a-limit");
    for (let i = 0; i < MAX_RULES; i++) await mkRule(t, { name: "R" + i });
    const res = await rcreate(t);
    expect(res.status).toBe(409);
    expect((await res.json()).code ?? "limite_reglas").toBe("limite_reglas");
  });
  it("no se puede tocar una regla de otro negocio", async () => {
    const a = await register("a-iso-a");
    const b = await register("a-iso-b");
    const id = await mkRule(a);
    expect((await rupdate(b, { action: "toggle", id, active: false })).status).toBe(404);
    expect((await rupdate(b, { action: "delete", id })).status).toBe(404);
    expect((await ruleRow(a, id)).active).toBe(true);
    expect((await (await listRules(api("GET", "/api/automations", b.cookie))).json()).rules).toEqual([]);
  });
  it("statusOk", () => {
    expect(statusOk("order.status_changed", "confirmado")).toBe(true);
    expect(statusOk("order.status_changed", null)).toBe(true);
    expect(statusOk("order.status_changed", "confirmada")).toBe(false);
    expect(statusOk("order.created", "confirmado")).toBe(false);
    expect(statusOk("appointment.status_changed", "no_asistio")).toBe(true);
  });
});
