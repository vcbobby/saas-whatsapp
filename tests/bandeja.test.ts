import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { POST as signup } from "@/app/api/auth/signup/route";
import { GET as me } from "@/app/api/me/route";
import { POST as teamInvite } from "@/app/api/team/invite/route";
import { POST as inviteSignup } from "@/app/api/invitations/signup/route";
import { POST as addNote } from "@/app/api/conversations/note/route";
import { GET as convMessages } from "@/app/api/conversations/messages/route";
import { GET as getAssign, POST as setAssign } from "@/app/api/team/assignment/route";
import { notifyHandoffs } from "@/lib/notifications/handoff";
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
  const email = `bj-${RUN}-${name}@example.test`;
  const res = await signup(api("POST", "/api/auth/signup", undefined, { email, password: PASSWORD, businessName: `Negocio ${name}` }));
  expect(res.status).toBe(201);
  const cookie = (res.headers.get("set-cookie") ?? "").split(";")[0]!;
  const info = await (await me(api("GET", "/api/me", cookie))).json();
  tenantIds.push(info.tenant.id);
  return { tenantId: info.tenant.id as string, cookie, email };
}
type T = Awaited<ReturnType<typeof register>>;
async function member(t: T, role: "admin" | "agent"): Promise<T & { email: string }> {
  const email = `bj-${RUN}-${role}-${randomUUID().slice(0, 6)}@example.test`;
  const inv = await teamInvite(api("POST", "/api/team/invite", t.cookie, { email, role }));
  expect(inv.status).toBe(201);
  const token = ((await inv.json()).inviteUrl as string).split("/").pop()!;
  const ok = await inviteSignup(api("POST", "/api/invitations/signup", undefined, { token, password: PASSWORD }));
  expect(ok.status).toBe(201);
  return { tenantId: t.tenantId, cookie: (ok.headers.get("set-cookie") ?? "").split(";")[0]!, email };
}
beforeAll(async () => { await getPool().query("SELECT 1"); });
afterAll(async () => {
  await owner.query("DELETE FROM users WHERE email LIKE $1", [`cv-${RUN}-%`]);
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



const uidOf = async (email: string) => (await owner.query("SELECT id FROM users WHERE email = $1", [email])).rows[0]!.id as string;
const setMode = (t: T, mode: string, notifyEmail = true) => setAssign(api("POST", "/api/team/assignment", t.cookie, { mode, notifyEmail }));
async function conv(t: T, status: "bot" | "human" = "bot", assignedTo: string | null = null) {
  return withTenant(t.tenantId, async (db) => {
    const c = (await db.query("INSERT INTO contacts (tenant_id, wa_id, display_name) VALUES ($1, $2, 'Cliente') RETURNING id", [t.tenantId, String(5841000000000 + Math.floor(Math.random() * 1e9))])).rows[0]!.id;
    // Se crea ya en modo persona (sin pasar por el disparador) cuando se necesita carga previa.
    return (await db.query("INSERT INTO conversations (tenant_id, contact_id, status, assigned_to, last_message_at) VALUES ($1, $2, $3, $4, now()) RETURNING id", [t.tenantId, c, status, assignedTo])).rows[0]!.id as string;
  });
}
const handoff = (t: T, id: string, reason = "pedido_de_persona") =>
  withTenant(t.tenantId, async (db) => { await db.query("UPDATE conversations SET status = 'human', handoff_reason = $3 WHERE tenant_id = $1 AND id = $2", [t.tenantId, id, reason]); return (await db.query("SELECT assigned_to FROM conversations WHERE tenant_id = $1 AND id = $2", [t.tenantId, id])).rows[0]!.assigned_to as string | null; });
const mails = (to: string) => owner.query("SELECT template, subject, body_text FROM email_outbox WHERE to_email = $1 ORDER BY created_at", [to.toLowerCase()]).then((r) => r.rows);

describe("notas privadas", () => {
  it("se guardan, aparecen en orden dentro de la conversación y nunca se editan ni se borran desde la app", async () => {
    const t = await register("notas");
    const id = await conv(t, "human");
    expect((await addNote(api("POST", "/api/conversations/note", t.cookie, { id, body: "  Pidió descuento  " }))).status).toBe(201);
    expect((await addNote(api("POST", "/api/conversations/note", t.cookie, { id, body: "Consultar al dueño" }))).status).toBe(201);
    const d = await (await convMessages(api("GET", `/api/conversations/messages?id=${id}`, t.cookie))).json();
    expect(d.notes.map((n: { body: string }) => n.body)).toEqual(["Pidió descuento", "Consultar al dueño"]);
    expect(d.notes[0].author).toMatch(/^bj-/);
    const bad = (sql: string) => withTenant(t.tenantId, (db) => db.query(sql)).then(() => null, (e: { code?: string }) => e.code);
    expect(await bad("UPDATE conversation_notes SET body = 'x'")).toBe("42501");
    expect(await bad("DELETE FROM conversation_notes")).toBe("42501");
  });

  it("valida, exige permiso y no cruza negocios", async () => {
    const A = await register("notasA");
    const B = await register("notasB");
    const id = await conv(A);
    const post = (t: T, body: unknown, origin = ORIGIN) => addNote(api("POST", "/api/conversations/note", t.cookie, body, origin));
    expect((await post(A, { id, body: "   " })).status).toBe(400);
    expect((await post(A, { id, body: "x".repeat(2001) })).status).toBe(400);
    expect((await post(A, { id: "no", body: "hola" })).status).toBe(400);
    expect((await post(A, { id: randomUUID(), body: "hola" })).status).toBe(404);
    expect((await post(B, { id, body: "intruso" })).status).toBe(404);
    expect((await post(A, { id, body: "hola" }, "https://otro.example")).status).toBe(403);
    expect((await addNote(api("POST", "/api/conversations/note", undefined, { id, body: "hola" }))).status).toBe(401);
    const agent = await member(A, "agent");
    expect((await post(agent, { id, body: "del agente" })).status).toBe(201);
    expect((await (await convMessages(api("GET", `/api/conversations/messages?id=${id}`, B.cookie))).json()).error).toBe("no_encontrado");
  });
});

describe("reparto automático", () => {
  it("a mano: nadie se asigna solo", async () => {
    const t = await register("manual");
    await member(t, "agent");
    expect(await handoff(t, await conv(t))).toBeNull();
  });

  it("por turnos: rota entre los agentes y deja fuera al dueño", async () => {
    const t = await register("turnos");
    const a1 = await member(t, "agent"); const a2 = await member(t, "agent");
    const u1 = await uidOf(a1.email); const u2 = await uidOf(a2.email);
    expect((await setMode(t, "turnos")).status).toBe(200);
    const got: (string | null)[] = [];
    for (let i = 0; i < 4; i++) got.push(await handoff(t, await conv(t)));
    expect(new Set(got.slice(0, 2))).toEqual(new Set([u1, u2]));
    expect(got[2]).toBe(got[0]); expect(got[3]).toBe(got[1]);
  });

  it("a quien tenga menos: manda al que atiende menos conversaciones", async () => {
    const t = await register("carga");
    const a1 = await member(t, "agent"); const a2 = await member(t, "agent");
    const u1 = await uidOf(a1.email); const u2 = await uidOf(a2.email);
    await setMode(t, "menos_carga");
    await conv(t, "human", u1); await conv(t, "human", u1); await conv(t, "human", u2);
    expect(await handoff(t, await conv(t))).toBe(u2);
    expect(await handoff(t, await conv(t))).toBe(u1); // empatan 2-2 y a u2 le tocó hace menos tiempo
  });

  it("sin agentes se reparte entre el equipo; la que alguien toma a propósito no se reasigna", async () => {
    const t = await register("sinagentes");
    const owner0 = await uidOf(`bj-${RUN}-sinagentes@example.test`);
    await setMode(t, "turnos");
    expect(await handoff(t, await conv(t))).toBe(owner0);
    const a = await member(t, "agent"); const ua = await uidOf(a.email);
    const mine = await conv(t);
    await withTenant(t.tenantId, (db) => db.query("UPDATE conversations SET status = 'human', handoff_reason = 'tomada_por_persona', assigned_to = $3 WHERE tenant_id = $1 AND id = $2", [t.tenantId, mine, owner0]));
    expect((await withTenant(t.tenantId, async (db) => (await db.query("SELECT assigned_to FROM conversations WHERE id = $1", [mine])).rows[0]!.assigned_to))).toBe(owner0);
    expect(ua).not.toBe(owner0);
    expect(await handoff(t, await conv(t))).toBe(ua);
  });

  it("la persona asignada puede responder desde la bandeja (assignedToMe) y los demás ven quién la atiende", async () => {
    const t = await register("asignada");
    const a = await member(t, "agent");
    await setMode(t, "turnos");
    const id = await conv(t);
    await handoff(t, id);
    const mine = await (await convMessages(api("GET", `/api/conversations/messages?id=${id}`, a.cookie))).json();
    expect(mine.conversation.assignedToMe).toBe(true);
    const other = await (await convMessages(api("GET", `/api/conversations/messages?id=${id}`, t.cookie))).json();
    expect(other.conversation.assignedToMe).toBe(false);
    expect(other.conversation.assignedName).toMatch(/^bj-.*-agent-/);
  });

  it("la configuración: por defecto a mano; solo dueño y administrador; valida", async () => {
    const t = await register("config");
    const get = (x: T) => getAssign(api("GET", "/api/team/assignment", x.cookie));
    expect(await (await get(t)).json()).toMatchObject({ mode: "manual", notifyEmail: true, agents: 0, people: 1 });
    expect((await setMode(t, "turnos", false)).status).toBe(200);
    expect(await (await get(t)).json()).toMatchObject({ mode: "turnos", notifyEmail: false });
    expect((await setMode(t, "al_azar")).status).toBe(400);
    const agent = await member(t, "agent");
    expect((await get(agent)).status).toBe(403);
    expect((await setMode(agent, "manual")).status).toBe(403);
    expect((await setAssign(api("POST", "/api/team/assignment", t.cookie, { mode: "manual", notifyEmail: true }, "https://otro.example"))).status).toBe(403);
    const log = await withTenant(t.tenantId, async (db) => (await db.query("SELECT action FROM audit_log WHERE tenant_id = $1 AND action = 'team.assignment'", [t.tenantId])).rows);
    expect(log.length).toBe(1);
  });
});

describe("aviso por correo al equipo", () => {
  it("avisa a quien quedó asignado, una sola vez", async () => {
    const t = await register("avisoA");
    const a = await member(t, "agent");
    await setMode(t, "turnos");
    await handoff(t, await conv(t));
    await notifyHandoffs(100);
    const m = await mails(a.email);
    expect(m.filter((x) => x.template === "chat_por_atender")).toHaveLength(1);
    expect(m.find((x) => x.template === "chat_por_atender")!.subject).toMatch(/Te asignaron un chat/);
    expect(m.find((x) => x.template === "chat_por_atender")!.body_text).toContain("pidió hablar con una persona");
    await notifyHandoffs(100);
    expect((await mails(a.email)).filter((x) => x.template === "chat_por_atender")).toHaveLength(1);
  });

  it("sin asignación avisa al dueño y a los administradores, no al agente", async () => {
    const t = await register("avisoB");
    const a = await member(t, "agent"); const ad = await member(t, "admin");
    await handoff(t, await conv(t), "limite_diario");
    await notifyHandoffs(100);
    const has = async (e: string) => (await mails(e)).some((x) => x.template === "chat_por_atender");
    expect(await has(`bj-${RUN}-avisoB@example.test`)).toBe(true);
    expect(await has(ad.email)).toBe(true);
    expect(await has(a.email)).toBe(false);
    expect((await mails(`bj-${RUN}-avisoB@example.test`)).find((x) => x.template === "chat_por_atender")!.subject).toMatch(/espera a una persona/);
  });

  it("no manda nada si el negocio apagó los avisos o si ya la atendieron", async () => {
    const t = await register("avisoC");
    const a = await member(t, "agent");
    await setMode(t, "turnos", false);
    await handoff(t, await conv(t));
    await notifyHandoffs(100);
    expect((await mails(a.email)).some((x) => x.template === "chat_por_atender")).toBe(false);
    await setMode(t, "turnos", true);
    const id = await conv(t);
    await handoff(t, id);
    await withTenant(t.tenantId, (db) => db.query("UPDATE conversations SET status = 'closed' WHERE tenant_id = $1 AND id = $2", [t.tenantId, id]));
    await notifyHandoffs(100);
    expect((await mails(a.email)).some((x) => x.template === "chat_por_atender")).toBe(false);
  });

  it("una conversación que toma una persona a propósito no genera aviso", async () => {
    const t = await register("avisoD");
    const before = (await owner.query("SELECT count(*)::int AS n FROM handoff_alerts WHERE tenant_id = $1", [t.tenantId])).rows[0].n;
    const id = await conv(t);
    await withTenant(t.tenantId, (db) => db.query("UPDATE conversations SET status = 'human', handoff_reason = 'tomada_por_persona' WHERE tenant_id = $1 AND id = $2", [t.tenantId, id]));
    expect((await owner.query("SELECT count(*)::int AS n FROM handoff_alerts WHERE tenant_id = $1", [t.tenantId])).rows[0].n).toBe(before);
  });
});
