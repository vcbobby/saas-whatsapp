import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { POST as signup } from "@/app/api/auth/signup/route";
import { GET as me } from "@/app/api/me/route";
import { GET as listHooks, POST as createHook } from "@/app/api/webhooks/route";
import { POST as createRule } from "@/app/api/automations/route";
import { APPS, checkAppUrl } from "@/lib/connections/apps";
import { formatEventText } from "@/lib/connections/format";
import { buildAppRequest, openConfig } from "@/lib/connections/request";
import { findTelegramChats } from "@/lib/connections/telegram";
import { POST as updateHook } from "@/app/api/webhooks/update/route";
import { deliverOne } from "@/lib/webhooks/deliver";
import { getPool, withTenant } from "@/lib/db";

vi.mock("node:dns/promises", () => ({ lookup: async () => [{ address: "8.8.8.8", family: 4 }] }));

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
  const email = `cx-${RUN}-${name}@example.test`;
  const res = await signup(api("POST", "/api/auth/signup", undefined, { email, password: PASSWORD, businessName: `Negocio ${name}` }));
  expect(res.status).toBe(201);
  const cookie = (res.headers.get("set-cookie") ?? "").split(";")[0]!;
  const info = await (await me(api("GET", "/api/me", cookie))).json();
  tenantIds.push(info.tenant.id);
  return { tenantId: info.tenant.id as string, cookie };
}
type T = Awaited<ReturnType<typeof register>>;
beforeAll(async () => { await getPool().query("SELECT 1"); });
afterAll(async () => {
  await owner.query("DELETE FROM users WHERE email LIKE $1", [`cx-${RUN}-%`]);
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

/** Crea una conexión directamente en la base (con el secreto cifrado igual que en la app). */
// ====================================================================== firma

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
const DISCORD = "https://discord.com/api/webhooks/123456789012345678/abcdefghijklmnopqrstuvwxyzABCDEFGHIJ-_12345";
// Se arma por partes para que los escáneres de secretos no lo confundan con uno real.
const SLACK = ["https://hooks.slack.com", "services", "T0123ABCD", "B0123ABCD", "abcdefghijklmnopqrstuvwx"].join("/");
const TG_TOKEN = "123456789:AAE_abcdefghijklmnopqrstuvwxyz012345";
const okResolve = async (u: string) => ({ ok: true as const, target: { url: new URL(u), address: "203.0.113.5", family: 4 as const } });

async function dels(tenantId: string, endpointId: string) {
  return withTenant(tenantId, async (db) => (await db.query("SELECT id, event_type, payload, status, last_error FROM webhook_deliveries WHERE tenant_id = $1 AND endpoint_id = $2 ORDER BY created_at, id", [tenantId, endpointId])).rows);
}

describe("enlaces de apps", () => {
  it("Discord: acepta el oficial y rechaza otros dominios o rutas", () => {
    expect(checkAppUrl("discord", DISCORD).ok).toBe(true);
    expect(checkAppUrl("discord", "https://evil.com/api/webhooks/123456789012345678/abcdefghijklmnopqrstuvwxyz").ok).toBe(false);
    expect(checkAppUrl("discord", "https://discord.com.evil.com/api/webhooks/123456789012345678/abcdefghijklmnopqrstuvwxyz").ok).toBe(false);
    expect(checkAppUrl("discord", "http://discord.com/api/webhooks/123456789012345678/abcdefghijklmnopqrstuvwxyz").ok).toBe(false);
    expect(checkAppUrl("discord", "https://discord.com/api/webhooks/123456789012345678/abcdefghijklmnopqrstuvwxyz/../../x").ok).toBe(false);
  });
  it("Slack, Zapier y Make: solo sus dominios", () => {
    expect(checkAppUrl("slack", SLACK).ok).toBe(true);
    expect(checkAppUrl("slack", "https://hooks.slack.com.evil.io/services/T01/B01/abcdefghijklmnopqrstuvwx").ok).toBe(false);
    expect(checkAppUrl("zapier", "https://hooks.zapier.com/hooks/catch/1/abc/").ok).toBe(true);
    expect(checkAppUrl("zapier", "https://example.com/hooks/catch/1/abc/").ok).toBe(false);
    expect(checkAppUrl("make", "https://hook.eu1.make.com/abcdef123456").ok).toBe(true);
    expect(checkAppUrl("make", "https://hook.make.com.evil.com/abcdef").ok).toBe(false);
    expect(checkAppUrl("make", "https://169.254.169.254/abcdef").ok).toBe(false);
  });
  it("cada app trae pasos para la persona", () => {
    for (const a of Object.values(APPS)) { expect(a.steps.length).toBeGreaterThan(0); expect(a.name.length).toBeGreaterThan(0); }
  });
});

describe("mensajes legibles", () => {
  it("pedido, cita, cliente nuevo, stock, prueba y texto de regla", () => {
    const order = { data: { order: { number: 12, status: "pendiente", customer_name: "Ana", customer_phone: "+58414", total_minor: 2550, currency: "USD", items: [{ name: "Torta", quantity: 2 }] } } };
    const t = formatEventText("order.created", order);
    expect(t).toContain("Pedido nuevo #12"); expect(t).toContain("2 × Torta"); expect(t).toContain("25.50 USD");
    expect(formatEventText("order.status_changed", order)).toContain("cambió a «pendiente»");
    expect(formatEventText("appointment.created", { data: { appointment: { service: "Corte", customer_name: "Luis", starts_at: "2026-11-01T15:00:00Z" } } })).toContain("Corte");
    expect(formatEventText("contact.created", { data: { contact: { name: "Eva", phone: "58412" } } })).toContain("Cliente nuevo: Eva");
    expect(formatEventText("stock.low", { data: { product: { name: "Pan", level: "agotado" } } })).toContain("agotado");
    expect(formatEventText("stock.low", { data: { product: { name: "Pan", level: "bajo", stock: 3, min_stock: 10 } } })).toContain("quedan 3");
    expect(formatEventText("webhook.test", {})).toContain("Conexión lista");
    expect(formatEventText("automation.message", { data: { text: "Hola" } })).toBe("Hola");
    expect(formatEventText("algo.raro", {})).toContain("algo.raro");
  });
  it("recorta textos enormes y datos mal formados no rompen", () => {
    expect(formatEventText("automation.message", { data: { text: "x".repeat(5000) } }).length).toBeLessThanOrEqual(1800);
    expect(() => formatEventText("order.created", null)).not.toThrow();
    expect(() => formatEventText("order.created", { data: { order: { items: "no" } } })).not.toThrow();
  });
});

describe("petición por app", () => {
  it("Telegram: dirección oficial con el token y el chat en el cuerpo", () => {
    const r = buildAppRequest("telegram", { token: TG_TOKEN, chatId: "-100123" }, "webhook.test", {});
    expect(r.ok).toBe(true);
    if (r.ok) { expect(r.req.url).toBe(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`); expect(JSON.parse(r.req.body).chat_id).toBe("-100123"); }
    expect(buildAppRequest("telegram", { token: "malo", chatId: "1" }, "webhook.test", {}).ok).toBe(false);
  });
  it("Discord no menciona a nadie y Slack escapa < > &", () => {
    const d = buildAppRequest("discord", { url: DISCORD }, "automation.message", { data: { text: "@everyone hola" } });
    expect(d.ok && JSON.parse(d.req.body).allowed_mentions).toEqual({ parse: [] });
    const s = buildAppRequest("slack", { url: SLACK }, "automation.message", { data: { text: "<!channel> A&B" } });
    expect(s.ok && JSON.parse(s.req.body).text).toBe("&lt;!channel&gt; A&amp;B");
  });
  it("un enlace guardado que ya no es válido no se usa", () => {
    expect(buildAppRequest("discord", { url: "https://evil.com/x" }, "webhook.test", {}).ok).toBe(false);
  });
});

describe("buscar el chat de Telegram", () => {
  const mk = (map: Record<string, { status?: number; body: unknown }>) => (async (input: string | URL | Request) => {
    const m = String(input).split("/").pop()!;
    const r = map[m] ?? { status: 404, body: { ok: false } };
    return new Response(JSON.stringify(r.body), { status: r.status ?? 200 });
  }) as unknown as typeof fetch;
  it("devuelve el bot y los chats que le escribieron, sin repetir", async () => {
    const r = await findTelegramChats(TG_TOKEN, mk({
      getMe: { body: { ok: true, result: { username: "mi_bot" } } },
      getUpdates: { body: { ok: true, result: [{ message: { chat: { id: 55, type: "private", first_name: "Ana" } } }, { message: { chat: { id: 55, type: "private", first_name: "Ana" } } }, { message: { chat: { id: -9, type: "group", title: "Equipo" } } }] } },
    }));
    expect(r).toEqual({ ok: true, bot: "mi_bot", chats: [{ id: "55", title: "Ana" }, { id: "-9", title: "Equipo (grupo)" }] });
  });
  it("token rechazado, bot ocupado y Telegram caído tienen mensaje propio", async () => {
    expect((await findTelegramChats(TG_TOKEN, mk({ getMe: { status: 401, body: { ok: false } } }))).ok).toBe(false);
    const busy = await findTelegramChats(TG_TOKEN, mk({ getMe: { body: { ok: true, result: {} } }, getUpdates: { status: 409, body: { ok: false } } }));
    expect(!busy.ok && busy.code).toBe("bot_en_uso");
    const down = await findTelegramChats(TG_TOKEN, (async () => { throw new Error("x"); }) as unknown as typeof fetch);
    expect(!down.ok && down.status).toBe(502);
  });
});

describe("crear y entregar conexiones de app", () => {
  it("Discord: se crea sin mostrar secreto, guarda el enlace cifrado y encola la prueba", async () => {
    const t = await register("dc");
    const res = await createHook(api("POST", "/api/webhooks", t.cookie, { kind: "discord", url: DISCORD, events: ["order.created"] }));
    expect(res.status).toBe(201);
    const j = await res.json();
    expect(j.secret).toBeUndefined();
    const row = (await ownerExec(t.tenantId, "SELECT url, description, kind, app_config_enc, app_key_version FROM webhook_endpoints WHERE id = $1", [j.id])).rows[0];
    expect(row.kind).toBe("discord"); expect(row.description).toBe("Discord");
    expect(row.url).not.toContain("abcdefghij"); expect(row.app_config_enc).not.toContain("abcdefghij");
    expect(openConfig(row.app_config_enc, row.app_key_version, t.tenantId, j.id)).toEqual({ url: DISCORD });
    const ds = await dels(t.tenantId, j.id);
    expect(ds).toHaveLength(1); expect(ds[0].event_type).toBe("webhook.test");
    const list = await (await listHooks(api("GET", "/api/webhooks", t.cookie))).json();
    expect(JSON.stringify(list)).not.toContain("abcdefghij");
    expect(list.endpoints[0].kind).toBe("discord");
  });
  it("enlaces malos y destinos de otra app se rechazan con mensaje claro", async () => {
    const t = await register("bad");
    const bad = await createHook(api("POST", "/api/webhooks", t.cookie, { kind: "discord", url: "https://example.com/hook", events: ["order.created"] }));
    expect(bad.status).toBe(422);
    expect((await bad.json()).message).toContain("Discord");
    expect((await createHook(api("POST", "/api/webhooks", t.cookie, { kind: "slack", url: DISCORD, events: ["order.created"] }))).status).toBe(422);
    expect((await createHook(api("POST", "/api/webhooks", t.cookie, { kind: "telegram", token: "x", chatId: "1", events: ["order.created"] }))).status).toBe(422);
    expect((await createHook(api("POST", "/api/webhooks", t.cookie, { kind: "telegram", token: TG_TOKEN, events: ["order.created"] }))).status).toBe(422);
  });
  it("Telegram: se crea con token y chat; el token no aparece en la lista", async () => {
    const t = await register("tg");
    const res = await createHook(api("POST", "/api/webhooks", t.cookie, { kind: "telegram", token: TG_TOKEN, chatId: "-100123", events: ["contact.created", "stock.low"] }));
    expect(res.status).toBe(201);
    expect(JSON.stringify(await (await listHooks(api("GET", "/api/webhooks", t.cookie))).json())).not.toContain("AAE_");
  });
  it("Zapier conserva el modo de siempre (firmado) pero sin mostrar secreto", async () => {
    const t = await register("zp");
    const res = await createHook(api("POST", "/api/webhooks", t.cookie, { kind: "zapier", url: "https://hooks.zapier.com/hooks/catch/1/abc/", events: ["order.created"] }));
    expect(res.status).toBe(201);
    expect((await res.json()).secret).toBeUndefined();
  });
  it("el modo avanzado sigue devolviendo el secreto una vez", async () => {
    const t = await register("adv");
    const res = await createHook(api("POST", "/api/webhooks", t.cookie, { url: "https://example.com/aviso", events: ["order.created"] }));
    expect(res.status).toBe(201);
    expect((await res.json()).secret).toMatch(/^whsec_/);
  });
  it("deliverOne manda el texto en español al enlace guardado", async () => {
    const t = await register("del");
    const j = await (await createHook(api("POST", "/api/webhooks", t.cookie, { kind: "discord", url: DISCORD, events: ["order.created"] }))).json();
    const [d] = await dels(t.tenantId, j.id);
    let seen: { url: string; body: string } | null = null;
    const out = await deliverOne(t.tenantId, d.id, { resolve: okResolve, send: async (target, _h, body) => { seen = { url: target.url.toString(), body }; return { ok: true, status: 204, error: null }; } });
    expect(out).toBe("delivered");
    expect(seen!.url).toBe(DISCORD);
    expect(JSON.parse(seen!.body).content).toContain("Conexión lista");
  });
  it("un 404 de la app explica qué hacer, sin mostrar el enlace", async () => {
    const t = await register("e404");
    const j = await (await createHook(api("POST", "/api/webhooks", t.cookie, { kind: "slack", url: SLACK, events: ["order.created"] }))).json();
    const [d] = await dels(t.tenantId, j.id);
    await deliverOne(t.tenantId, d.id, { resolve: okResolve, send: async () => ({ ok: false, status: 404, error: "El destino respondió 404" }) });
    const after = (await dels(t.tenantId, j.id))[0];
    expect(after.last_error).toContain("Slack"); expect(after.last_error).not.toContain("hooks.slack.com");
  });
  it("si falta la config cifrada la entrega falla con mensaje, no con error", async () => {
    const t = await register("nocfg");
    const j = await (await createHook(api("POST", "/api/webhooks", t.cookie, { kind: "discord", url: DISCORD, events: ["order.created"] }))).json();
    await ownerExec(t.tenantId, "UPDATE webhook_endpoints SET app_config_enc = 'basura' WHERE id = $1", [j.id]);
    const [d] = await dels(t.tenantId, j.id);
    await deliverOne(t.tenantId, d.id, { resolve: okResolve, send: async () => { throw new Error("no debe enviar"); } });
    expect((await dels(t.tenantId, j.id))[0].last_error).toContain("Vuelve a conectar");
  });
  it("editar un enlace de app no se permite y no hay secreto que rotar", async () => {
    const t = await register("ed");
    const j = await (await createHook(api("POST", "/api/webhooks", t.cookie, { kind: "discord", url: DISCORD, events: ["order.created"] }))).json();
    expect((await updateHook(api("POST", "/api/webhooks/update", t.cookie, { action: "edit", id: j.id, url: DISCORD }))).status).toBe(422);
    expect((await updateHook(api("POST", "/api/webhooks/update", t.cookie, { action: "rotate", id: j.id }))).status).toBe(409);
    expect((await updateHook(api("POST", "/api/webhooks/update", t.cookie, { action: "edit", id: j.id, events: ["stock.low"] }))).status).toBe(200);
  });
});

describe("eventos nuevos: cliente nuevo y stock bajo", () => {
  async function hook(t: T, events: string[]) {
    const j = await (await createHook(api("POST", "/api/webhooks", t.cookie, { kind: "telegram", token: TG_TOKEN, chatId: "100123", events }))).json();
    await ownerExec(t.tenantId, "DELETE FROM webhook_deliveries WHERE endpoint_id = $1", [j.id]);
    return j.id as string;
  }
  it("contact.created: solo cuando el contacto es nuevo", async () => {
    const t = await register("ct");
    const id = await hook(t, ["contact.created"]);
    const ins = () => withTenant(t.tenantId, (db) => db.query("INSERT INTO contacts (tenant_id, wa_id, display_name) VALUES ($1,'584141112233','Eva') ON CONFLICT (tenant_id, wa_id) DO UPDATE SET display_name = EXCLUDED.display_name", [t.tenantId]));
    await ins(); await ins();
    const ds = await dels(t.tenantId, id);
    expect(ds).toHaveLength(1);
    expect(ds[0].payload.data.contact.name).toBe("Eva");
  });
  it("stock.low: avisa al cruzar el mínimo y al agotarse; no repite ni avisa al subir", async () => {
    const t = await register("st");
    const id = await hook(t, ["stock.low"]);
    const pid = (await withTenant(t.tenantId, (db) => db.query("INSERT INTO catalog_products (tenant_id, name, price_minor, stock, min_stock) VALUES ($1,'Pan',100,20,5) RETURNING id", [t.tenantId]))).rows[0].id;
    const set = (n: number) => withTenant(t.tenantId, (db) => db.query("UPDATE catalog_products SET stock = $3 WHERE tenant_id = $1 AND id = $2", [t.tenantId, pid, n]));
    await set(10); expect(await dels(t.tenantId, id)).toHaveLength(0);
    await set(5);  expect(await dels(t.tenantId, id)).toHaveLength(1);
    await set(4);  expect(await dels(t.tenantId, id)).toHaveLength(1);
    await set(0);  const ds = await dels(t.tenantId, id);
    expect(ds).toHaveLength(2); expect(ds[1].payload.data.product.level).toBe("agotado");
    await set(30); await set(0);
    expect(await dels(t.tenantId, id)).toHaveLength(3);
  });
});

describe("regla: avisar a una app", () => {
  it("al llegar un cliente nuevo manda el texto con {cliente} a la app elegida", async () => {
    const t = await register("rl");
    const j = await (await createHook(api("POST", "/api/webhooks", t.cookie, { kind: "discord", url: DISCORD, events: ["stock.low"] }))).json();
    await ownerExec(t.tenantId, "DELETE FROM webhook_deliveries WHERE endpoint_id = $1", [j.id]);
    const r = await createRule(api("POST", "/api/automations", t.cookie, { name: "Avisar cliente nuevo", triggerEvent: "contact.created", actionType: "app", targetEndpointId: j.id, messageTemplate: "Llegó {cliente}" }));
    expect(r.status).toBe(201);
    await withTenant(t.tenantId, (db) => db.query("INSERT INTO contacts (tenant_id, wa_id, display_name) VALUES ($1,'584142223344','Marta')", [t.tenantId]));
    const ds = await dels(t.tenantId, j.id);
    expect(ds).toHaveLength(1);
    expect(ds[0].event_type).toBe("automation.message");
    expect(ds[0].payload.data.text).toBe("Llegó Marta");
  });
  it("sin app elegida o con la app de otro negocio se rechaza", async () => {
    const a = await register("ra"); const b = await register("rb");
    const j = await (await createHook(api("POST", "/api/webhooks", b.cookie, { kind: "discord", url: DISCORD, events: ["stock.low"] }))).json();
    const base = { name: "X", triggerEvent: "contact.created", actionType: "app", messageTemplate: "Hola" };
    expect((await createRule(api("POST", "/api/automations", a.cookie, base))).status).toBe(422);
    expect((await createRule(api("POST", "/api/automations", a.cookie, { ...base, targetEndpointId: j.id }))).status).toBe(422);
  });
  it("borrar la app deja la regla sin destino y no falla", async () => {
    const t = await register("rd");
    const j = await (await createHook(api("POST", "/api/webhooks", t.cookie, { kind: "discord", url: DISCORD, events: ["stock.low"] }))).json();
    expect((await createRule(api("POST", "/api/automations", t.cookie, { name: "X", triggerEvent: "contact.created", actionType: "app", targetEndpointId: j.id, messageTemplate: "Hola" }))).status).toBe(201);
    expect((await updateHook(api("POST", "/api/webhooks/update", t.cookie, { action: "delete", id: j.id }))).status).toBe(200);
    const row = (await ownerExec(t.tenantId, "SELECT target_endpoint_id, tenant_id FROM automation_rules WHERE tenant_id = $1", [t.tenantId])).rows[0];
    expect(row.target_endpoint_id).toBeNull(); expect(row.tenant_id).toBe(t.tenantId);
    await withTenant(t.tenantId, (db) => db.query("INSERT INTO contacts (tenant_id, wa_id, display_name) VALUES ($1,'584143334455','Zoe')", [t.tenantId]));
  });
});
