import { createHash, randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { POST as signup } from "@/app/api/auth/signup/route";
import { GET as me } from "@/app/api/me/route";
import { POST as login } from "@/app/api/auth/login/route";
import { POST as verify2fa } from "@/app/api/auth/2fa/verify/route";
import { POST as teamInvite } from "@/app/api/team/invite/route";
import { POST as inviteSignup } from "@/app/api/invitations/signup/route";
import { POST as impersonate } from "@/app/api/admin/impersonation/route";
import { GET as listMine, POST as createTicket } from "@/app/api/support/route";
import { GET as threadMine } from "@/app/api/support/thread/route";
import { POST as replyMine } from "@/app/api/support/reply/route";
import { POST as closeMine } from "@/app/api/support/close/route";
import { GET as adminList } from "@/app/api/admin/support/route";
import { GET as adminThread } from "@/app/api/admin/support/thread/route";
import { POST as adminReply } from "@/app/api/admin/support/reply/route";
import { POST as adminStatus } from "@/app/api/admin/support/status/route";
import { getAdminOverview } from "@/lib/admin/overview";
import { can } from "@/lib/auth/permissions";
import { hashPassword } from "@/lib/auth/password";
import { getPool, withTenant } from "@/lib/db";
import { POLICIES } from "@/lib/security/rate-limit";
import { cleanSupportText, createTicketSchema, supportDbError } from "@/lib/support/schema";
import { codeFor, enableMfaDirect } from "./mfa-helpers";

const RUN = randomUUID().slice(0, 8);
const ORIGIN = new URL(process.env.APP_URL!).origin;
const PASSWORD = "contraseña-de-prueba-123";
const owner = new Pool({ connectionString: process.env.MIGRATION_DATABASE_URL, max: 2 });
const tenantIds: string[] = [];

const api = (method: string, path: string, cookie?: string, body?: unknown, origin = ORIGIN) =>
  new Request(`${ORIGIN}${path}`, { method, headers: { origin, ...(body !== undefined ? { "content-type": "application/json" } : {}), ...(cookie ? { cookie } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
const cookieOf = (res: Response) => (res.headers.get("set-cookie") ?? "").split(";")[0]!;
const hashOf = (cookie: string) => createHash("sha256").update(cookie.split("=")[1]!).digest();

async function register(name: string) {
  const res = await signup(api("POST", "/api/auth/signup", undefined, { email: `sp-${RUN}-${name}@example.test`, password: PASSWORD, businessName: `Soporte ${name} ${RUN}` }));
  expect(res.status).toBe(201);
  const cookie = cookieOf(res);
  const info = await (await me(api("GET", "/api/me", cookie))).json();
  tenantIds.push(info.tenant.id);
  return { tenantId: info.tenant.id as string, cookie, email: `sp-${RUN}-${name}@example.test` };
}
type T = Awaited<ReturnType<typeof register>>;
async function agentOf(t: T): Promise<T> {
  const inv = await teamInvite(api("POST", "/api/team/invite", t.cookie, { email: `sp-${RUN}-ag-${randomUUID().slice(0, 6)}@example.test`, role: "agent" }));
  expect(inv.status).toBe(201);
  const token = ((await inv.json()).inviteUrl as string).split("/").pop()!;
  const ok = await inviteSignup(api("POST", "/api/invitations/signup", undefined, { token, password: PASSWORD }));
  expect(ok.status).toBe(201);
  return { ...t, cookie: cookieOf(ok) };
}
async function superAdmin(name: string) {
  const addr = `sp-${RUN}-${name}@example.test`;
  const ins = await owner.query<{ id: string }>("INSERT INTO users (email, password_hash, is_super_admin) VALUES ($1,$2,true) RETURNING id", [addr, await hashPassword(PASSWORD)]);
  const secret = await enableMfaDirect(owner, ins.rows[0]!.id);
  const res = await login(api("POST", "/api/auth/login", undefined, { email: addr, password: PASSWORD }));
  const ver = await verify2fa(api("POST", "/api/auth/2fa/verify", cookieOf(res), { code: codeFor(secret) }));
  expect(ver.status).toBe(200);
  return { cookie: cookieOf(ver), email: addr };
}

beforeAll(async () => { await getPool().query("SELECT 1"); });
afterAll(async () => {
  await owner.query("DELETE FROM users WHERE email LIKE $1", [`sp-${RUN}-%`]);
  for (const id of tenantIds) {
    const c = await owner.connect();
    try {
      await c.query("BEGIN");
      await c.query("SELECT set_config('app.tenant_id', $1, true)", [id]);
      await c.query("ALTER TABLE audit_log DISABLE TRIGGER audit_log_sin_cambios");
      await c.query("DELETE FROM audit_log WHERE tenant_id = $1", [id]);
      await c.query("ALTER TABLE audit_log ENABLE TRIGGER audit_log_sin_cambios");
      await c.query("DELETE FROM tenants WHERE id = $1", [id]);
      await c.query("COMMIT");
    } catch (e) { await c.query("ROLLBACK"); throw e; } finally { c.release(); }
  }
  await owner.end();
  await getPool().end();
});

const open = async (t: { cookie: string }, subject = "No responde el asistente", body = "Desde ayer no contesta a mis clientes.") => {
  const res = await createTicket(api("POST", "/api/support", t.cookie, { subject, body }));
  return { res, id: ((await res.clone().json().catch(() => ({}))) as { id?: string }).id! };
};
const thread = async (t: { cookie: string }, id: string) => threadMine(api("GET", `/api/support/thread?id=${id}`, t.cookie));
const say = (t: { cookie: string }, id: string, body: string) => replyMine(api("POST", "/api/support/reply", t.cookie, { id, body }));

describe("consultas del negocio", () => {
  it("el dueño abre una consulta, la ve en su lista y en su conversación", async () => {
    const t = await register("c1");
    const { res, id } = await open(t);
    expect(res.status).toBe(201);
    const list = await (await listMine(api("GET", "/api/support", t.cookie))).json();
    expect(list.tickets).toHaveLength(1);
    expect(list.tickets[0]).toMatchObject({ id, subject: "No responde el asistente", status: "open", lastFrom: "user" });
    const th = await (await thread(t, id)).json();
    expect(th.ticket).toMatchObject({ status: "open", statusLabel: "Esperando respuesta de soporte" });
    expect(th.messages).toHaveLength(1);
    expect(th.messages[0]).toMatchObject({ fromSupport: false, body: "Desde ayer no contesta a mis clientes." });
  });

  it("solo dueño y administrador usan soporte; sin sesión no entra nadie", async () => {
    expect(can("owner", "support:use")).toBe(true);
    expect(can("admin", "support:use")).toBe(true);
    expect(can("agent", "support:use")).toBe(false);
    const t = await register("c2");
    const ag = await agentOf(t);
    expect((await listMine(api("GET", "/api/support", ag.cookie))).status).toBe(403);
    expect((await createTicket(api("POST", "/api/support", ag.cookie, { subject: "Hola", body: "Hola" }))).status).toBe(403);
    expect((await listMine(api("GET", "/api/support"))).status).toBe(401);
    expect((await createTicket(api("POST", "/api/support", undefined, { subject: "Hola", body: "Hola" }))).status).toBe(401);
  });

  it("valida asunto y mensaje, limpia caracteres de control y exige origen propio", async () => {
    const t = await register("c3");
    const bad = (body: unknown) => createTicket(api("POST", "/api/support", t.cookie, body));
    expect((await bad({ subject: "ab", body: "x" })).status).toBe(400);
    expect((await bad({ subject: "Asunto válido", body: "   " })).status).toBe(400);
    expect((await bad({ subject: "x".repeat(121), body: "x" })).status).toBe(400);
    expect((await bad({ subject: "Asunto válido", body: "x".repeat(4001) })).status).toBe(400);
    expect((await bad({ subject: "Asunto válido" })).status).toBe(400);
    expect((await createTicket(api("POST", "/api/support", t.cookie, { subject: "Asunto válido", body: "x" }, "https://malo.example"))).status).toBe(403);
    const { res, id } = await open(t, "  Asunto \u202E con\u0007 ruido  ", "Hola\u0000 \u202Emundo\u0007");
    expect(res.status).toBe(201);
    const th = await (await thread(t, id)).json();
    expect(th.ticket.subject).toBe("Asunto con ruido");
    expect(th.messages[0].body).toBe("Hola mundo");
    // 4000 caracteres justos sí caben.
    expect((await bad({ subject: "Asunto válido", body: "x".repeat(4000) })).status).toBe(201);
  });

  it("un negocio no ve, no responde ni cierra las consultas de otro", async () => {
    const a = await register("iso-a");
    const b = await register("iso-b");
    const { id } = await open(a);
    expect((await thread(b, id)).status).toBe(404);
    expect((await say(b, id, "intruso")).status).toBe(404);
    expect((await closeMine(api("POST", "/api/support/close", b.cookie, { id }))).status).toBe(404);
    expect((await (await listMine(api("GET", "/api/support", b.cookie))).json()).tickets).toEqual([]);
    expect((await thread(a, id)).status).toBe(200);
    expect(((await (await thread(a, id)).json()).messages as unknown[]).length).toBe(1);
    expect((await thread(a, "no-es-un-uuid")).status).toBe(400);
    expect((await thread(a, randomUUID())).status).toBe(404);
  });

  it("la aplicación no puede escribir las tablas directamente (no se falsifican respuestas de soporte)", async () => {
    const t = await register("c4");
    const { id } = await open(t);
    await expect(withTenant(t.tenantId, (db) => db.query("INSERT INTO support_messages (tenant_id, ticket_id, from_support, body) VALUES ($1,$2,true,'falso')", [t.tenantId, id]))).rejects.toMatchObject({ code: "42501" });
    await expect(withTenant(t.tenantId, (db) => db.query("UPDATE support_tickets SET status = 'answered' WHERE id = $1", [id]))).rejects.toMatchObject({ code: "42501" });
    await expect(withTenant(t.tenantId, (db) => db.query("DELETE FROM support_messages WHERE ticket_id = $1", [id]))).rejects.toMatchObject({ code: "42501" });
    await expect(withTenant(t.tenantId, (db) => db.query("INSERT INTO support_tickets (tenant_id, subject) VALUES ($1,'directo')", [t.tenantId]))).rejects.toMatchObject({ code: "42501" });
    // Y las funciones de uso interno del súper admin no las puede llamar un usuario normal.
    const h = hashOf(t.cookie);
    for (const sql of ["SELECT * FROM admin_support_list($1, NULL)", "SELECT admin_support_get($1, gen_random_uuid())", "SELECT admin_support_reply($1, gen_random_uuid(), 'x')", "SELECT admin_support_set_status($1, gen_random_uuid(), 'closed')"]) {
      await expect(getPool().query(sql, [h])).rejects.toMatchObject({ code: "42501" });
    }
  });

  it("escribir en una consulta cerrada la reabre; cerrar y volver a cerrar es inocuo", async () => {
    const t = await register("c5");
    const { id } = await open(t);
    expect((await closeMine(api("POST", "/api/support/close", t.cookie, { id }))).status).toBe(200);
    expect((await closeMine(api("POST", "/api/support/close", t.cookie, { id }))).status).toBe(200);
    expect((await (await thread(t, id)).json()).ticket.status).toBe("closed");
    expect((await say(t, id, "Sigue pasando")).status).toBe(200);
    const th = await (await thread(t, id)).json();
    expect(th.ticket.status).toBe("open");
    expect(th.messages.map((m: { body: string }) => m.body)).toEqual(["Desde ayer no contesta a mis clientes.", "Sigue pasando"]);
    expect((await say(t, id, "   ")).status).toBe(400);
  });

  it("máximo 5 consultas abiertas por negocio; cerrar una libera el cupo", async () => {
    const t = await register("c6");
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) { const r = await open(t, `Consulta número ${i}`); expect(r.res.status).toBe(201); ids.push(r.id); }
    const sixth = await open(t, "Consulta número 6");
    expect(sixth.res.status).toBe(409);
    expect(await sixth.res.json()).toMatchObject({ error: "demasiados_tickets" });
    expect((await closeMine(api("POST", "/api/support/close", t.cookie, { id: ids[0] }))).status).toBe(200);
    expect((await open(t, "Consulta número 7")).res.status).toBe(201);
    // Otro negocio no se ve afectado.
    expect((await open(await register("c6b"))).res.status).toBe(201);
    // Una consulta «respondida» sigue abierta: también cuenta para el tope.
    const adm = await superAdmin("cap");
    expect((await adminReply(api("POST", "/api/admin/support/reply", adm.cookie, { id: ids[1], body: "Ya lo revisamos" }))).status).toBe(200);
    for (let i = 2; i < 5; i++) await closeMine(api("POST", "/api/support/close", t.cookie, { id: ids[i] })); // quedan: ids[1] (respondida) y la 7
    expect((await open(t, "Consulta ocho")).res.status).toBe(201);
    expect((await open(t, "Consulta nueve")).res.status).toBe(201);
    expect((await open(t, "Consulta diez")).res.status).toBe(201);
    expect((await open(t, "Consulta once")).res.status).toBe(409); // 1 respondida + 1 abierta + 3 nuevas = 5
  });

  it("la base de datos también limpia el texto (aunque alguien se salte la API)", async () => {
    const t = await register("c6c");
    const id = await withTenant(t.tenantId, async (db) => (await db.query("SELECT support_create(NULL, $1, $2) AS id", ["  Asunto \u202E raro\u0007  ", "hola\u0007 \u202Emundo\u2066!\u0010\u001F"])).rows[0].id as string);
    const th = await (await thread(t, id)).json();
    expect(th.ticket.subject).toBe("Asunto  raro");
    expect(th.messages[0].body).toBe("hola mundo!");
    // Y los topes de largo también valen ahí.
    await expect(withTenant(t.tenantId, (db) => db.query("SELECT support_create(NULL, 'ab', 'x')"))).rejects.toMatchObject({ code: "22023" });
    await expect(withTenant(t.tenantId, (db) => db.query("SELECT support_reply($1, NULL, $2)", [id, "x".repeat(4001)]))).rejects.toMatchObject({ code: "22023" });
  });

  it("una conversación tiene tope de 200 mensajes", async () => {
    const t = await register("c7");
    const { id } = await open(t);
    await withTenant(t.tenantId, async (db) => { for (let i = 0; i < 198; i++) await db.query("SELECT support_reply($1, NULL, 'relleno')", [id]); });
    expect((await say(t, id, "mensaje 200")).status).toBe(200); // 1 + 198 + 1 = 200
    const over = await say(t, id, "mensaje 201");
    expect(over.status).toBe(409);
    expect(await over.json()).toMatchObject({ error: "conversacion_larga" });
  });

  it("el soporte viendo un negocio puede leer pero no escribir en su nombre", async () => {
    const t = await register("c8");
    const { id } = await open(t);
    const adm = await superAdmin("imp1");
    expect((await impersonate(api("POST", "/api/admin/impersonation", adm.cookie, { tenantId: t.tenantId, reason: "Ticket 7: revisar consulta del cliente" }))).status).toBe(200);
    expect((await thread(adm, id)).status).toBe(200);
    expect((await createTicket(api("POST", "/api/support", adm.cookie, { subject: "En nombre del cliente", body: "x" }))).status).toBe(403);
    expect((await say(adm, id, "x")).status).toBe(403);
    expect((await closeMine(api("POST", "/api/support/close", adm.cookie, { id }))).status).toBe(403);
  });

  it("los envíos tienen su propio límite de frecuencia", () => {
    expect(POLICIES.support).toEqual({ limit: 20, windowSec: 600 });
  });
});

describe("bandeja del súper admin", () => {
  it("solo un súper admin la ve; para los demás la ruta no existe", async () => {
    const t = await register("a1");
    const { id } = await open(t);
    expect((await adminList(api("GET", "/api/admin/support", t.cookie))).status).toBe(404);
    expect((await adminThread(api("GET", `/api/admin/support/thread?id=${id}`, t.cookie))).status).toBe(404);
    expect((await adminReply(api("POST", "/api/admin/support/reply", t.cookie, { id, body: "x" }))).status).toBe(404);
    expect((await adminStatus(api("POST", "/api/admin/support/status", t.cookie, { id, status: "closed" }))).status).toBe(404);
    expect((await adminList(api("GET", "/api/admin/support"))).status).toBe(404);
  });

  it("lista con negocio y correo, filtra por estado y valida los datos", async () => {
    const t = await register("a2");
    const { id } = await open(t, "Pregunta sobre el plan");
    const adm = await superAdmin("adm1");
    const all = await (await adminList(api("GET", "/api/admin/support", adm.cookie))).json();
    const mine = all.tickets.find((x: { id: string }) => x.id === id);
    expect(mine).toMatchObject({ tenantId: t.tenantId, email: t.email, subject: "Pregunta sobre el plan", status: "open", lastFrom: "user", messages: 1 });
    expect(mine.tenantName).toContain(`a2 ${RUN}`);
    const open_ = await (await adminList(api("GET", "/api/admin/support?status=open", adm.cookie))).json();
    expect(open_.tickets.some((x: { id: string }) => x.id === id)).toBe(true);
    const closed = await (await adminList(api("GET", "/api/admin/support?status=closed", adm.cookie))).json();
    expect(closed.tickets.some((x: { id: string }) => x.id === id)).toBe(false);
    expect((await adminList(api("GET", "/api/admin/support?status=raro", adm.cookie))).status).toBe(400);
    expect((await adminThread(api("GET", "/api/admin/support/thread?id=nada", adm.cookie))).status).toBe(400);
    expect((await adminThread(api("GET", `/api/admin/support/thread?id=${randomUUID()}`, adm.cookie))).status).toBe(404);
    expect((await adminReply(api("POST", "/api/admin/support/reply", adm.cookie, { id, body: "" }))).status).toBe(400);
    expect((await adminStatus(api("POST", "/api/admin/support/status", adm.cookie, { id, status: "answered" }))).status).toBe(400);
    expect((await adminReply(api("POST", "/api/admin/support/reply", adm.cookie, { id: randomUUID(), body: "hola" }))).status).toBe(404);
    expect((await adminReply(api("POST", "/api/admin/support/reply", adm.cookie, { id, body: "hola" }, "https://malo.example"))).status).toBe(403);
  });

  it("responder marca «respondido», el negocio lo ve como «Soporte» sin datos del admin, y queda en el registro de auditoría", async () => {
    const t = await register("a3");
    const { id } = await open(t);
    const adm = await superAdmin("adm2");
    const rep = await adminReply(api("POST", "/api/admin/support/reply", adm.cookie, { id, body: "Revisamos tu cuenta: ya quedó resuelto." }));
    expect(rep.status).toBe(200);
    const th = await (await thread(t, id)).json();
    expect(th.ticket).toMatchObject({ status: "answered", statusLabel: "Soporte respondió" });
    expect(th.messages.map((m: { fromSupport: boolean }) => m.fromSupport)).toEqual([false, true]);
    expect(JSON.stringify(th)).not.toContain(adm.email);
    expect(Object.keys(th.messages[1]).sort()).toEqual(["body", "createdAt", "fromSupport", "id"]);
    const list = await (await listMine(api("GET", "/api/support", t.cookie))).json();
    expect(list.tickets[0]).toMatchObject({ status: "answered", lastFrom: "support" });
    // El súper admin ve el hilo completo con quién es el cliente.
    const at = await (await adminThread(api("GET", `/api/admin/support/thread?id=${id}`, adm.cookie))).json();
    expect(at.ticket).toMatchObject({ tenantId: t.tenantId, email: t.email, status: "answered" });
    expect(at.ticket.messages).toHaveLength(2);
    // Auditoría (visible para el negocio, sin el contenido).
    const audit = await withTenant(t.tenantId, async (db) => (await db.query("SELECT action, target_id, metadata FROM audit_log WHERE action LIKE 'support.%'")).rows);
    expect(audit).toEqual([{ action: "support.replied", target_id: id, metadata: {} }]);
    // El negocio vuelve a escribir: pasa a «por responder» otra vez.
    expect((await say(t, id, "Gracias, ¿y lo del plan?")).status).toBe(200);
    expect((await (await adminThread(api("GET", `/api/admin/support/thread?id=${id}`, adm.cookie))).json()).ticket.status).toBe("open");
  });

  it("el súper admin cierra y reabre; se audita y el negocio ve el cambio", async () => {
    const t = await register("a4");
    const { id } = await open(t);
    const adm = await superAdmin("adm3");
    expect((await adminStatus(api("POST", "/api/admin/support/status", adm.cookie, { id, status: "closed" }))).status).toBe(200);
    expect((await (await thread(t, id)).json()).ticket.status).toBe("closed");
    const closed = await (await adminList(api("GET", "/api/admin/support?status=closed", adm.cookie))).json();
    expect(closed.tickets.some((x: { id: string }) => x.id === id)).toBe(true);
    expect((await adminStatus(api("POST", "/api/admin/support/status", adm.cookie, { id, status: "open" }))).status).toBe(200);
    expect((await (await thread(t, id)).json()).ticket.status).toBe("open");
    const audit = await withTenant(t.tenantId, async (db) => (await db.query("SELECT action FROM audit_log WHERE action LIKE 'support.%' ORDER BY created_at")).rows.map((r) => r.action));
    expect(audit).toEqual(["support.closed", "support.open"]);
  });

  it("el resumen del súper admin cuenta las consultas por responder", async () => {
    const adm = await superAdmin("adm4");
    const h = hashOf(adm.cookie);
    // Otras pruebas corren a la vez y también abren consultas: si la cifra global se descuadra por eso, se repite.
    let last: unknown;
    for (let i = 0; i < 4; i++) {
      try {
        const before = (await getAdminOverview(h)).supportOpen;
        const t = await register(`ov${i}`);
        const a = (await open(t)).id;
        await open(t, "Otra consulta distinta");
        expect((await getAdminOverview(h)).supportOpen - before).toBe(2);
        await adminReply(api("POST", "/api/admin/support/reply", adm.cookie, { id: a, body: "hola" }));
        expect((await getAdminOverview(h)).supportOpen - before).toBe(1); // la respondida deja de contar
        await closeMine(api("POST", "/api/support/close", t.cookie, { id: a }));
        return;
      } catch (e) { last = e; }
    }
    throw last;
  });
});

describe("textos y validación", () => {
  it("cleanSupportText quita caracteres de control y de dirección, no los saltos de línea", () => {
    expect(cleanSupportText("  a\u0000b\u202Ec\u2066d\u0007e\nf\tg  ")).toBe("abcde\nf\tg");
  });
  it("el asunto colapsa espacios y el mensaje conserva sus saltos de línea", () => {
    const r = createTicketSchema.parse({ subject: "  Hola    mundo \n  otra  ", body: "línea 1\n\nlínea 2" });
    expect(r).toEqual({ subject: "Hola mundo otra", body: "línea 1\n\nlínea 2" });
  });
  it("los errores de tope se traducen; el resto no", () => {
    expect(supportDbError({ code: "53400", message: "demasiados tickets abiertos" })).toMatchObject({ status: 409, code: "demasiados_tickets" });
    expect(supportDbError({ code: "53400", message: "conversación demasiado larga" })).toMatchObject({ status: 409, code: "conversacion_larga" });
    expect(supportDbError({ code: "23505", message: "otra cosa" })).toBeNull();
    expect(supportDbError(new Error("x"))).toBeNull();
  });
});
