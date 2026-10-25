import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { POST as signup } from "@/app/api/auth/signup/route";
import { GET as listConversations } from "@/app/api/conversations/route";
import { GET as conversationDetail } from "@/app/api/conversations/messages/route";
import { POST as updateConversation } from "@/app/api/conversations/update/route";
import { GET as me } from "@/app/api/me/route";
import { GET as listWork, POST as createWork } from "@/app/api/work/route";
import { POST as updateWork } from "@/app/api/work/update/route";
import { runAgent } from "@/lib/agent/run";
import type { LlmProvider } from "@/lib/ai/provider";
import { encryptSecret } from "@/lib/crypto";
import { getPool, withTenant } from "@/lib/db";
import { closeLockClient } from "@/lib/queue/lock";
import { ingestBatch } from "@/lib/whatsapp/ingest";
import type { SendResult } from "@/lib/whatsapp/graph";

const RUN = randomUUID().slice(0, 8);
process.env.QUEUE_PREFIX = `test-w-${RUN}`;
const ORIGIN = new URL(process.env.APP_URL!).origin;
const PASSWORD = "contraseña-de-prueba-123";
const TOKEN = "EAAtoken-de-prueba-del-negocio-1234567890";
const owner = new Pool({ connectionString: process.env.MIGRATION_DATABASE_URL, max: 2 });
const tenantIds: string[] = [];
let seq = 0;
const newPhoneId = () => `7${RUN.replace(/\D/g, "").padEnd(4, "5").slice(0, 4)}${Date.now() % 100000}${seq++}`.slice(0, 18);
const newWaId = () => `58414${String(Date.now()).slice(-6)}${seq++}`.slice(0, 15);

