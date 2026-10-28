import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { POST as signup } from "@/app/api/auth/signup/route";
import { GET as listTpl, POST as createTpl } from "@/app/api/whatsapp/templates/route";
import { POST as syncTpl } from "@/app/api/whatsapp/templates/sync/route";
import { POST as deleteTpl } from "@/app/api/whatsapp/templates/delete/route";
import { POST as setWaba } from "@/app/api/whatsapp/waba/route";
import { POST as sendTpl } from "@/app/api/conversations/template/route";
import { POST as reply } from "@/app/api/conversations/reply/route";
import { POST as updateConversation } from "@/app/api/conversations/update/route";
import { GET as me } from "@/app/api/me/route";
import { encryptSecret } from "@/lib/crypto";
import { getPool, withTenant } from "@/lib/db";
import { closeLockClient } from "@/lib/queue/lock";
import { ingestBatch } from "@/lib/whatsapp/ingest";
import type { SendResult } from "@/lib/whatsapp/graph";
import { bodyError, cleanParam, createMetaTemplate, explainTemplateError, listMetaTemplates, parseRemote, renderBody, sendTemplate, suggestName, variablesOf, wabaOwnsPhone } from "@/lib/whatsapp/templates";
import { sendTemplate as sendTemplateFn } from "@/lib/whatsapp/templates";

vi.mock("@/lib/whatsapp/templates", async (orig) => ({ ...(await orig<typeof import("@/lib/whatsapp/templates")>()), sendTemplate: vi.fn() }));
// Para las pruebas de la función real de envío se usa la original.
const realSend = (await vi.importActual<typeof import("@/lib/whatsapp/templates")>("@/lib/whatsapp/templates")).sendTemplate;
const sendMock = vi.mocked(sendTemplateFn);
const OK: SendResult = { kind: "sent", waMessageId: "wamid.PLANTILLA.1" };

process.env.WHATSAPP_APP_SECRET = "secreto-de-prueba-de-la-app-meta";
process.env.WHATSAPP_VERIFY_TOKEN = "token-de-verificacion-de-prueba-123456";

const RUN = randomUUID().slice(0, 8);
process.env.QUEUE_PREFIX = `test-t-${RUN}`;
const ORIGIN = new URL(process.env.APP_URL!).origin;
const PASSWORD = "contraseña-de-prueba-123";
const TOKEN = "EAAtoken-de-prueba-del-negocio-1234567890";
const owner = new Pool({ connectionString: process.env.MIGRATION_DATABASE_URL, max: 2 });
const tenantIds: string[] = [];
let seq = 0;
const newPhoneId = () => `6${RUN.replace(/\D/g, "").padEnd(4, "5").slice(0, 4)}${Date.now() % 100000}${seq++}`.slice(0, 18);
const newWaId = () => `58412${String(Date.now()).slice(-6)}${seq++}`.slice(0, 15);
const WABA = "123456789012345";

