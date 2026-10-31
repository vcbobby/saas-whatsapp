import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { POST as signup } from "@/app/api/auth/signup/route";
import { GET as me } from "@/app/api/me/route";
import { POST as teamInvite } from "@/app/api/team/invite/route";
import { POST as inviteSignup } from "@/app/api/invitations/signup/route";
import { GET as listB, POST as createB } from "@/app/api/broadcasts/route";
import { POST as previewB } from "@/app/api/broadcasts/preview/route";
import { POST as updateB } from "@/app/api/broadcasts/update/route";
import { GET as detailB } from "@/app/api/broadcasts/detail/route";
import { encryptSecret } from "@/lib/crypto";
import { DAILY_CAP, firstName, paramValues, processBroadcast, sendRecipient } from "@/lib/broadcasts/send";
import { hasOptOut } from "@/lib/broadcasts/template";
import type { SendResult } from "@/lib/whatsapp/graph";
import { getPool } from "@/lib/db";

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
  const email = `df-${RUN}-${name}@example.test`;
  const res = await signup(api("POST", "/api/auth/signup", undefined, { email, password: PASSWORD, businessName: `Negocio ${name}` }));
  expect(res.status).toBe(201);
  const cookie = (res.headers.get("set-cookie") ?? "").split(";")[0]!;
  const info = await (await me(api("GET", "/api/me", cookie))).json();
  tenantIds.push(info.tenant.id);
  const phoneId = `7${Date.now() % 1000000000}${seq++}`.slice(0, 16);
  const enc = encryptSecret("EAAtoken-de-prueba-1234567890", `wa:${info.tenant.id}:${phoneId}`);
  await owner.query("INSERT INTO tenant_integrations (tenant_id, provider, external_id, secret_enc, key_version) VALUES ($1,'whatsapp',$2,$3,$4)", [info.tenant.id, phoneId, enc.payload, enc.keyVersion]);
  return { tenantId: info.tenant.id as string, cookie, email };
}
type T = Awaited<ReturnType<typeof register>>;
async function member(t: T, role: "admin" | "agent"): Promise<T & { email: string }> {
  const email = `df-${RUN}-${role}-${randomUUID().slice(0, 6)}@example.test`;
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




/** Consulta como dueño de la base, pero dentro del negocio (las tablas tienen aislamiento por negocio incluso para el dueño). */
async function oq(t: { tenantId: string }, sql: string, params: unknown[] = []) {
  const c = await owner.connect();
  try {
    await c.query("BEGIN");
    await c.query("SELECT set_config('app.tenant_id', $1, true)", [t.tenantId]);
    const r = await c.query(sql, params);
    await c.query("COMMIT");
    return r;
  } catch (e) { await c.query("ROLLBACK"); throw e; } finally { c.release(); }
}

const TEXT = "Hola {{1}}, esta semana 20% de descuento en toda la tienda. Responde BAJA para no recibir más promociones.";
let sent: string[] = [];
const okSend = async (_p: string, _t: string, to: string): Promise<SendResult> => { sent.push(to); return { kind: "sent", waMessageId: `wamid.T.${randomUUID()}` }; };
const deps = { sendTemplate: okSend as never };

async function template(t: T, body = TEXT, status = "APPROVED", sendable = true) {
  return (await oq(t, "INSERT INTO whatsapp_templates (tenant_id, name, language, category, body, status, sendable) VALUES ($1, $2, 'es', 'MARKETING', $3, $4, $5) RETURNING id", [t.tenantId, `promo_${randomUUID().slice(0, 6)}`, body, status, sendable])).rows[0].id as string;
}
async function person(t: T, wa: string, name: string | null, o: { consent?: boolean; off?: boolean; label?: string; tags?: string[] } = {}) {
  const consent = o.consent ?? true;
  return (await oq(t, 
    "INSERT INTO contacts (tenant_id, wa_id, display_name, label, tags, notifications_off, promo_consent_at, promo_consent_source) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id",
    [t.tenantId, wa, name, o.label ?? "cliente", o.tags ?? [], o.off ?? false, consent ? new Date() : null, consent ? "tienda" : null])).rows[0].id as string;
}
const body = (r: Response) => r.json();
const post = (fn: typeof createB, path: string, t: T, b: unknown, origin = ORIGIN) => fn(api("POST", path, t.cookie, b, origin));
const preview = (t: T, audience: object = {}) => post(previewB, "/api/broadcasts/preview", t, { audience });
const create = (t: T, templateId: string, o: { audience?: object; params?: unknown[]; name?: string } = {}) =>
  post(createB, "/api/broadcasts", t, { name: o.name ?? "Promo", templateId, params: o.params ?? [{ kind: "nombre" }], audience: o.audience ?? {} });
const act = (t: T, id: string, action: string, extra: object = {}) => post(updateB, "/api/broadcasts/update", t, { id, action, ...extra });
const start = (t: T, id: string) => act(t, id, "start", { confirmConsent: true });
const detail = (t: T, id: string) => detailB(api("GET", `/api/broadcasts/detail?id=${id}`, t.cookie));
async function recipients(t: T, id: string) {
  return (await oq(t, "SELECT r.status, r.reason, c.wa_id FROM broadcast_recipients r JOIN contacts c ON c.id = r.contact_id WHERE r.broadcast_id = $1 ORDER BY c.wa_id", [id])).rows as { status: string; reason: string | null; wa_id: string }[];
}
async function runAll(t: T, id: string, d = deps) {
  for (let i = 0; i < 10; i++) { const r = await processBroadcast(t.tenantId, id, d); if (r.state !== "enviando") return r; }
  return { sent: 0, failed: 0, state: "enviando" };
}

describe("difusiones: funciones puras", () => {
  it("saluda con el primer nombre y arma las variables", () => {
    expect(firstName("María José Pérez")).toBe("María");
    expect(firstName("  ")).toBe("cliente");
    expect(firstName(null)).toBe("cliente");
    expect(firstName("😀😀")).toBe("cliente");
    expect(paramValues([{ kind: "nombre" }, { kind: "texto", value: "20%" }], "Ana López")).toEqual(["Ana", "20%"]);
  });
  it("exige la frase de baja en la plantilla", () => {
    expect(hasOptOut("… Responde BAJA para salir")).toBe(true);
    expect(hasOptOut("Reply STOP to opt out")).toBe(true);
    expect(hasOptOut("Hola, gracias por tu compra")).toBe(false);
    expect(hasOptOut("rebajas de verano")).toBe(false);
  });
});

describe("difusiones: crear y vista previa", () => {
  it("la vista previa cuenta a quién llega y explica a quién deja fuera", async () => {
    const t = await register("prev");
    await person(t, "584120000001", "Ana", { tags: ["vip"] });
    await person(t, "584120000002", "Luis");
    await person(t, "584120000003", "Sin permiso", { consent: false });
    await person(t, "584120000004", "De baja", { off: true });
    await person(t, "584120000005", "Personal", { label: "personal" });
    const conPersona = await person(t, "584120000006", "Con persona");
    await oq(t, "INSERT INTO conversations (tenant_id, contact_id, status) VALUES ($1, $2, 'human')", [t.tenantId, conPersona]);
    const p = await body(await preview(t));
    expect(p).toMatchObject({ matched: 6, eligible: 2, excluded: { sin_permiso: 1, baja: 1, personal: 1, con_persona: 1 } });
    expect(p.sample.sort()).toEqual(["Ana", "Luis"]);
    expect((await body(await preview(t, { tag: "VIP" }))).eligible).toBe(1);
    expect((await body(await preview(t, { label: "prospecto" }))).matched).toBe(0);
    expect((await preview(t, { tag: "x", raro: 1 })).status).toBe(400);
  });

  it("solo crea con una plantilla aprobada, enviable, con frase de baja y las variables bien configuradas", async () => {
    const t = await register("crea");
    const ok = await template(t);
    expect((await create(t, ok)).status).toBe(201);
    expect((await create(t, await template(t, TEXT, "PENDING"))).status).toBe(400);
    expect((await create(t, await template(t, TEXT, "APPROVED", false))).status).toBe(400);
    expect((await create(t, await template(t, "Hola {{1}}, 20% de descuento hoy en la tienda."))).status).toBe(400);
    expect((await create(t, ok, { params: [] })).status).toBe(400);
    expect((await create(t, ok, { params: [{ kind: "texto", value: "" }] })).status).toBe(400);
    expect((await create(t, randomUUID())).status).toBe(400);
    expect((await create(t, ok, { name: "  " })).status).toBe(400);
    expect((await create(t, ok)).status).toBe(201);
    const l = await body(await listB(api("GET", "/api/broadcasts", t.cookie)));
    expect(l.broadcasts).toHaveLength(2);
    expect(l.broadcasts[0]).toMatchObject({ status: "borrador", total: 0 });
  });

  it("solo dueño y administrador; no cruza negocios; exige origen", async () => {
    const A = await register("permA"); const B = await register("permB");
    const agent = await member(A, "agent");
    const tpl = await template(A);
    expect((await create(agent, tpl)).status).toBe(403);
    expect((await listB(api("GET", "/api/broadcasts", agent.cookie))).status).toBe(403);
    expect((await preview(agent)).status).toBe(403);
    const id = (await body(await create(A, tpl))).id as string;
    expect((await detail(B, id)).status).toBe(404);
    expect((await act(B, id, "cancel")).status).toBe(404);
    expect((await create(B, tpl)).status).toBe(400);
    expect((await post(createB, "/api/broadcasts", A, { name: "x", templateId: tpl, params: [{ kind: "nombre" }], audience: {} }, "https://otro.example")).status).toBe(403);
    expect((await createB(api("POST", "/api/broadcasts", undefined, {}))).status).toBe(401);
  });
});

describe("difusiones: envío", () => {
  it("envía solo a quien corresponde, con el nombre en la plantilla, y deja el mensaje en la conversación", async () => {
    sent = [];
    const t = await register("envio");
    await person(t, "584120000001", "Ana López");
    await person(t, "584120000002", null);
    await person(t, "584120000003", "Sin permiso", { consent: false });
    const id = (await body(await create(t, await template(t)))).id as string;
    expect((await act(t, id, "start")).status).toBe(400); // falta confirmar el permiso
    expect((await start(t, id)).status).toBe(200);
    expect((await start(t, id)).status).toBe(409); // ya empezó
    const calls: { to: string; params: string[] }[] = [];
    const r = await runAll(t, id, { sendTemplate: (async (_p: string, _t: string, to: string, tpl: { params: string[] }) => { calls.push({ to, params: tpl.params }); return { kind: "sent", waMessageId: `wamid.T.${randomUUID()}` }; }) as never });
    expect(r.state).toBe("terminada");
    expect(calls.sort((a, b) => a.to.localeCompare(b.to))).toEqual([{ to: "584120000001", params: ["Ana"] }, { to: "584120000002", params: ["cliente"] }]);
    expect((await recipients(t, id)).map((x) => x.status)).toEqual(["enviado", "enviado"]);
    const msgs = (await oq(t, "SELECT msg_type, body, send_state FROM messages WHERE tenant_id = $1 AND direction = 'out' ORDER BY body", [t.tenantId])).rows;
    expect(msgs).toHaveLength(2);
    expect(msgs[0]).toMatchObject({ msg_type: "template", send_state: "sent", body: expect.stringContaining("Hola Ana, esta semana 20%") });
    expect((await oq(t, "SELECT count(*)::int AS n FROM conversations WHERE tenant_id = $1", [t.tenantId])).rows[0].n).toBe(2);
    const d = await body(await detail(t, id));
    expect(d.broadcast.status).toBe("terminada");
    expect(d.stats).toMatchObject({ total: 2, sent: 2, failed: 0, pending: 0 });
  });

  it("no repite el envío si se llama dos veces, y vuelve a revisar permiso y baja al enviar", async () => {
    sent = [];
    const t = await register("reen");
    const a = await person(t, "584120000001", "Ana"); await person(t, "584120000002", "Luis");
    const id = (await body(await create(t, await template(t)))).id as string;
    await start(t, id);
    // Entre iniciar y enviar, Ana pide la baja.
    await oq(t, "UPDATE contacts SET notifications_off = true WHERE id = $1", [a]);
    const rec = (await oq(t, "SELECT id FROM broadcast_recipients WHERE broadcast_id = $1 AND contact_id <> $2", [id, a])).rows[0].id as string;
    expect(await sendRecipient(t.tenantId, rec, deps)).toBe("sent");
    expect(await sendRecipient(t.tenantId, rec, deps)).toBe("skipped");
    await runAll(t, id);
    expect(sent).toEqual(["584120000002"]);
    expect((await recipients(t, id)).find((x) => x.wa_id === "584120000001")).toMatchObject({ status: "omitido", reason: "baja" });
  });

  it("si la conversación pasó a una persona o la plantilla dejó de estar aprobada, no se envía", async () => {
    sent = [];
    const t = await register("cambio");
    const a = await person(t, "584120000001", "Ana"); await person(t, "584120000002", "Luis");
    const tpl = await template(t);
    const id = (await body(await create(t, tpl))).id as string;
    await start(t, id);
    await oq(t, "INSERT INTO conversations (tenant_id, contact_id, status) VALUES ($1, $2, 'human')", [t.tenantId, a]);
    await runAll(t, id);
    expect((await recipients(t, id)).find((x) => x.wa_id === "584120000001")).toMatchObject({ status: "omitido", reason: "con_persona" });
    const id2 = (await body(await create(t, tpl))).id as string;
    expect((await start(t, id2)).status).toBe(409); // Luis ya la recibió hace poco, y Ana está con una persona
    const t2 = await register("cambio2");
    await person(t2, "584120000009", "Zoe");
    const tpl2 = await template(t2);
    const id3 = (await body(await create(t2, tpl2))).id as string;
    await start(t2, id3);
    await oq(t2, "UPDATE whatsapp_templates SET status = 'PAUSED' WHERE id = $1", [tpl2]);
    await runAll(t2, id3);
    expect((await recipients(t2, id3))[0]).toMatchObject({ status: "fallido" });
    expect((await recipients(t2, id3))[0]!.reason).toMatch(/plantilla_no_disponible/);
  });

  it("no le escribe dos veces a la misma persona en pocos días", async () => {
    sent = [];
    const t = await register("reciente");
    await person(t, "584120000001", "Ana");
    const tpl = await template(t);
    const a = (await body(await create(t, tpl))).id as string;
    await start(t, a); await runAll(t, a);
    const p = await body(await preview(t));
    expect(p.eligible).toBe(0);
    expect(p.excluded.reciente).toBe(1);
    const b = (await body(await create(t, tpl))).id as string;
    expect((await start(t, b)).status).toBe(409);
  });

  it("pausar, reanudar y cancelar; lo que ya empezó no se modifica", async () => {
    sent = [];
    const t = await register("estados");
    await person(t, "584120000001", "Ana"); await person(t, "584120000002", "Luis");
    const id = (await body(await create(t, await template(t)))).id as string;
    expect((await act(t, id, "pause")).status).toBe(409);
    await start(t, id);
    expect((await act(t, id, "pause")).status).toBe(200);
    await processBroadcast(t.tenantId, id, deps);
    expect(sent).toEqual([]);
    expect((await act(t, id, "resume")).status).toBe(200);
    const bad = await oq(t, "UPDATE broadcasts SET template_text = 'otro texto' WHERE id = $1", [id]).then(() => null, (e: { code?: string }) => e.code);
    expect(bad).toBe("23514");
    expect((await act(t, id, "cancel")).status).toBe(200);
    expect((await recipients(t, id)).every((x) => x.status === "omitido" && x.reason === "cancelada")).toBe(true);
    expect((await act(t, id, "cancel")).status).toBe(409);
    expect((await act(t, id, "delete")).status).toBe(409);
    await runAll(t, id);
    expect(sent).toEqual([]);
    const draft = (await body(await create(t, await template(t)))).id as string;
    expect((await act(t, draft, "delete")).status).toBe(200);
    expect((await detail(t, draft)).status).toBe(404);
  });

  it("respeta el tope diario del negocio", async () => {
    sent = [];
    const t = await register("tope");
    await person(t, "584120000001", "Ana");
    const id = (await body(await create(t, await template(t)))).id as string;
    await start(t, id);
    const b2 = (await oq(t, "INSERT INTO broadcasts (tenant_id, name, template_name, template_language, template_text, status, total) VALUES ($1,'viejo','x','es','Hola BAJA','terminada',$2) RETURNING id", [t.tenantId, DAILY_CAP])).rows[0].id as string;
    // Se simula el consumo del día con contactos distintos (uno por mensaje).
    await oq(t, 
      `INSERT INTO contacts (tenant_id, wa_id, display_name) SELECT $1, '5849' || lpad(g::text, 8, '0'), 'c' || g FROM generate_series(1, $2) g`, [t.tenantId, DAILY_CAP]);
    await oq(t, 
      `INSERT INTO broadcast_recipients (tenant_id, broadcast_id, contact_id, status, sent_at)
       SELECT $1, $2, c.id, 'enviado', now() FROM contacts c WHERE c.tenant_id = $1 AND c.wa_id LIKE '5849%'`, [t.tenantId, b2]);
    await processBroadcast(t.tenantId, id, deps);
    expect(sent).toEqual([]);
    expect((await recipients(t, id))[0]!.status).toBe("pendiente");
    await oq(t, "UPDATE broadcast_recipients SET sent_at = now() - interval '25 hours' WHERE broadcast_id = $1", [b2]);
    await runAll(t, id);
    expect(sent).toEqual(["584120000001"]);
  });
});

describe("difusiones: fallos y calidad", () => {
  it("reintenta si no hubo conexión, y registra el rechazo de Meta sin reintentar", async () => {
    const t = await register("fallos");
    await person(t, "584120000001", "Ana"); await person(t, "584120000002", "Luis");
    const id = (await body(await create(t, await template(t)))).id as string;
    await start(t, id);
    let n = 0;
    const flaky = (async (_p: string, _t: string, to: string): Promise<SendResult> => {
      if (to === "584120000001") { n++; return n === 1 ? { kind: "retry", reason: "sin red" } : { kind: "sent", waMessageId: `wamid.T.${randomUUID()}` }; }
      return { kind: "rejected", status: 400, code: 131026, message: "no está en WhatsApp" };
    }) as never;
    await processBroadcast(t.tenantId, id, { sendTemplate: flaky });
    let rs = await recipients(t, id);
    expect(rs.find((x) => x.wa_id === "584120000001")!.status).toBe("pendiente"); // reprogramado
    expect(rs.find((x) => x.wa_id === "584120000002")).toMatchObject({ status: "fallido" });
    expect(rs.find((x) => x.wa_id === "584120000002")!.reason).toMatch(/131026/);
    await oq(t, "UPDATE broadcast_recipients SET next_at = now() WHERE broadcast_id = $1", [id]);
    await runAll(t, id, { sendTemplate: flaky });
    rs = await recipients(t, id);
    expect(rs.find((x) => x.wa_id === "584120000001")!.status).toBe("enviado");
    expect(n).toBe(2);
  });

  it("si no se sabe si salió, no se reenvía", async () => {
    const t = await register("incierto");
    await person(t, "584120000001", "Ana");
    const id = (await body(await create(t, await template(t)))).id as string;
    await start(t, id);
    await runAll(t, id, { sendTemplate: (async () => ({ kind: "unknown", reason: "tiempo agotado" })) as never });
    expect((await recipients(t, id))[0]).toMatchObject({ status: "fallido" });
    expect((await recipients(t, id))[0]!.reason).toMatch(/incierto/);
    expect((await oq(t, "SELECT send_state FROM messages WHERE tenant_id = $1 AND direction = 'out'", [t.tenantId])).rows[0].send_state).toBe("unknown");
  });

  it("se pausa sola cuando fallan la mitad de los últimos envíos", async () => {
    const t = await register("calidad");
    await oq(t, `INSERT INTO contacts (tenant_id, wa_id, display_name, promo_consent_at, promo_consent_source) SELECT $1, '5841' || lpad(g::text, 8, '0'), 'c' || g, now(), 'tienda' FROM generate_series(1, 30) g`, [t.tenantId]);
    const id = (await body(await create(t, await template(t)))).id as string;
    expect((await start(t, id)).status).toBe(200);
    const bad = (async (): Promise<SendResult> => ({ kind: "rejected", status: 400, code: 131026, message: "no válido" })) as never;
    const r = await processBroadcast(t.tenantId, id, { sendTemplate: bad });
    expect(r.state).toBe("pausada");
    const d = await body(await detail(t, id));
    expect(d.broadcast.status).toBe("pausada");
    expect(d.broadcast.pauseReason).toMatch(/Se pausó sola/);
    expect(d.stats.pending).toBeGreaterThan(0);
    await processBroadcast(t.tenantId, id, deps);
    expect(d.stats.pending).toBe((await body(await detail(t, id))).stats.pending);
  });
});

describe("difusiones: resultados y reenvío", () => {
  it("cuenta entregados, leídos y respondieron, y permite reenviar a quienes no la leyeron", async () => {
    sent = [];
    const t = await register("result");
    for (let i = 1; i <= 4; i++) await person(t, `58412000000${i}`, `Cliente ${i}`);
    const tpl = await template(t);
    const id = (await body(await create(t, tpl))).id as string;
    await start(t, id); await runAll(t, id);
    expect(sent).toHaveLength(4);
    // Estados que llegarían por el webhook de Meta: 1 leído, 2 entregado, 3 falló la entrega, 4 sin estado. El cliente 1 responde.
    const st = async (wa: string, s: string | null) => oq(t, "UPDATE messages SET delivery_status = $2 WHERE id = (SELECT r.message_id FROM broadcast_recipients r JOIN contacts c ON c.id = r.contact_id WHERE r.broadcast_id = $3 AND c.wa_id = $1)", [wa, s, id]);
    await st("584120000001", "read"); await st("584120000002", "delivered"); await st("584120000003", "failed");
    await oq(t, "UPDATE broadcast_recipients SET sent_at = now() - interval '1 hour' WHERE broadcast_id = $1", [id]);
    const conv = (await oq(t, "SELECT m.conversation_id AS c FROM broadcast_recipients r JOIN messages m ON m.id = r.message_id JOIN contacts c ON c.id = r.contact_id WHERE r.broadcast_id = $1 AND c.wa_id = '584120000001'", [id])).rows[0].c;
    await oq(t, "INSERT INTO messages (tenant_id, conversation_id, direction, msg_type, body) VALUES ($1, $2, 'in', 'text', 'Quiero comprar')", [t.tenantId, conv]);
    const d = await body(await detail(t, id));
    expect(d.stats).toMatchObject({ total: 4, sent: 4, delivered: 2, read: 1, not_delivered: 1, replied: 1, failed: 0 });
    // Reenviar a quienes no la leyeron: 2, 3 y 4. Se salta la regla de «recibió otra difusión hace poco» solo para la de origen.
    const p = await body(await preview(t, { from: { broadcastId: id, who: "no_leyeron" } }));
    expect(p).toMatchObject({ matched: 3 });
    const q = await body(await preview(t, { from: { broadcastId: id, who: "no_respondieron" } }));
    expect(q.matched).toBe(3);
    expect(p.eligible).toBe(3);
    sent = [];
    const id2 = (await body(await create(t, tpl, { audience: { from: { broadcastId: id, who: "no_leyeron" } } }))).id as string;
    expect((await start(t, id2)).status).toBe(200);
    await runAll(t, id2);
    expect(sent.sort()).toEqual(["584120000002", "584120000003", "584120000004"]);
    expect((await create(t, tpl, { audience: { from: { broadcastId: randomUUID(), who: "no_leyeron" } } })).status).toBe(400);
  });

  it("cada difusión queda en el registro y la lista de personas muestra los fallos primero", async () => {
    const t = await register("registro");
    await person(t, "584120000001", "Ana"); await person(t, "584120000002", "Luis");
    const id = (await body(await create(t, await template(t)))).id as string;
    await start(t, id);
    await runAll(t, id, { sendTemplate: (async (_p: string, _t: string, to: string): Promise<SendResult> => to === "584120000002" ? { kind: "rejected", status: 400, code: 1, message: "x" } : { kind: "sent", waMessageId: `wamid.T.${randomUUID()}` }) as never });
    const d = await body(await detail(t, id));
    expect(d.people[0]).toMatchObject({ name: "Luis", status: "fallido" });
    const log = (await oq(t, "SELECT action FROM audit_log WHERE tenant_id = $1 AND action LIKE 'broadcast.%' ORDER BY created_at", [t.tenantId])).rows.map((r) => r.action);
    expect(log).toEqual(["broadcast.created", "broadcast.started"]);
  });
});