function api(method: string, path: string, cookie?: string, body?: unknown) {
  return new Request(`${ORIGIN}${path}`, {
    method,
    headers: { origin: ORIGIN, ...(body !== undefined ? { "content-type": "application/json" } : {}), ...(cookie ? { cookie } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

async function register(name: string, opts: { agent?: boolean } = {}) {
  const email = `wk-${RUN}-${name}@example.test`;
  const res = await signup(api("POST", "/api/auth/signup", undefined, { email, password: PASSWORD, businessName: `Negocio ${name}` }));
  expect(res.status).toBe(201);
  const cookie = (res.headers.get("set-cookie") ?? "").split(";")[0]!;
  const info = await (await me(api("GET", "/api/me", cookie))).json();
  const tenantId = info.tenant.id as string;
  tenantIds.push(tenantId);
  const phoneId = newPhoneId();
  const { payload, keyVersion } = encryptSecret(TOKEN, `wa:${tenantId}:${phoneId}`);
  await owner.query("INSERT INTO tenant_integrations (tenant_id, provider, external_id, secret_enc, key_version) VALUES ($1,'whatsapp',$2,$3,$4)", [tenantId, phoneId, payload, keyVersion]);
  if (opts.agent) {
    await withTenant(tenantId, (db) => db.query("INSERT INTO tenant_agents (tenant_id, enabled, assistant_name, instructions) VALUES ($1, true, 'Ana', 'Abrimos de 8am a 5pm.')", [tenantId]));
  }
  return { tenantId, phoneId, cookie };
}
type T = Awaited<ReturnType<typeof register>>;

let t0 = Math.floor(Date.now() / 1000) - 3600;
/** Un cliente escribe (como lo haría el webhook). Devuelve los ids de su conversación y contacto. */
async function customer(t: T, body: string | null = "hola", opts: { name?: string; waId?: string; type?: string } = {}) {
  const waId = opts.waId ?? newWaId();
  const r = await ingestBatch({ phoneNumberId: t.phoneId, statuses: [], messages: [{ waId, name: opts.name ?? "Cliente", waMessageId: `wamid.${RUN}.${seq++}`, at: new Date(++t0 * 1000), type: opts.type ?? "text", body }] });
  const row = await withTenant(t.tenantId, async (db) =>
    (await db.query("SELECT c.id AS conv, c.contact_id AS contact FROM conversations c JOIN contacts ct ON ct.id = c.contact_id AND ct.tenant_id = c.tenant_id WHERE ct.wa_id = $1 AND c.status <> 'closed'", [waId])).rows[0],
  );
  return { waId, conv: row.conv as string, contact: row.contact as string, messageId: r.inbound[0]!.messageId };
}
const handoff = (t: T, conv: string, reason: string | null) =>
  withTenant(t.tenantId, (db) => db.query("UPDATE conversations SET status = 'human', handoff_reason = $2 WHERE id = $1 AND status = 'bot'", [conv, reason]));
const setStatus = (t: T, conv: string, status: string) => withTenant(t.tenantId, (db) => db.query("UPDATE conversations SET status = $2 WHERE id = $1", [conv, status]));
const items = (t: T, where = "true", params: unknown[] = []) =>
  withTenant(t.tenantId, async (db) => (await db.query(`SELECT * FROM work_items WHERE ${where} ORDER BY created_at, id`, params)).rows);
const events = (t: T, itemId: string) =>
  withTenant(t.tenantId, async (db) => (await db.query("SELECT kind, from_status, to_status, actor_user_id FROM work_item_events WHERE work_item_id = $1 ORDER BY created_at, id", [itemId])).rows);
const code = async (p: Promise<unknown>) => { try { await p; return undefined; } catch (e) { return (e as { code?: string }).code; } };

beforeAll(async () => { await getPool().query("SELECT 1"); });

afterAll(async () => {
  await closeLockClient();
  await owner.query("DELETE FROM users WHERE email LIKE $1", [`wk-${RUN}-%`]);
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

describe("tareas: se crean y se cierran solas con la conversación (base de datos)", () => {
  it("el traspaso a una persona crea UNA tarea de alta prioridad con nombre y motivo", async () => {
    const t = await register("auto1");
    const c = await customer(t, "quiero hablar con alguien", { name: "María Pérez" });
    await handoff(t, c.conv, "pedido_de_persona");
    const rows = await items(t);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      type: "atencion_humana", status: "abierto", priority: 1, source: "agente",
      title: "Atender a María Pérez", conversation_id: c.conv, contact_id: c.contact,
    });
    expect(rows[0].detail).toContain("pidió hablar con una persona");
    expect(await events(t, rows[0].id)).toEqual([{ kind: "creado", from_status: null, to_status: "abierto", actor_user_id: null }]);
  });

  it("sin nombre se usa el número; un motivo desconocido o vacío da un texto genérico", async () => {
    const t = await register("auto2");
    const a = await customer(t, "hola", { name: "" });
    await handoff(t, a.conv, "motivo_que_no_existe");
    const b = await customer(t);
    await handoff(t, b.conv, null);
    const rows = await items(t);
    expect(rows.find((r) => r.conversation_id === a.conv)!.title).toBe(`Atender a +${a.waId}`);
    for (const r of rows) expect(r.detail).toBe("El asistente pasó esta conversación a una persona.");
  });

  it("cada motivo del asistente tiene su explicación", async () => {
    const t = await register("auto3");
    const want: Record<string, string> = {
      limite_diario: "límite diario", limite_contacto: "escribió muchísimo", intentos_de_manipulacion: "manipular",
      envio_rechazado: "rechazó", envio_incierto: "confirmar si la respuesta llegó", fuga_de_instrucciones: "revelar sus instrucciones",
      salida_bloqueada: "bloqueó", respuesta_vacia: "no pudo generar", agente_fallo: "fallo",
    };
    for (const [reason, text] of Object.entries(want)) {
      const c = await customer(t);
      await handoff(t, c.conv, reason);
      const [row] = await items(t, "conversation_id = $1", [c.conv]);
      expect(row.detail, reason).toContain(text);
    }
  });

  it("si una persona la toma a propósito (tomada_por_persona) no se crea tarea", async () => {
    const t = await register("auto4");
    const c = await customer(t);
    await handoff(t, c.conv, "tomada_por_persona");
    expect(await items(t)).toHaveLength(0);
  });

  it("devolver la conversación al asistente resuelve la tarea sola y queda en el historial; otro traspaso crea otra", async () => {
    const t = await register("auto5");
    const c = await customer(t);
    await handoff(t, c.conv, "pedido_de_persona");
    const [first] = await items(t);
    await setStatus(t, c.conv, "bot");
    const [after] = await items(t);
    expect(after).toMatchObject({ status: "resuelto" });
    expect(after.resolved_at).not.toBeNull();
    expect(await events(t, first.id)).toEqual([
      { kind: "creado", from_status: null, to_status: "abierto", actor_user_id: null },
      { kind: "estado", from_status: "abierto", to_status: "resuelto", actor_user_id: null },
    ]);
    await handoff(t, c.conv, "limite_diario");
    const all = await items(t);
    expect(all).toHaveLength(2);
    expect(all.filter((r) => r.status === "abierto")).toHaveLength(1);
  });

  it("cerrar la conversación resuelve la tarea de atención", async () => {
    const t = await register("auto6");
    const c = await customer(t);
    await handoff(t, c.conv, "pedido_de_persona");
    await setStatus(t, c.conv, "closed");
    expect((await items(t))[0]).toMatchObject({ status: "resuelto" });
  });

  it("solo toca las tareas de atención de ESA conversación (no otras tareas ni otras conversaciones)", async () => {
    const t = await register("auto7");
    const a = await customer(t);
    const b = await customer(t);
    await handoff(t, a.conv, "pedido_de_persona");
    await handoff(t, b.conv, "pedido_de_persona");
    await withTenant(t.tenantId, (db) => db.query("INSERT INTO work_items (tenant_id, type, title, source, conversation_id, contact_id) VALUES ($1,'seguimiento','Llamar mañana','manual',$2,$3)", [t.tenantId, a.conv, a.contact]));
    await setStatus(t, a.conv, "closed");
    const rows = await items(t);
    expect(rows.find((r) => r.type === "atencion_humana" && r.conversation_id === a.conv)!.status).toBe("resuelto");
    expect(rows.find((r) => r.type === "atencion_humana" && r.conversation_id === b.conv)!.status).toBe("abierto");
    expect(rows.find((r) => r.type === "seguimiento")!.status).toBe("abierto");
  });

  it("no hay dos tareas de atención abiertas para la misma conversación", async () => {
    const t = await register("auto8");
    const c = await customer(t);
    await handoff(t, c.conv, "pedido_de_persona");
    const dup = await code(withTenant(t.tenantId, (db) =>
      db.query("INSERT INTO work_items (tenant_id, type, title, source, conversation_id, contact_id) VALUES ($1,'atencion_humana','otra','manual',$2,$3)", [t.tenantId, c.conv, c.contact])));
    expect(dup).toBe("23505");
  });
});

describe("tareas: historial, aislamiento y reglas de la base", () => {
  it("cada cambio de estado o de responsable queda registrado con quien lo hizo", async () => {
    const t = await register("log1");
    const userId = (await owner.query("SELECT id FROM users WHERE email = $1", [`wk-${RUN}-log1@example.test`])).rows[0].id as string;
    await withTenant(t.tenantId, async (db) => {
      await db.query("SELECT set_config('app.actor', $1, true)", [userId]);
      const r = await db.query("INSERT INTO work_items (tenant_id, type, title, source, created_by) VALUES ($1,'tarea','Revisar caja','manual',$2) RETURNING id", [t.tenantId, userId]);
      await db.query("UPDATE work_items SET status = 'en_proceso', assigned_to = $2 WHERE id = $1", [r.rows[0].id, userId]);
      await db.query("UPDATE work_items SET status = 'resuelto', resolved_at = now(), resolved_by = $2 WHERE id = $1", [r.rows[0].id, userId]);
    });
    const [row] = await items(t);
    expect(await events(t, row.id)).toEqual([
      { kind: "creado", from_status: null, to_status: "abierto", actor_user_id: userId },
      { kind: "estado", from_status: "abierto", to_status: "en_proceso", actor_user_id: userId },
      { kind: "asignado", from_status: null, to_status: null, actor_user_id: userId },
      { kind: "estado", from_status: "en_proceso", to_status: "resuelto", actor_user_id: userId },
    ]);
    expect(row.updated_at.getTime()).toBeGreaterThanOrEqual(row.created_at.getTime());
  });

  it("el historial es de solo agregar: la aplicación no puede editarlo ni borrarlo", async () => {
    const t = await register("log2");
    const c = await customer(t);
    await handoff(t, c.conv, "pedido_de_persona");
    expect(await code(withTenant(t.tenantId, (db) => db.query("UPDATE work_item_events SET kind = 'estado'")))).toBe("42501");
    expect(await code(withTenant(t.tenantId, (db) => db.query("DELETE FROM work_item_events")))).toBe("42501");
  });

  it("un negocio no ve las tareas ni el historial de otro, ni puede apuntar a sus conversaciones", async () => {
    const a = await register("iso-a");
    const b = await register("iso-b");
    const ca = await customer(a);
    await handoff(a, ca.conv, "pedido_de_persona");
    expect(await items(a)).toHaveLength(1);
    expect(await items(b)).toHaveLength(0);
    const evB = await withTenant(b.tenantId, async (db) => (await db.query("SELECT count(*)::int AS n FROM work_item_events")).rows[0].n);
    expect(evB).toBe(0);
    // Intentar crear una tarea de B colgada de una conversación de A: lo impide la llave foránea compuesta.
    expect(await code(withTenant(b.tenantId, (db) =>
      db.query("INSERT INTO work_items (tenant_id, type, title, source, conversation_id) VALUES ($1,'tarea','x','manual',$2)", [b.tenantId, ca.conv])))).toBe("23503");
    // Y B no puede escribir con el negocio de A.
    expect(await code(withTenant(b.tenantId, (db) =>
      db.query("INSERT INTO work_items (tenant_id, type, title, source) VALUES ($1,'tarea','x','manual')", [a.tenantId])))).toBe("42501");
  });

  it("restricciones: tipo y estado válidos, resuelta ⇔ con fecha de resolución, clave anti-duplicado por negocio", async () => {
    const a = await register("chk-a");
    const b = await register("chk-b");
    const ins = (t: T, extra = "", vals: unknown[] = []) =>
      withTenant(t.tenantId, (db) => db.query(`INSERT INTO work_items (tenant_id, type, title, source${extra ? ", " + extra.split("|")[0] : ""}) VALUES ($1,'tarea','x','manual'${extra ? ", " + extra.split("|")[1] : ""})`, [t.tenantId, ...vals]));
    expect(await code(withTenant(a.tenantId, (db) => db.query("INSERT INTO work_items (tenant_id, type, title, source) VALUES ($1,'inventado','x','manual')", [a.tenantId])))).toBe("23514");
    expect(await code(withTenant(a.tenantId, (db) => db.query("INSERT INTO work_items (tenant_id, type, title, source, priority) VALUES ($1,'tarea','x','manual', 9)", [a.tenantId])))).toBe("23514");
    expect(await code(withTenant(a.tenantId, (db) => db.query("INSERT INTO work_items (tenant_id, type, title, source) VALUES ($1,'tarea','','manual')", [a.tenantId])))).toBe("23514");
    expect(await code(ins(a, "status|'resuelto'"))).toBe("23514"); // resuelta sin fecha
    expect(await code(ins(a, "resolved_at|now()"))).toBe("23514"); // fecha sin estar resuelta
    expect(await code(ins(a, "dedupe_key|$2", ["cita:1"]))).toBeUndefined();
    expect(await code(ins(a, "dedupe_key|$2", ["cita:1"]))).toBe("23505");
    expect(await code(ins(b, "dedupe_key|$2", ["cita:1"]))).toBeUndefined(); // otro negocio: sin problema
  });
});

describe("tareas: API", () => {
  it("sin sesión 401; datos inválidos 400; no se puede crear 'atención personal' a mano", async () => {
    const t = await register("api0");
    expect((await listWork(api("GET", "/api/work"))).status).toBe(401);
    expect((await createWork(api("POST", "/api/work", undefined, { type: "tarea", title: "x" }))).status).toBe(401);
    for (const bad of [{ type: "tarea", title: "" }, { type: "tarea", title: "  " }, { type: "atencion_humana", title: "x" }, { type: "tarea", title: "x", priority: 7 }, { type: "tarea", title: "x", dueAt: "mañana" }, { type: "tarea", title: "x", conversationId: "no-uuid" }, { type: "tarea", title: "x".repeat(201) }]) {
      expect((await createWork(api("POST", "/api/work", t.cookie, bad))).status, JSON.stringify(bad)).toBe(400);
    }
    // Origen distinto: bloqueado (CSRF).
    const evil = new Request(`${ORIGIN}/api/work`, { method: "POST", headers: { origin: "https://malo.example", "content-type": "application/json", cookie: t.cookie }, body: JSON.stringify({ type: "tarea", title: "x" }) });
    expect((await createWork(evil)).status).toBe(403);
    expect((await updateWork(api("POST", "/api/work/update", undefined, { id: randomUUID(), action: "resolve" }))).status).toBe(401);
  });

  it("crear a mano: queda 'manual', con quien la creó, con conversación y contacto si se indica", async () => {
    const t = await register("api1");
    const c = await customer(t, "hola", { name: "Luis" });
    const res = await createWork(api("POST", "/api/work", t.cookie, { type: "pago_por_verificar", title: "Pago de Luis", detail: "Ref 123", priority: 1, dueAt: "2026-12-01T15:00:00Z", conversationId: c.conv }));
    expect(res.status).toBe(201);
    const [row] = await items(t);
    expect(row).toMatchObject({ type: "pago_por_verificar", source: "manual", priority: 1, detail: "Ref 123", conversation_id: c.conv, contact_id: c.contact });
    expect(row.created_by).toBeTruthy();
    expect(row.due_at.toISOString()).toBe("2026-12-01T15:00:00.000Z");
    expect((await events(t, row.id))[0]).toMatchObject({ kind: "creado", actor_user_id: row.created_by });
  });

  it("una conversación de otro negocio -> 404 y no se crea nada", async () => {
    const a = await register("api2a");
    const b = await register("api2b");
    const ca = await customer(a);
    expect((await createWork(api("POST", "/api/work", b.cookie, { type: "tarea", title: "x", conversationId: ca.conv }))).status).toBe(404);
    expect(await items(b)).toHaveLength(0);
  });

  it("tope de 500 tareas manuales pendientes", async () => {
    const t = await register("api3");
    await withTenant(t.tenantId, (db) => db.query("INSERT INTO work_items (tenant_id, type, title, source) SELECT $1, 'tarea', 't' || g, 'manual' FROM generate_series(1, 500) g", [t.tenantId]));
    const res = await createWork(api("POST", "/api/work", t.cookie, { type: "tarea", title: "una más" }));
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("limite_tareas");
    // Resolver una libera cupo.
    await withTenant(t.tenantId, (db) => db.query("UPDATE work_items SET status = 'resuelto', resolved_at = now() WHERE id = (SELECT id FROM work_items LIMIT 1)"));
    expect((await createWork(api("POST", "/api/work", t.cookie, { type: "tarea", title: "una más" }))).status).toBe(201);
  });

  it("la lista va por urgencia: prioridad, luego fecha límite (las sin fecha al final) y cuenta por tipo", async () => {
    const t = await register("api4");
    const mk = (title: string, priority: number, due?: string, type = "tarea") => createWork(api("POST", "/api/work", t.cookie, { type, title, priority, ...(due ? { dueAt: due } : {}) }));
    await mk("D baja", 3);
    await mk("A normal sin fecha", 2);
    await mk("C normal con fecha", 2, "2026-11-01T10:00:00Z");
    await mk("B alta", 1, undefined, "seguimiento");
    await mk("B2 alta con fecha", 1, "2026-10-20T10:00:00Z", "seguimiento");
    const res = await (await listWork(api("GET", "/api/work", t.cookie))).json();
    expect(res.items.map((i: { title: string }) => i.title)).toEqual(["B2 alta con fecha", "B alta", "C normal con fecha", "A normal sin fecha", "D baja"]);
    expect(res.counts).toEqual({ tarea: 3, seguimiento: 2 });
    expect(res.items[0]).toMatchObject({ type: "seguimiento", priority: 1, assignedToMe: false, assigned: false });
  });

  it("empezar → resolver → reabrir, con responsable e historial", async () => {
    const t = await register("api5");
    await createWork(api("POST", "/api/work", t.cookie, { type: "tarea", title: "Cobrar" }));
    const id = (await items(t))[0].id as string;
    const act = (action: string) => updateWork(api("POST", "/api/work/update", t.cookie, { id, action }));

    expect((await act("start")).status).toBe(200);
    let list = await (await listWork(api("GET", "/api/work", t.cookie))).json();
    expect(list.items[0]).toMatchObject({ status: "en_proceso", assignedToMe: true });
    expect((await act("start")).status).toBe(409); // ya está en proceso
    expect((await act("reopen")).status).toBe(409); // no está cerrada

    expect((await act("resolve")).status).toBe(200);
    expect((await items(t))[0].resolved_by).toBeTruthy();
    expect((await act("resolve")).status).toBe(409);
    expect((await act("dismiss")).status).toBe(409);
    expect((await act("take")).status).toBe(409);
    list = await (await listWork(api("GET", "/api/work", t.cookie))).json();
    expect(list.items).toHaveLength(0);
    const done = await (await listWork(api("GET", "/api/work?scope=done", t.cookie))).json();
    expect(done.items).toHaveLength(1);
    expect(done.items[0].status).toBe("resuelto");

    expect((await act("reopen")).status).toBe(200);
    const [row] = await items(t);
    expect(row).toMatchObject({ status: "abierto", resolved_at: null, resolved_by: null });
    expect((await act("dismiss")).status).toBe(200);
    expect((await items(t))[0].status).toBe("descartado");

    const hist = (await events(t, id)).map((e) => `${e.kind}:${e.from_status ?? ""}>${e.to_status ?? ""}`);
    expect(hist).toEqual(["creado:>abierto", "estado:abierto>en_proceso", "asignado:>", "estado:en_proceso>resuelto", "estado:resuelto>abierto", "estado:abierto>descartado"]);
  });

  it("tomar y soltar una tarea", async () => {
    const t = await register("api6");
    await createWork(api("POST", "/api/work", t.cookie, { type: "tarea", title: "Llamar" }));
    const id = (await items(t))[0].id as string;
    expect((await updateWork(api("POST", "/api/work/update", t.cookie, { id, action: "take" }))).status).toBe(200);
    expect((await (await listWork(api("GET", "/api/work", t.cookie))).json()).items[0].assignedToMe).toBe(true);
    expect((await updateWork(api("POST", "/api/work/update", t.cookie, { id, action: "release" }))).status).toBe(200);
    expect((await (await listWork(api("GET", "/api/work", t.cookie))).json()).items[0].assigned).toBe(false);
  });

  it("no se puede tocar la tarea de otro negocio (404) ni con id inventado; acciones raras -> 400", async () => {
    const a = await register("api7a");
    const b = await register("api7b");
    await createWork(api("POST", "/api/work", a.cookie, { type: "tarea", title: "Mía" }));
    const id = (await items(a))[0].id as string;
    for (const action of ["start", "resolve", "dismiss", "take"]) {
      expect((await updateWork(api("POST", "/api/work/update", b.cookie, { id, action }))).status, action).toBe(404);
    }
    expect((await updateWork(api("POST", "/api/work/update", b.cookie, { id: randomUUID(), action: "resolve" }))).status).toBe(404);
    expect((await items(a))[0].status).toBe("abierto");
    expect((await updateWork(api("POST", "/api/work/update", a.cookie, { id, action: "borrar" }))).status).toBe(400);
    expect((await updateWork(api("POST", "/api/work/update", a.cookie, { id: "no-uuid", action: "resolve" }))).status).toBe(400);
    expect((await (await listWork(api("GET", "/api/work", b.cookie))).json()).items).toHaveLength(0);
  });

  it("reabrir una atención personal cuando ya hay otra abierta -> 409 sin romper nada", async () => {
    const t = await register("api8");
    const c = await customer(t);
    await handoff(t, c.conv, "pedido_de_persona");
    await setStatus(t, c.conv, "bot"); // resuelve la 1.ª
    await handoff(t, c.conv, "limite_diario"); // crea la 2.ª
    const first = (await items(t))[0].id as string;
    const res = await updateWork(api("POST", "/api/work/update", t.cookie, { id: first, action: "reopen" }));
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("tarea_duplicada");
    expect((await items(t)).map((r) => r.status)).toEqual(["resuelto", "abierto"]);
  });
});

describe("bandeja de conversaciones: API", () => {
  it("lista con vista previa, etiqueta y aviso de atención; los filtros separan por estado", async () => {
    const t = await register("inb1");
    const a = await customer(t, "Hola, ¿tienen disponibilidad?", { name: "Ana" });
    const b = await customer(t, "Quiero un humano", { name: "Beto" });
    const c = await customer(t, "gracias", { name: "Carla" });
    await handoff(t, b.conv, "pedido_de_persona");
    await setStatus(t, c.conv, "closed");
    const get = async (qs = "") => (await (await listConversations(api("GET", `/api/conversations${qs}`, t.cookie))).json()).conversations as { id: string; contact: { name: string; label: string }; lastPreview: string; needsAttention: boolean; status: string; lastDirection: string }[];

    const activas = await get();
    expect(activas.map((x) => x.contact.name).sort()).toEqual(["Ana", "Beto"]);
    expect(activas.find((x) => x.contact.name === "Ana")).toMatchObject({ lastPreview: "Hola, ¿tienen disponibilidad?", needsAttention: false, status: "bot", lastDirection: "in", contact: { label: "sin_clasificar" } });
    expect(activas.find((x) => x.contact.name === "Beto")).toMatchObject({ needsAttention: true, status: "human" });
    expect((await get("?filter=persona")).map((x) => x.contact.name)).toEqual(["Beto"]);
    expect((await get("?filter=asistente")).map((x) => x.contact.name)).toEqual(["Ana"]);
    expect((await get("?filter=cerradas")).map((x) => x.contact.name)).toEqual(["Carla"]);
    await updateConversation(api("POST", "/api/conversations/update", t.cookie, { id: a.conv, action: "label", label: "cliente" }));
    expect((await get("?label=cliente")).map((x) => x.contact.name)).toEqual(["Ana"]);
    expect((await get("?label=personal"))).toEqual([]);
    expect((await listConversations(api("GET", "/api/conversations?filter=otra", t.cookie))).status).toBe(400);
    expect((await listConversations(api("GET", "/api/conversations?label=rara", t.cookie))).status).toBe(400);
    expect((await listConversations(api("GET", "/api/conversations"))).status).toBe(401);
  });

  it("los mensajes que no son texto se muestran con su tipo; el orden es el más reciente primero", async () => {
    const t = await register("inb2");
    const a = await customer(t, "primero", { name: "Ana" });
    await customer(t, null, { name: "Beto", type: "image" });
    const list = (await (await listConversations(api("GET", "/api/conversations", t.cookie))).json()).conversations;
    expect(list.map((x: { contact: { name: string } }) => x.contact.name)).toEqual(["Beto", "Ana"]);
    expect(list[0].lastPreview).toBe("[Imagen]");
    expect(a.conv).toBeTruthy();
  });

  it("páginas de 40: 'before' trae las siguientes y no repite", async () => {
    const t = await register("inb3");
    for (let i = 0; i < 42; i++) await customer(t, `msg ${i}`, { name: `C${i}` });
    const p1 = await (await listConversations(api("GET", "/api/conversations", t.cookie))).json();
    expect(p1.conversations).toHaveLength(40);
    expect(p1.nextBefore).toBeTruthy();
    const p2 = await (await listConversations(api("GET", `/api/conversations?before=${encodeURIComponent(p1.nextBefore)}`, t.cookie))).json();
    expect(p2.conversations).toHaveLength(2);
    expect(p2.nextBefore).toBeNull();
    const ids = new Set([...p1.conversations, ...p2.conversations].map((x: { id: string }) => x.id));
    expect(ids.size).toBe(42);
  });

  it("aislamiento: cada negocio ve solo sus conversaciones", async () => {
    const a = await register("inb4a");
    const b = await register("inb4b");
    const ca = await customer(a, "secreto de A");
    expect((await (await listConversations(api("GET", "/api/conversations", b.cookie))).json()).conversations).toEqual([]);
    expect((await conversationDetail(api("GET", `/api/conversations/messages?id=${ca.conv}`, b.cookie))).status).toBe(404);
    expect((await updateConversation(api("POST", "/api/conversations/update", b.cookie, { id: ca.conv, action: "close" }))).status).toBe(404);
    expect((await updateConversation(api("POST", "/api/conversations/update", b.cookie, { id: ca.conv, action: "label", label: "personal" }))).status).toBe(404);
    expect((await items(a, "true"))).toHaveLength(0);
    const still = await withTenant(a.tenantId, async (db) => (await db.query("SELECT c.status, ct.label FROM conversations c JOIN contacts ct ON ct.id = c.contact_id")).rows[0]);
    expect(still).toEqual({ status: "bot", label: "sin_clasificar" });
  });

  it("detalle: mensajes en orden, tareas abiertas, estado y quién la tiene", async () => {
    const t = await register("det1");
    const c = await customer(t, "uno", { name: "Ana" });
    await customer(t, "dos", { name: "Ana", waId: c.waId });
    await customer(t, "tres", { name: "Ana", waId: c.waId });
    await withTenant(t.tenantId, (db) => db.query(`INSERT INTO messages (tenant_id, conversation_id, direction, body, send_state, wa_message_id, received_at)
      VALUES ($1,$2,'out','respuesta del asistente','sent',$3, (SELECT max(received_at) + interval '1 second' FROM messages WHERE conversation_id = $2))`, [t.tenantId, c.conv, `wamid.out.${randomUUID()}`]));
    await handoff(t, c.conv, "pedido_de_persona");
    const d = await (await conversationDetail(api("GET", `/api/conversations/messages?id=${c.conv}`, t.cookie))).json();
    expect(d.conversation).toMatchObject({ id: c.conv, status: "human", handoffReason: "pedido_de_persona", assignedToMe: false, contact: { name: "Ana", label: "sin_clasificar", waId: c.waId } });
    expect(d.messages.map((m: { body: string }) => m.body)).toEqual(["uno", "dos", "tres", "respuesta del asistente"]);
    expect(d.messages[3]).toMatchObject({ direction: "out", sendState: "sent" });
    expect(d.work).toHaveLength(1);
    expect(d.work[0]).toMatchObject({ type: "atencion_humana", status: "abierto" });
    expect((await conversationDetail(api("GET", "/api/conversations/messages?id=no-uuid", t.cookie))).status).toBe(400);
    expect((await conversationDetail(api("GET", `/api/conversations/messages?id=${randomUUID()}`, t.cookie))).status).toBe(404);
    expect((await conversationDetail(api("GET", `/api/conversations/messages?id=${c.conv}`))).status).toBe(401);
  });

  it("el detalle trae solo los últimos 100 mensajes, en orden", async () => {
    const t = await register("det2");
    const c = await customer(t, "m0");
    await withTenant(t.tenantId, (db) =>
      db.query(`INSERT INTO messages (tenant_id, conversation_id, direction, body, received_at)
                SELECT $1, $2, 'in', 'm' || g, now() + g * interval '1 second' FROM generate_series(1, 120) g`, [t.tenantId, c.conv]));
    const d = await (await conversationDetail(api("GET", `/api/conversations/messages?id=${c.conv}`, t.cookie))).json();
    expect(d.messages).toHaveLength(100);
    expect(d.messages[0].body).toBe("m21");
    expect(d.messages[99].body).toBe("m120");
  });

  it("tomar, devolver y cerrar; no se toma una cerrada; devolver solo si está con una persona", async () => {
    const t = await register("act1");
    const c = await customer(t);
    const act = (body: object) => updateConversation(api("POST", "/api/conversations/update", t.cookie, { id: c.conv, ...body }));
    const state = () => withTenant(t.tenantId, async (db) => (await db.query("SELECT status, handoff_reason, assigned_to FROM conversations WHERE id = $1", [c.conv])).rows[0]);

    expect((await act({ action: "release" })).status).toBe(409); // ya está con el asistente
    expect((await act({ action: "take" })).status).toBe(200);
    expect(await state()).toMatchObject({ status: "human", handoff_reason: "tomada_por_persona" });
    expect((await state()).assigned_to).toBeTruthy();
    expect(await items(t)).toHaveLength(0); // tomarla uno mismo no genera tarea
    expect((await act({ action: "release" })).status).toBe(200);
    expect(await state()).toMatchObject({ status: "bot", handoff_reason: null, assigned_to: null });
    expect((await act({ action: "close" })).status).toBe(200);
    expect((await act({ action: "close" })).status).toBe(200); // idempotente
    expect((await act({ action: "take" })).status).toBe(409);
    expect((await act({ action: "release" })).status).toBe(409);
    expect((await act({ action: "label", label: "inexistente" })).status).toBe(400);
    expect((await act({ action: "otra" })).status).toBe(400);
  });

  it("tomar una conversación que el asistente pasó a una persona la deja asignada, conserva el motivo y mantiene la tarea", async () => {
    const t = await register("act2");
    const c = await customer(t);
    await handoff(t, c.conv, "limite_diario");
    expect((await updateConversation(api("POST", "/api/conversations/update", t.cookie, { id: c.conv, action: "take" }))).status).toBe(200);
    const d = await (await conversationDetail(api("GET", `/api/conversations/messages?id=${c.conv}`, t.cookie))).json();
    expect(d.conversation).toMatchObject({ status: "human", handoffReason: "limite_diario", assignedToMe: true });
    expect(d.work).toHaveLength(1);
    // Devolverla al asistente cierra la tarea de atención.
    await updateConversation(api("POST", "/api/conversations/update", t.cookie, { id: c.conv, action: "release" }));
    expect((await items(t))[0].status).toBe("resuelto");
  });

  it("cerrar una conversación con atención pendiente resuelve la tarea; el cliente que vuelve a escribir abre una nueva", async () => {
    const t = await register("act3");
    const c = await customer(t);
    await handoff(t, c.conv, "pedido_de_persona");
    await updateConversation(api("POST", "/api/conversations/update", t.cookie, { id: c.conv, action: "close" }));
    expect((await items(t))[0].status).toBe("resuelto");
    const again = await customer(t, "hola otra vez", { waId: c.waId });
    expect(again.conv).not.toBe(c.conv);
  });

  it("la etiqueta cambia al contacto (no a la conversación) y vale para todas sus conversaciones", async () => {
    const t = await register("lab1");
    const c = await customer(t);
    await updateConversation(api("POST", "/api/conversations/update", t.cookie, { id: c.conv, action: "label", label: "prospecto" }));
    await updateConversation(api("POST", "/api/conversations/update", t.cookie, { id: c.conv, action: "close" }));
    const again = await customer(t, "hola", { waId: c.waId });
    const d = await (await conversationDetail(api("GET", `/api/conversations/messages?id=${again.conv}`, t.cookie))).json();
    expect(d.conversation.contact.label).toBe("prospecto");
  });
});

describe("agente + centro de trabajo", () => {
  const sent = (): SendResult => ({ kind: "sent", waMessageId: `wamid.out.${randomUUID()}` });
  function deps(text = "Hola, abrimos de 8am a 5pm.") {
    const llm = { name: "stub", generate: vi.fn(async () => ({ text, inputTokens: 1, outputTokens: 1, model: "stub" })) };
    const send = vi.fn(async (...args: unknown[]) => (void args, sent()));
    return { llm, send, raw: { llm: llm as unknown as LlmProvider, send: send as never } };
  }
  const outCount = (t: T) => withTenant(t.tenantId, async (db) => (await db.query("SELECT count(*)::int AS n FROM messages WHERE direction = 'out'")).rows[0].n as number);

  it("a un contacto 'personal' el asistente NO le responde (ni gasta IA); si se reclasifica, vuelve a responder", async () => {
    const t = await register("ag1", { agent: true });
    const c = await customer(t, "hola mami", { name: "Mamá" });
    await updateConversation(api("POST", "/api/conversations/update", t.cookie, { id: c.conv, action: "label", label: "personal" }));
    const d = deps();
    expect(await runAgent({ tenantId: t.tenantId, messageId: c.messageId }, d.raw)).toBe("skipped_personal");
    expect(d.llm.generate).not.toHaveBeenCalled();
    expect(d.send).not.toHaveBeenCalled();
    expect(await outCount(t)).toBe(0);
    expect(await items(t)).toHaveLength(0);

    await updateConversation(api("POST", "/api/conversations/update", t.cookie, { id: c.conv, action: "label", label: "cliente" }));
    expect(await runAgent({ tenantId: t.tenantId, messageId: c.messageId }, d.raw)).toBe("replied");
    expect(d.send).toHaveBeenCalledTimes(1);
  });

  it("si el cliente pide una persona, el asistente la pasa y aparece la tarea en la cola", async () => {
    const t = await register("ag2", { agent: true });
    const c = await customer(t, "quiero hablar con una persona, por favor", { name: "Pedro" });
    const d = deps();
    expect(await runAgent({ tenantId: t.tenantId, messageId: c.messageId }, d.raw)).toBe("handoff");
    const list = await (await listWork(api("GET", "/api/work", t.cookie))).json();
    expect(list.items).toHaveLength(1);
    expect(list.items[0]).toMatchObject({ type: "atencion_humana", priority: 1, title: "Atender a Pedro", conversationId: c.conv, source: "agente" });
    // Mientras una persona la tiene, el asistente calla.
    const m2 = await customer(t, "¿hola?", { waId: c.waId });
    expect(await runAgent({ tenantId: t.tenantId, messageId: m2.messageId }, d.raw)).toBe("skipped_human");
    // Al devolverla al asistente, la tarea se cierra y el asistente vuelve a responder.
    await updateConversation(api("POST", "/api/conversations/update", t.cookie, { id: c.conv, action: "release" }));
    expect((await (await listWork(api("GET", "/api/work", t.cookie))).json()).items).toHaveLength(0);
    const m3 = await customer(t, "¿a qué hora abren?", { waId: c.waId });
    expect(await runAgent({ tenantId: t.tenantId, messageId: m3.messageId }, d.raw)).toBe("replied");
  });
});