function api(method: string, path: string, cookie?: string, body?: unknown) {
  return new Request(`${ORIGIN}${path}`, {
    method,
    headers: { origin: ORIGIN, ...(body !== undefined ? { "content-type": "application/json" } : {}), ...(cookie ? { cookie } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}
async function register(name: string) {
  const email = `tp-${RUN}-${name}@example.test`;
  const res = await signup(api("POST", "/api/auth/signup", undefined, { email, password: PASSWORD, businessName: `Negocio ${name}` }));
  expect(res.status).toBe(201);
  const cookie = (res.headers.get("set-cookie") ?? "").split(";")[0]!;
  const info = await (await me(api("GET", "/api/me", cookie))).json();
  const tenantId = info.tenant.id as string;
  tenantIds.push(tenantId);
  const phoneId = newPhoneId();
  const { payload, keyVersion } = encryptSecret(TOKEN, `wa:${tenantId}:${phoneId}`);
  await owner.query("INSERT INTO tenant_integrations (tenant_id, provider, external_id, secret_enc, key_version) VALUES ($1,'whatsapp',$2,$3,$4)", [tenantId, phoneId, payload, keyVersion]);
  return { tenantId, phoneId, cookie };
}
type T = Awaited<ReturnType<typeof register>>;
let t0 = Math.floor(Date.now() / 1000) - 3600;
async function customer(t: T) {
  const waId = newWaId();
  await ingestBatch({ phoneNumberId: t.phoneId, statuses: [], messages: [{ waId, name: "Cliente", waMessageId: `wamid.${RUN}.${seq++}`, at: new Date(++t0 * 1000), type: "text", body: "hola" }] });
  const row = await withTenant(t.tenantId, async (db) => (await db.query("SELECT c.id AS conv FROM conversations c JOIN contacts ct ON ct.id = c.contact_id AND ct.tenant_id = c.tenant_id WHERE ct.wa_id = $1", [waId])).rows[0]);
  return { waId, conv: row.conv as string };
}
const ownerExec = async (tenantId: string, sql: string, params: unknown[] = []) => {
  const c = await owner.connect();
  try {
    await c.query("BEGIN");
    await c.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
    const r = await c.query(sql, params);
    await c.query("COMMIT");
    return r;
  } catch (e) {
    await c.query("ROLLBACK");
    throw e;
  } finally {
    c.release();
  }
};
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const BODY = "Hola {{1}}, tu cita es el {{2}}. ¡Te esperamos!";

beforeAll(async () => { await getPool().query("SELECT 1"); });
afterEach(() => vi.unstubAllGlobals());
afterAll(async () => {
  await closeLockClient();
  await owner.query("DELETE FROM users WHERE email LIKE $1", [`tp-${RUN}-%`]);
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

describe("reglas de las plantillas (puras)", () => {
  it("sugiere un nombre válido para Meta", () => {
    expect(suggestName("Recordatorio de Cita ¡Hoy!")).toBe("recordatorio_de_cita_hoy");
    expect(suggestName("   ")).toBe("");
  });
  it("cuenta las variables y valida el cuerpo", () => {
    expect(variablesOf(BODY)).toEqual([1, 2]);
    expect(bodyError(BODY, ["Ana", "viernes"])).toBeNull();
    expect(bodyError("Hola, gracias por escribir.", [])).toBeNull();
    expect(bodyError("{{1}} te saluda", ["Ana"])).toMatch(/empezar/);
    expect(bodyError("Hola {{1}}", ["Ana"])).toMatch(/terminar/);
    expect(bodyError("Hola {{1}} y {{3}} ok", ["a", "b"])).toMatch(/orden/);
    expect(bodyError("Hola {{1}} {{2}} ok", ["a", "b"])).toMatch(/pegadas/);
    expect(bodyError("Hola {nombre} ok", [])).toMatch(/llaves/);
    expect(bodyError(BODY, ["Ana"])).toMatch(/ejemplo/);
    expect(bodyError(BODY, ["Ana", ""])).toMatch(/ejemplo/);
    expect(bodyError("x".repeat(1025), [])).toMatch(/largo/);
    expect(bodyError("   ", [])).toMatch(/Escribe/);
  });
  it("arma el texto final y limpia los datos", () => {
    expect(renderBody(BODY, ["Ana", "viernes"])).toBe("Hola Ana, tu cita es el viernes. ¡Te esperamos!");
    expect(cleanParam("  Ana \n\n  María\t")).toBe("Ana María");
  });
  it("interpreta lo que devuelve Meta y marca cuáles se pueden enviar", () => {
    const base = { id: "1", name: "cita", language: "es", category: "UTILITY", status: "APPROVED", components: [{ type: "BODY", text: BODY, example: { body_text: [["Ana", "hoy"]] } }] };
    expect(parseRemote(base)).toMatchObject({ name: "cita", status: "APPROVED", sendable: true, examples: ["Ana", "hoy"] });
    expect(parseRemote({ ...base, components: [{ type: "HEADER", format: "IMAGE" }, ...base.components] })!.sendable).toBe(false);
    expect(parseRemote({ ...base, components: [...base.components, { type: "BUTTONS", buttons: [{ url: "https://x.test/{{1}}" }] }] })!.sendable).toBe(false);
    expect(parseRemote({ ...base, components: [...base.components, { type: "BUTTONS", buttons: [{ url: "https://x.test/" }] }] })!.sendable).toBe(true);
    expect(parseRemote({ ...base, category: "AUTHENTICATION" })!.sendable).toBe(false);
    expect(parseRemote({ ...base, status: "RARO" })!.status).toBe("OTHER");
    expect(parseRemote({ ...base, status: "REJECTED", rejected_reason: "INVALID_FORMAT" })!.reason).toBe("INVALID_FORMAT");
    expect(parseRemote({ ...base, name: "Mala Plantilla" })).toBeNull();
    expect(parseRemote({ ...base, components: [] })).toBeNull();
  });
  it("explica los errores de Meta", () => {
    expect(explainTemplateError({ status: 400, code: 190, message: "x" })).toMatch(/token/);
    expect(explainTemplateError({ status: 400, code: 2388023, message: "x" })).toMatch(/Ya existe/);
    expect(explainTemplateError(null, "sin red")).toBe("sin red");
  });
});

describe("llamadas a Meta (con red simulada)", () => {
  it("crea la plantilla con el cuerpo y los ejemplos", async () => {
    const f = vi.fn(async () => json(200, { id: "555", status: "PENDING", category: "UTILITY" })) as unknown as typeof fetch;
    const r = await createMetaTemplate(WABA, TOKEN, { name: "cita", language: "es", category: "UTILITY", body: BODY, examples: ["Ana", "hoy"] }, f);
    expect(r).toEqual({ ok: true, data: { id: "555", status: "PENDING" } });
    const [url, init] = vi.mocked(f).mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain(`/${WABA}/message_templates`);
    expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${TOKEN}`);
    expect(JSON.parse(String(init.body))).toMatchObject({ name: "cita", language: "es", category: "UTILITY", components: [{ type: "BODY", text: BODY, example: { body_text: [["Ana", "hoy"]] } }] });
  });
  it("devuelve el error de Meta tal cual y distingue la falta de red", async () => {
    const bad = vi.fn(async () => json(400, { error: { code: 2388023, message: "dup" } })) as unknown as typeof fetch;
    expect(await createMetaTemplate(WABA, TOKEN, { name: "a", language: "es", category: "UTILITY", body: "Hola a todos", examples: [] }, bad)).toMatchObject({ ok: false, error: { code: 2388023 } });
    const down = vi.fn(async () => { throw new Error("red"); }) as unknown as typeof fetch;
    expect(await listMetaTemplates(WABA, TOKEN, down)).toMatchObject({ ok: false, error: null });
  });
  it("lista varias páginas y NO sigue enlaces que no sean de Meta (el token viaja en la petición)", async () => {
    const t = (n: string) => ({ id: n, name: n, language: "es", category: "UTILITY", status: "APPROVED", components: [{ type: "BODY", text: "Hola a todos" }] });
    const f = vi.fn()
      .mockResolvedValueOnce(json(200, { data: [t("uno")], paging: { next: "https://graph.facebook.com/v1/next" } }))
      .mockResolvedValueOnce(json(200, { data: [t("dos")], paging: { next: "https://evil.test/steal" } }));
    const r = await listMetaTemplates(WABA, TOKEN, f as unknown as typeof fetch);
    expect(r.ok && r.data.map((x) => x.name)).toEqual(["uno", "dos"]);
    expect(f).toHaveBeenCalledTimes(2);
  });
  it("comprueba que el número pertenece a la cuenta", async () => {
    const f = vi.fn(async () => json(200, { data: [{ id: "111" }, { id: "222" }] })) as unknown as typeof fetch;
    expect(await wabaOwnsPhone(WABA, "222", TOKEN, f)).toEqual({ ok: true, data: true });
    expect(await wabaOwnsPhone(WABA, "999", TOKEN, f)).toEqual({ ok: true, data: false });
  });
  it("envía la plantilla con los datos en el cuerpo y clasifica los resultados", async () => {
    const f = vi.fn(async () => json(200, { messages: [{ id: "wamid.ABC123" }] })) as unknown as typeof fetch;
    expect(await realSend("12345", TOKEN, "584121234567", { name: "cita", language: "es", params: ["Ana\nPérez", "viernes"] }, f)).toEqual({ kind: "sent", waMessageId: "wamid.ABC123" });
    const sent = JSON.parse(String(vi.mocked(f).mock.calls[0]![1]!.body));
    expect(sent).toMatchObject({ type: "template", to: "584121234567", template: { name: "cita", language: { code: "es" }, components: [{ type: "body", parameters: [{ type: "text", text: "Ana Pérez" }, { type: "text", text: "viernes" }] }] } });
    const rej = vi.fn(async () => json(400, { error: { code: 132001, message: "no existe" } })) as unknown as typeof fetch;
    expect(await realSend("12345", TOKEN, "584121234567", { name: "cita", language: "es", params: [] }, rej)).toMatchObject({ kind: "rejected", code: 132001 });
    const lim = vi.fn(async () => json(429, {})) as unknown as typeof fetch;
    expect(await realSend("12345", TOKEN, "584121234567", { name: "cita", language: "es", params: [] }, lim)).toMatchObject({ kind: "retry" });
    const err = vi.fn(async () => json(500, {})) as unknown as typeof fetch;
    expect(await realSend("12345", TOKEN, "584121234567", { name: "cita", language: "es", params: [] }, err)).toMatchObject({ kind: "unknown" });
    expect(await realSend("12345", TOKEN, "5841", { name: "cita", language: "es", params: [] }, f)).toMatchObject({ kind: "rejected" });
  });
  it("sendTemplate exportada existe (la simulada de las rutas la reemplaza)", () => expect(typeof sendTemplate).toBe("function"));
});

describe("rutas", () => {
  it("enlazar la cuenta WABA: se comprueba con Meta que contenga el número", async () => {
    const t = await register("waba");
    const phones = [{ id: t.phoneId }];
    vi.stubGlobal("fetch", vi.fn(async () => json(200, { data: phones })));
    const bad = await setWaba(api("POST", "/api/whatsapp/waba", t.cookie, { wabaId: "abc" }));
    expect(bad.status).toBe(400);
    vi.stubGlobal("fetch", vi.fn(async () => json(200, { data: [{ id: "otro" }] })));
    expect((await setWaba(api("POST", "/api/whatsapp/waba", t.cookie, { wabaId: WABA }))).status).toBe(400);
    vi.stubGlobal("fetch", vi.fn(async () => json(200, { data: phones })));
    expect((await setWaba(api("POST", "/api/whatsapp/waba", t.cookie, { wabaId: WABA }))).status).toBe(200);
    const row = await owner.query("SELECT waba_id FROM tenant_integrations WHERE tenant_id = $1", [t.tenantId]);
    expect(row.rows[0].waba_id).toBe(WABA);
  });

  it("sin cuenta WABA no se puede crear; con ella se crea, aparece «en revisión» y se sincroniza el estado", async () => {
    const t = await register("crear");
    const payload = { name: "recordatorio", language: "es", category: "UTILITY", body: BODY, examples: ["Ana", "viernes"] };
    expect((await createTpl(api("POST", "/api/whatsapp/templates", t.cookie, payload))).status).toBe(409);
    await ownerExec(t.tenantId, "UPDATE tenant_integrations SET waba_id = $2 WHERE tenant_id = $1", [t.tenantId, WABA]);

    expect((await createTpl(api("POST", "/api/whatsapp/templates", t.cookie, { ...payload, examples: ["Ana"] }))).status).toBe(400); // falta un ejemplo
    expect((await createTpl(api("POST", "/api/whatsapp/templates", t.cookie, { ...payload, name: "Mal Nombre" }))).status).toBe(400);

    vi.stubGlobal("fetch", vi.fn(async () => json(200, { id: "777", status: "PENDING" })));
    expect((await createTpl(api("POST", "/api/whatsapp/templates", t.cookie, payload))).status).toBe(201);
    expect((await createTpl(api("POST", "/api/whatsapp/templates", t.cookie, payload))).status).toBe(409); // duplicada

    const list = await (await listTpl(api("GET", "/api/whatsapp/templates", t.cookie))).json();
    expect(list.templates).toHaveLength(1);
    expect(list.templates[0]).toMatchObject({ name: "recordatorio", status: "PENDING", variables: 2 });

    // Meta la aprueba y además hay otra creada en su panel; la local desaparece si Meta ya no la tiene.
    const remote = (n: string, status: string) => ({ id: n, name: n, language: "es", category: "UTILITY", status, components: [{ type: "BODY", text: BODY, example: { body_text: [["Ana", "hoy"]] } }] });
    vi.stubGlobal("fetch", vi.fn(async () => json(200, { data: [remote("recordatorio", "APPROVED"), remote("otra", "APPROVED")] })));
    expect(await (await syncTpl(api("POST", "/api/whatsapp/templates/sync", t.cookie, {}))).json()).toMatchObject({ total: 2, removed: 0 });
    let after = (await (await listTpl(api("GET", "/api/whatsapp/templates", t.cookie))).json()).templates;
    expect(after.map((x: { name: string; status: string }) => `${x.name}:${x.status}`)).toEqual(["otra:APPROVED", "recordatorio:APPROVED"]);
    vi.stubGlobal("fetch", vi.fn(async () => json(200, { data: [remote("otra", "APPROVED")] })));
    expect(await (await syncTpl(api("POST", "/api/whatsapp/templates/sync", t.cookie, {}))).json()).toMatchObject({ total: 1, removed: 1 });

    // borrar
    after = (await (await listTpl(api("GET", "/api/whatsapp/templates", t.cookie))).json()).templates;
    vi.stubGlobal("fetch", vi.fn(async () => json(200, { success: true })));
    expect((await deleteTpl(api("POST", "/api/whatsapp/templates/delete", t.cookie, { id: after[0].id }))).status).toBe(200);
    expect((await (await listTpl(api("GET", "/api/whatsapp/templates", t.cookie))).json()).templates).toHaveLength(0);
  });

  it("el rechazo de Meta al crear se explica y no deja la plantilla guardada", async () => {
    const t = await register("rechazo");
    await ownerExec(t.tenantId, "UPDATE tenant_integrations SET waba_id = $2 WHERE tenant_id = $1", [t.tenantId, WABA]);
    vi.stubGlobal("fetch", vi.fn(async () => json(400, { error: { code: 2388023, message: "dup" } })));
    const r = await createTpl(api("POST", "/api/whatsapp/templates", t.cookie, { name: "dup", language: "es", category: "UTILITY", body: "Hola a todos", examples: [] }));
    expect(r.status).toBe(400);
    expect((await r.json()).message).toMatch(/Ya existe/);
    expect((await (await listTpl(api("GET", "/api/whatsapp/templates", t.cookie))).json()).templates).toHaveLength(0);
  });

  it("aislamiento: otro negocio no ve ni borra mis plantillas", async () => {
    const a = await register("iso-a");
    const b = await register("iso-b");
    await ownerExec(a.tenantId, "INSERT INTO whatsapp_templates (tenant_id, name, language, category, body, status) VALUES ($1,'privada','es','UTILITY','Hola a todos','APPROVED')", [a.tenantId]);
    expect((await (await listTpl(api("GET", "/api/whatsapp/templates", b.cookie))).json()).templates).toHaveLength(0);
    const id = (await ownerExec(a.tenantId, "SELECT id FROM whatsapp_templates WHERE tenant_id = $1", [a.tenantId])).rows[0].id;
    expect((await deleteTpl(api("POST", "/api/whatsapp/templates/delete", b.cookie, { id }))).status).toBe(404);
  });

  describe("enviar desde la bandeja", () => {
    async function ready(name: string, status = "APPROVED", sendable = true) {
      const t = await register(name);
      const c = await customer(t);
      expect((await updateConversation(api("POST", "/api/conversations/update", t.cookie, { id: c.conv, action: "take" }))).status).toBe(200);
      const id = (await ownerExec(t.tenantId, "INSERT INTO whatsapp_templates (tenant_id, name, language, category, body, status, sendable) VALUES ($1,'cita','es','UTILITY',$2,$3,$4) RETURNING id", [t.tenantId, BODY, status, sendable])).rows[0].id as string;
      sendMock.mockReset();
      sendMock.mockResolvedValue(OK);
      return { t, c, id };
    }
    const post = (t: T, conv: string, templateId: string, params: string[], key: string = randomUUID()) => sendTpl(api("POST", "/api/conversations/template", t.cookie, { id: conv, clientKey: key, templateId, params }));

    it("pasadas las 24 h el texto libre se rechaza pero la plantilla sale, y queda guardada como plantilla", async () => {
      const { t, c, id } = await ready("p1");
      await ownerExec(t.tenantId, "UPDATE messages SET created_at = now() - interval '30 hours' WHERE conversation_id = $1 AND direction = 'in'", [c.conv]);
      const free = await reply(api("POST", "/api/conversations/reply", t.cookie, { id: c.conv, clientKey: randomUUID(), text: "hola" }));
      expect((await free.json()).error).toBe("ventana_cerrada");
      const key = randomUUID();
      const res = await post(t, c.conv, id, ["Ana", "viernes"], key);
      expect(res.status).toBe(200);
      expect(sendMock).toHaveBeenCalledWith(t.phoneId, TOKEN, c.waId, { name: "cita", language: "es", params: ["Ana", "viernes"] });
      const rows = await withTenant(t.tenantId, async (db) => (await db.query("SELECT msg_type, body, send_state FROM messages WHERE conversation_id = $1 AND direction = 'out'", [c.conv])).rows);
      expect(rows).toEqual([{ msg_type: "template", body: "Hola Ana, tu cita es el viernes. ¡Te esperamos!", send_state: "sent" }]);
      // el mismo intento no envía dos veces
      const again = await (await post(t, c.conv, id, ["Ana", "viernes"], key)).json();
      expect(again.duplicate).toBe(true);
      expect(sendMock).toHaveBeenCalledTimes(1);
    });

    it("exige plantilla aprobada, de texto, con todos los datos y con la conversación tomada", async () => {
      const pend = await ready("p2", "PENDING");
      expect((await (await post(pend.t, pend.c.conv, pend.id, ["a", "b"])).json()).error).toBe("plantilla_no_aprobada");
      const comp = await ready("p3", "APPROVED", false);
      expect((await (await post(comp.t, comp.c.conv, comp.id, ["a", "b"])).json()).error).toBe("plantilla_no_soportada");
      const ok = await ready("p4");
      expect((await post(ok.t, ok.c.conv, ok.id, ["solo uno"])).status).toBe(400);
      expect((await post(ok.t, ok.c.conv, ok.id, ["a", "  "])).status).toBe(400);
      expect((await post(ok.t, ok.c.conv, randomUUID(), ["a", "b"])).status).toBe(404);
      await ownerExec(ok.t.tenantId, "UPDATE conversations SET status = 'bot', assigned_to = NULL WHERE id = $1", [ok.c.conv]);
      expect((await (await post(ok.t, ok.c.conv, ok.id, ["a", "b"])).json()).error).toBe("no_tomada");
      expect(sendMock).not.toHaveBeenCalled();
    });

    it("si Meta rechaza la plantilla, el mensaje queda fallido con una explicación", async () => {
      const { t, c, id } = await ready("p5");
      sendMock.mockResolvedValue({ kind: "rejected", status: 400, code: 132015, message: "paused" });
      const res = await post(t, c.conv, id, ["Ana", "hoy"]);
      expect(res.status).toBe(502);
      expect((await res.json()).message).toMatch(/pausó/);
    });
  });
});
