import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { POST as signup } from "@/app/api/auth/signup/route";
import { GET as me } from "@/app/api/me/route";
import { POST as teamInvite } from "@/app/api/team/invite/route";
import { POST as inviteSignup } from "@/app/api/invitations/signup/route";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { GET as listHooks, POST as createHook } from "@/app/api/webhooks/route";
import { POST as updateHook } from "@/app/api/webhooks/update/route";
import { decryptSecret } from "@/lib/crypto";
import { createOrder, transitionOrder } from "@/lib/orders/service";
import { BACKOFF_SECONDS, DISABLE_AFTER, MAX_ATTEMPTS, aadFor, deliverDue, deliverOne, type DeliverDeps } from "@/lib/webhooks/deliver";
import { WEBHOOK_EVENTS } from "@/lib/webhooks/events";
import { allowPrivateTargets, isPublicIp, resolveTarget } from "@/lib/webhooks/guard";
import { sendWebhook } from "@/lib/webhooks/send";
import { displayUrl, newSecret, sealSecret } from "@/lib/webhooks/service";
import { signBody, verifySignature } from "@/lib/webhooks/sign";
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
  const email = `wh-${RUN}-${name}@example.test`;
  const res = await signup(api("POST", "/api/auth/signup", undefined, { email, password: PASSWORD, businessName: `Negocio ${name}` }));
  expect(res.status).toBe(201);
  const cookie = (res.headers.get("set-cookie") ?? "").split(";")[0]!;
  const info = await (await me(api("GET", "/api/me", cookie))).json();
  tenantIds.push(info.tenant.id);
  return { tenantId: info.tenant.id as string, cookie };
}
type T = Awaited<ReturnType<typeof register>>;
async function member(t: T, role: "admin" | "agent"): Promise<T> {
  const inv = await teamInvite(api("POST", "/api/team/invite", t.cookie, { email: `wh-${RUN}-${role}-${randomUUID().slice(0, 6)}@example.test`, role }));
  expect(inv.status).toBe(201);
  const token = ((await inv.json()).inviteUrl as string).split("/").pop()!;
  const ok = await inviteSignup(api("POST", "/api/invitations/signup", undefined, { token, password: PASSWORD }));
  expect(ok.status).toBe(201);
  return { tenantId: t.tenantId, cookie: (ok.headers.get("set-cookie") ?? "").split(";")[0]! };
}
beforeAll(async () => { await getPool().query("SELECT 1"); });
afterAll(async () => {
  await owner.query("DELETE FROM users WHERE email LIKE $1", [`wh-${RUN}-%`]);
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
const ALL = [...WEBHOOK_EVENTS];

/** Crea una conexión directamente en la base (con el secreto cifrado igual que en la app). */
async function mkEndpoint(t: T, o: { events?: string[]; active?: boolean; url?: string; description?: string } = {}) {
  const id = randomUUID();
  const secret = newSecret();
  const sealed = sealSecret(secret, t.tenantId, id);
  await withTenant(t.tenantId, (db) =>
    db.query("INSERT INTO webhook_endpoints (id, tenant_id, url, description, events, secret_enc, key_version, active) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)", [id, t.tenantId, o.url ?? "https://8.8.8.8/hook?token=abc", o.description ?? null, o.events ?? ALL, sealed.secretEnc, sealed.keyVersion, o.active ?? true]),
  );
  return { id, secret };
}
const deliveries = (t: T, where = "true") => withTenant(t.tenantId, async (db) => (await db.query(`SELECT * FROM webhook_deliveries WHERE ${where} ORDER BY created_at, id`)).rows);
const queueRow = (deliveryId: string) => owner.query("SELECT * FROM webhook_queue WHERE delivery_id = $1", [deliveryId]).then((r) => r.rows[0] as { next_attempt_at: Date; locked_until: Date | null } | undefined);
const endpointRow = (t: T, id: string) => withTenant(t.tenantId, async (db) => (await db.query("SELECT * FROM webhook_endpoints WHERE id = $1", [id])).rows[0]);
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
const create = (t: T, body: Record<string, unknown> = {}) => post(createHook, "/api/webhooks", t, { url: "https://8.8.8.8/hook", events: ["order.created"], ...body });
const update = (t: T, body: Record<string, unknown>) => post(updateHook, "/api/webhooks/update", t, body);

// ====================================================================== firma
describe("firma de los avisos", () => {
  const body = JSON.stringify({ id: "x", type: "order.created" });
  it("la firma sale como t=<seg>,v1=<hex> y se verifica", () => {
    const sig = signBody("whsec_abc", 1_800_000_000, body);
    expect(sig).toMatch(/^t=1800000000,v1=[0-9a-f]{64}$/);
    expect(verifySignature("whsec_abc", sig, body, { nowSec: 1_800_000_000 })).toBe(true);
  });
  it("rechaza cuerpo alterado, otro secreto, fecha vieja o futura y cabeceras mal formadas", () => {
    const sig = signBody("whsec_abc", 1_800_000_000, body);
    const now = 1_800_000_000;
    expect(verifySignature("whsec_abc", sig, body + " ", { nowSec: now })).toBe(false);
    expect(verifySignature("whsec_otro", sig, body, { nowSec: now })).toBe(false);
    expect(verifySignature("whsec_abc", sig, body, { nowSec: now + 301 })).toBe(false);
    expect(verifySignature("whsec_abc", sig, body, { nowSec: now - 301 })).toBe(false);
    expect(verifySignature("whsec_abc", sig, body, { nowSec: now + 299 })).toBe(true);
    for (const bad of [null, undefined, "", "t=1", "v1=abc", "t=x,v1=" + "a".repeat(64), `t=${now},v1=zz`, `t=${now},v1=${"a".repeat(63)}`]) expect(verifySignature("whsec_abc", bad as string, body, { nowSec: now })).toBe(false);
  });
  it("cada secreto es distinto y largo", () => {
    const a = newSecret(), b = newSecret();
    expect(a).not.toBe(b);
    expect(a).toMatch(/^whsec_[A-Za-z0-9_-]{43}$/);
  });
});

// ================================================================ destinos seguros
describe("protección contra destinos internos (SSRF)", () => {
  it.each(["8.8.8.8", "1.1.1.1", "93.184.216.34", "2606:4700:4700::1111"])("%s es pública", (ip) => expect(isPublicIp(ip)).toBe(true));
  it.each([
    "127.0.0.1", "127.1.2.3", "10.0.0.5", "10.200.1.1", "10.255.255.255", "172.16.0.1", "172.31.255.255", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "224.0.0.1", "240.0.0.1", "192.0.2.1", "198.18.0.1",
    "::1", "::", "fe80::1", "fc00::1", "fd12:3456::1", "ff02::1", "2001:db8::1", "::ffff:127.0.0.1", "::ffff:10.0.0.1", "::ffff:7f00:1", "::ffff:a00:1", "64:ff9b::7f00:1", "2002:7f00:1::1", "no-es-una-ip", "",
  ])("%s NO es pública", (ip) => expect(isPublicIp(ip)).toBe(false));
  it("172.32.0.1 (fuera del rango privado) sí es pública", () => expect(isPublicIp("172.32.0.1")).toBe(true));

  const pub = async () => [{ address: "93.184.216.34", family: 4 }];
  it("acepta una dirección https pública y devuelve la IP a la que se conectará", async () => {
    const r = await resolveTarget("https://hooks.example.com/aviso?x=1", { resolver: pub, allowPrivate: false });
    expect(r).toMatchObject({ ok: true, target: { address: "93.184.216.34", family: 4 } });
  });
  it.each([
    ["http plano", "http://hooks.example.com/a"],
    ["otro protocolo", "ftp://hooks.example.com/a"],
    ["usuario y clave", "https://user:pass@hooks.example.com/a"],
    ["fragmento", "https://hooks.example.com/a#x"],
    ["localhost", "https://localhost/a"],
    ["dominio interno", "https://db.internal/a"],
    ["un solo nombre", "https://servidor/a"],
    ["IP privada", "https://10.0.0.5/a"],
    ["IP de metadatos", "https://169.254.169.254/latest"],
    ["IPv6 local", "https://[::1]/a"],
    ["no es una URL", "esto no es una dirección"],
    ["vacía", ""],
  ])("rechaza %s", async (_n, url) => {
    const r = await resolveTarget(url, { resolver: pub, allowPrivate: false });
    expect(r.ok).toBe(false);
  });
  it("rechaza un dominio que resuelve a una IP interna, aunque otra de sus IP sea pública", async () => {
    expect((await resolveTarget("https://x.example.com", { resolver: async () => [{ address: "10.0.0.1", family: 4 }], allowPrivate: false }).then((r) => r.ok))).toBe(false);
    expect((await resolveTarget("https://x.example.com", { resolver: async () => [{ address: "93.184.216.34", family: 4 }, { address: "127.0.0.1", family: 4 }], allowPrivate: false }).then((r) => r.ok))).toBe(false);
  });
  it("si el dominio no existe, lo dice sin lanzar error", async () => {
    const r = await resolveTarget("https://no-existe.example.com", { resolver: async () => { throw new Error("ENOTFOUND"); }, allowPrivate: false });
    expect(r).toMatchObject({ ok: false });
    expect(r.ok === false && r.reason).toContain("No se pudo encontrar");
  });
  it("en desarrollo se puede permitir http local; en producción nunca, aunque la variable esté puesta", async () => {
    vi.stubEnv("WEBHOOKS_ALLOW_PRIVATE_TARGETS", "true");
    vi.stubEnv("APP_ENV", "test");
    expect(allowPrivateTargets()).toBe(true);
    expect((await resolveTarget("http://127.0.0.1:4000/x")).ok).toBe(true);
    vi.stubEnv("APP_ENV", "production");
    expect(allowPrivateTargets()).toBe(false);
    expect((await resolveTarget("http://127.0.0.1:4000/x")).ok).toBe(false);
    vi.stubEnv("APP_ENV", "test");
    vi.stubEnv("WEBHOOKS_ALLOW_PRIVATE_TARGETS", "");
    expect(allowPrivateTargets()).toBe(false);
  });
  it("la dirección se muestra sin parámetros (pueden llevar claves)", () => {
    expect(displayUrl("https://hooks.example.com/aviso?token=SECRETO")).toBe("https://hooks.example.com/aviso?…");
    expect(displayUrl("https://hooks.example.com/")).toBe("https://hooks.example.com");
    expect(displayUrl("https://u:p@hooks.example.com/a")).not.toContain("p@");
    expect(displayUrl("basura")).toBe("(dirección inválida)");
  });
});

// ============================================================ envío HTTP real
describe("envío HTTP", () => {
  let server: http.Server;
  let port = 0;
  const seen: { url: string; headers: http.IncomingHttpHeaders; body: string }[] = [];
  let mode: "ok" | "500" | "redirect" | "hang" | "big" | "endless" = "ok";
  beforeAll(async () => {
    server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        seen.push({ url: req.url ?? "", headers: req.headers, body });
        if (mode === "hang") return;
        if (mode === "redirect") { res.writeHead(302, { location: "http://127.0.0.1:1/robado" }); return res.end(); }
        if (mode === "500") { res.writeHead(500); return res.end("secreto-interno"); }
        if (mode === "endless") {
          res.writeHead(200);
          const iv = setInterval(() => { if (res.destroyed) clearInterval(iv); else res.write("x".repeat(8192)); }, 5);
          res.on("close", () => clearInterval(iv));
          return;
        }
        if (mode === "big") { res.writeHead(200); return res.end("x".repeat(500_000)); }
        res.writeHead(200); res.end("ok");
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    port = (server.address() as AddressInfo).port;
  });
  afterAll(async () => { server.closeAllConnections(); await new Promise((r) => server.close(r)); });
  const target = (path = "/h", host = "127.0.0.1") => ({ url: new URL(`http://${host}:${port}${path}`), address: "127.0.0.1", family: 4 as const });

  it("envía el cuerpo y las cabeceras tal cual y responde ok con un 2xx", async () => {
    mode = "ok"; seen.length = 0;
    const r = await sendWebhook(target("/aviso?x=1"), { "content-type": "application/json", "x-test": "1" }, '{"a":1}');
    expect(r).toEqual({ ok: true, status: 200, error: null });
    expect(seen[0]).toMatchObject({ url: "/aviso?x=1", body: '{"a":1}' });
    expect(seen[0]!.headers["x-test"]).toBe("1");
    expect(seen[0]!.headers["content-length"]).toBe("7");
  });
  it("un 500 es fallo y no filtra lo que respondió el destino", async () => {
    mode = "500";
    const r = await sendWebhook(target(), {}, "{}");
    expect(r).toMatchObject({ ok: false, status: 500 });
    expect(r.error).toBe("El destino respondió 500");
    expect(JSON.stringify(r)).not.toContain("secreto-interno");
  });
  it("no sigue redirecciones", async () => {
    mode = "redirect"; seen.length = 0;
    const r = await sendWebhook(target(), {}, "{}");
    expect(r).toMatchObject({ ok: false, status: 302 });
    expect(r.error).toContain("redirección");
    expect(seen).toHaveLength(1);
  });
  it("si el destino no responde, corta por tiempo", async () => {
    mode = "hang";
    const t0 = Date.now();
    const r = await sendWebhook(target(), {}, "{}", 300);
    expect(r).toMatchObject({ ok: false, status: null });
    expect(r.error).toContain("no respondió a tiempo");
    expect(Date.now() - t0).toBeLessThan(2_000);
  });
  it("una respuesta que no termina nunca se corta al pasar el tope y cuenta como entregada", async () => {
    mode = "endless";
    const r = await sendWebhook(target(), {}, "{}", 4000);
    expect(r.ok).toBe(true);
  });
  it("una respuesta enorme no cuelga ni rompe el envío", async () => {
    mode = "big";
    const r = await sendWebhook(target(), {}, "{}");
    expect(r.ok).toBe(true);
  });
  it("se conecta a la IP validada, sin volver a resolver el nombre del dominio", async () => {
    mode = "ok"; seen.length = 0;
    const r = await sendWebhook(target("/x", "dominio-que-no-existe.example.test"), {}, "{}");
    expect(r.ok).toBe(true);
    expect(seen[0]!.headers.host).toBe(`dominio-que-no-existe.example.test:${port}`);
  });
  it("conexión rechazada: mensaje claro, sin direcciones", async () => {
    const r = await sendWebhook({ url: new URL("http://127.0.0.1:1/x"), address: "127.0.0.1", family: 4 }, {}, "{}");
    expect(r).toEqual({ ok: false, status: null, error: "El destino rechazó la conexión" });
  });

  it("de punta a punta: deliverOne firma y envía al servidor real, que puede verificar la firma", async () => {
    mode = "ok"; seen.length = 0;
    vi.stubEnv("WEBHOOKS_ALLOW_PRIVATE_TARGETS", "true");
    vi.stubEnv("APP_ENV", "test");
    const t = await register("e2e");
    const ep = await mkEndpoint(t, { url: `http://127.0.0.1:${port}/hook` });
    await withTenant(t.tenantId, async (db) => { const p = await product(db, t); await createOrder(db, { tenantId: t.tenantId, source: "manual", status: "confirmado", customerName: "Ana", items: [{ productId: p, quantity: 2 }] }); });
    const [d] = await deliveries(t);
    expect(await deliverOne(t.tenantId, d.id)).toBe("delivered");
    expect(seen).toHaveLength(1);
    const req = seen[0]!;
    expect(verifySignature(ep.secret, req.headers["x-webhook-signature"] as string, req.body)).toBe(true);
    expect(req.headers["x-webhook-id"]).toBe(d.event_id);
    expect(req.headers["x-webhook-event"]).toBe("order.created");
    expect(req.headers["x-webhook-attempt"]).toBe("1");
    expect(JSON.parse(req.body)).toMatchObject({ id: d.event_id, type: "order.created", data: { order: { customer_name: "Ana", total_minor: 500, items: [{ name: "Arroz", quantity: 2, unit_price_minor: 250 }] } } });
    expect(req.body).not.toContain(ep.secret);
  });
});

// ============================================================ eventos (disparadores)
describe("eventos generados por la base de datos", () => {
  it("pedido nuevo: un aviso con las líneas, creado en la misma transacción", async () => {
    const t = await register("ev-order");
    const ep = await mkEndpoint(t);
    await withTenant(t.tenantId, async (db) => {
      const a = await product(db, t, "Arroz", 250);
      const b = await product(db, t, "Bebida", 1050);
      await createOrder(db, { tenantId: t.tenantId, source: "agente", status: "pendiente", customerName: "Ana", customerPhone: "+584121112233", deliveryNote: "Calle 5", items: [{ productId: a, quantity: 2 }, { productId: b, quantity: 1 }] });
    });
    const ds = await deliveries(t);
    expect(ds).toHaveLength(1);
    expect(ds[0]).toMatchObject({ endpoint_id: ep.id, event_type: "order.created", status: "pendiente", attempts: 0 });
    const p = ds[0].payload;
    expect(p).toMatchObject({ type: "order.created", api_version: "2026-10-01", id: ds[0].event_id });
    expect(p.created_at).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
    expect(p.data.order).toMatchObject({ number: 1, status: "pendiente", source: "agente", currency: "USD", total_minor: 1550, customer_name: "Ana", customer_phone: "+584121112233", delivery_note: "Calle 5" });
    expect(p.data.order.items).toEqual([{ name: "Arroz", quantity: 2, unit_price_minor: 250 }, { name: "Bebida", quantity: 1, unit_price_minor: 1050 }]);
    expect(JSON.stringify(p)).not.toMatch(/secret|tenant_id/);
    expect((await queueRow(ds[0].id))?.locked_until).toBeNull();
  });

  it("pedido que cambia de estado: aviso con el estado anterior; sin cambio de estado no hay aviso", async () => {
    const t = await register("ev-ostatus");
    await mkEndpoint(t, { events: ["order.status_changed"] });
    await withTenant(t.tenantId, async (db) => {
      const p = await product(db, t);
      const o = await createOrder(db, { tenantId: t.tenantId, source: "agente", status: "pendiente", customerName: "Ana", items: [{ productId: p, quantity: 1 }] });
      if (o.kind !== "ok") throw new Error("x");
      await db.query("UPDATE orders SET notes = 'nota' WHERE id = $1", [o.id]); // no es cambio de estado
      expect((await transitionOrder(db, t.tenantId, o.id, "confirm")).kind).toBe("ok");
    });
    const ds = await deliveries(t);
    expect(ds).toHaveLength(1);
    expect(ds[0].event_type).toBe("order.status_changed");
    expect(ds[0].payload.data).toMatchObject({ previous_status: "pendiente", order: { status: "confirmado" } });
  });

  it("cita nueva, cambio de estado y reprogramación", async () => {
    const t = await register("ev-appt");
    await mkEndpoint(t);
    const id = await withTenant(t.tenantId, async (db) => {
      const a = await appt(db, t);
      await db.query("UPDATE appointments SET status = 'confirmada' WHERE id = $1", [a]);
      await db.query("UPDATE appointments SET starts_at = '2026-11-06T15:00:00Z', ends_at = '2026-11-06T15:30:00Z' WHERE id = $1", [a]);
      await db.query("UPDATE appointments SET notes = 'solo nota' WHERE id = $1", [a]);
      return a;
    });
    const ds = await deliveries(t);
    const by = (k: string) => ds.find((d) => d.event_type === k)!;
    expect(ds.map((d) => d.event_type).sort()).toEqual(["appointment.created", "appointment.rescheduled", "appointment.status_changed"]);
    expect(by("appointment.created").payload.data.appointment).toMatchObject({ id, status: "pendiente", service: "Corte", customer_name: "Luis", customer_phone: "+584120000000", source: "manual" });
    expect(by("appointment.status_changed").payload.data).toMatchObject({ previous_status: "pendiente", appointment: { status: "confirmada" } });
    expect(by("appointment.rescheduled").payload.data).toMatchObject({ previous_starts_at: "2026-11-05T14:00:00+00:00", appointment: { starts_at: "2026-11-06T15:00:00+00:00" } });
  });

  it("conversación que pasa a una persona: aviso con motivo y contacto; tomarla a mano o volver al asistente no avisa", async () => {
    const t = await register("ev-hand");
    await mkEndpoint(t, { events: ["conversation.handoff"] });
    await withTenant(t.tenantId, async (db) => {
      const a = await conv(db, t, "Ana");
      await db.query("UPDATE conversations SET status = 'human', handoff_reason = 'pedido_de_persona' WHERE id = $1", [a.conversationId]);
      await db.query("UPDATE conversations SET status = 'human' WHERE id = $1", [a.conversationId]); // ya era human
      await db.query("UPDATE conversations SET status = 'bot', handoff_reason = NULL WHERE id = $1", [a.conversationId]);
      const b = await conv(db, t, null);
      await db.query("UPDATE conversations SET status = 'human', handoff_reason = 'tomada_por_persona' WHERE id = $1", [b.conversationId]);
    });
    const ds = await deliveries(t);
    expect(ds).toHaveLength(1);
    expect(ds[0].payload.data.conversation).toMatchObject({ reason: "pedido_de_persona", contact_name: "Ana" });
    expect(ds[0].payload.data.conversation.contact_phone).toMatch(/^\+5841\d+$/);
  });

  it("si la operación se deshace, el aviso también", async () => {
    const t = await register("ev-rollback");
    await mkEndpoint(t);
    await expect(withTenant(t.tenantId, async (db) => {
      const p = await product(db, t);
      await createOrder(db, { tenantId: t.tenantId, source: "manual", status: "confirmado", customerName: "Ana", items: [{ productId: p, quantity: 1 }] });
      throw new Error("se deshace");
    })).rejects.toThrow("se deshace");
    expect(await deliveries(t)).toHaveLength(0);
  });

  it("solo a conexiones activas y suscritas a ese evento; una entrega por conexión con el mismo id de evento", async () => {
    const t = await register("ev-routing");
    const a = await mkEndpoint(t, { events: ["order.created"] });
    const b = await mkEndpoint(t, { events: ["order.created", "order.status_changed"] });
    await mkEndpoint(t, { events: ["appointment.created"] });
    await mkEndpoint(t, { events: ["order.created"], active: false });
    await withTenant(t.tenantId, async (db) => { const p = await product(db, t); await createOrder(db, { tenantId: t.tenantId, source: "manual", status: "confirmado", customerName: "Ana", items: [{ productId: p, quantity: 1 }] }); });
    const ds = await deliveries(t);
    expect(ds.map((d) => d.endpoint_id).sort()).toEqual([a.id, b.id].sort());
    expect(new Set(ds.map((d) => d.event_id)).size).toBe(1);
  });

  it("no se mezcla entre negocios", async () => {
    const a = await register("ev-isoA");
    const b = await register("ev-isoB");
    await mkEndpoint(b);
    await withTenant(a.tenantId, async (db) => { const p = await product(db, a); await createOrder(db, { tenantId: a.tenantId, source: "manual", status: "confirmado", customerName: "Ana", items: [{ productId: p, quantity: 1 }] }); });
    expect(await deliveries(a)).toHaveLength(0);
    expect(await deliveries(b)).toHaveLength(0);
  });

  it("si emitir el evento falla, la operación del negocio sigue (solo queda un aviso en el registro)", async () => {
    const t = await register("ev-safe");
    await mkEndpoint(t);
    const big = { x: "a".repeat(40_000) };
    await withTenant(t.tenantId, async (db) => {
      await db.query("SELECT emit_event($1, 'order.created', $2::jsonb)", [t.tenantId, JSON.stringify(big)]);
      const p = await product(db, t);
      await createOrder(db, { tenantId: t.tenantId, source: "manual", status: "confirmado", customerName: "Ana", items: [{ productId: p, quantity: 1 }] });
    });
    expect((await deliveries(t)).map((d) => d.event_type)).toEqual(["order.created"]); // solo el del pedido; el gigante se descartó
  });

  it("la app no puede tocar la cola entre negocios directamente", async () => {
    const t = await register("ev-queue");
    await expect(withTenant(t.tenantId, (db) => db.query("SELECT * FROM webhook_queue"))).rejects.toThrow(/permission denied/);
  });
});

// ====================================================================== cola
describe("cola de entregas", () => {
  async function pendingDelivery(t: T, ep: { id: string }) {
    const eventId = randomUUID();
    const id = (await withTenant(t.tenantId, (db) =>
      db.query("INSERT INTO webhook_deliveries (tenant_id, endpoint_id, event_id, event_type, payload) VALUES ($1,$2,$3,'order.created',$4) RETURNING id", [t.tenantId, ep.id, eventId, JSON.stringify({ id: eventId, type: "order.created", data: {} })]),
    )).rows[0].id as string;
    return { id, eventId };
  }
  const claim = (n = 10, lock = 60) => getPool().query<{ out_tenant_id: string; out_delivery_id: string }>("SELECT * FROM webhook_claim($1, $2)", [n, lock]).then((r) => r.rows);

  it("una entrega nueva entra a la cola y se toma una sola vez mientras está bloqueada", async () => {
    const t = await register("q1");
    const ep = await mkEndpoint(t);
    const d = await pendingDelivery(t, ep);
    expect(await queueRow(d.id)).toBeTruthy();
    const mine = (rows: { out_delivery_id: string }[]) => rows.filter((r) => r.out_delivery_id === d.id);
    expect(mine(await claim(50))).toHaveLength(1);
    expect(mine(await claim(50))).toHaveLength(0); // bloqueada
    await owner.query("UPDATE webhook_queue SET locked_until = now() - interval '1 second' WHERE delivery_id = $1", [d.id]); // el worker murió
    expect(mine(await claim(50))).toHaveLength(1);
  });

  it("no toma entregas programadas para más adelante", async () => {
    const t = await register("q2");
    const d = await pendingDelivery(t, await mkEndpoint(t));
    await owner.query("UPDATE webhook_queue SET next_attempt_at = now() + interval '1 hour' WHERE delivery_id = $1", [d.id]);
    expect((await claim(50)).filter((r) => r.out_delivery_id === d.id)).toHaveLength(0);
  });

  it("dos workers a la vez no toman la misma entrega", async () => {
    const t = await register("q3");
    const ep = await mkEndpoint(t);
    const ids = new Set<string>();
    for (let i = 0; i < 6; i++) ids.add((await pendingDelivery(t, ep)).id);
    const [a, b] = await Promise.all([claim(50), claim(50)]);
    const got = [...a, ...b].map((r) => r.out_delivery_id).filter((id) => ids.has(id));
    expect(got).toHaveLength(6);
    expect(new Set(got).size).toBe(6);
  });

  it("webhook_queue_set solo afecta al negocio actual", async () => {
    const a = await register("q4a");
    const b = await register("q4b");
    const d = await pendingDelivery(a, await mkEndpoint(a));
    await withTenant(b.tenantId, (db) => db.query("SELECT webhook_queue_set($1, NULL)", [d.id]));
    expect(await queueRow(d.id)).toBeTruthy();
    await withTenant(a.tenantId, (db) => db.query("SELECT webhook_queue_set($1, NULL)", [d.id]));
    expect(await queueRow(d.id)).toBeUndefined();
  });

  it("borrar la conexión borra sus entregas y su cola", async () => {
    const t = await register("q5");
    const ep = await mkEndpoint(t);
    const d = await pendingDelivery(t, ep);
    await withTenant(t.tenantId, (db) => db.query("DELETE FROM webhook_endpoints WHERE id = $1", [ep.id]));
    expect(await deliveries(t)).toHaveLength(0);
    expect(await queueRow(d.id)).toBeUndefined();
  });
});

// ================================================================== entrega
describe("entrega con reintentos", () => {
  const okSend = () => vi.fn(async () => ({ ok: true, status: 200, error: null }));
  const failSend = (status: number | null = 500, error = "El destino respondió 500") => vi.fn(async () => ({ ok: false, status, error }));
  const pubResolve = async () => ({ ok: true as const, target: { url: new URL("https://8.8.8.8/hook"), address: "8.8.8.8", family: 4 as const } });
  const deps = (send: DeliverDeps["send"], extra: Partial<DeliverDeps> = {}): DeliverDeps => ({ send, resolve: pubResolve, ...extra });

  async function one(t: T, ep: { id: string }) {
    const eventId = randomUUID();
    return (await withTenant(t.tenantId, (db) =>
      db.query("INSERT INTO webhook_deliveries (tenant_id, endpoint_id, event_id, event_type, payload) VALUES ($1,$2,$3,'order.created',$4) RETURNING id", [t.tenantId, ep.id, eventId, JSON.stringify({ id: eventId, type: "order.created", api_version: "2026-10-01", data: { n: 1 } })]),
    )).rows[0].id as string;
  }
  const del = async (t: T, id: string) => (await deliveries(t, `id = '${id}'`))[0];

  it("éxito: firma correcta, cabeceras, entregado y fuera de la cola", async () => {
    const t = await register("d-ok");
    const ep = await mkEndpoint(t);
    const id = await one(t, ep);
    const send = okSend();
    expect(await deliverOne(t.tenantId, id, deps(send, { nowSec: () => 1_800_000_000 }))).toBe("delivered");
    const [target, headers, body] = send.mock.calls[0] as unknown as [{ address: string }, Record<string, string>, string];
    expect(target.address).toBe("8.8.8.8");
    expect(headers["x-webhook-signature"]).toBe(signBody(ep.secret, 1_800_000_000, body));
    expect(headers).toMatchObject({ "content-type": "application/json", "x-webhook-attempt": "1", "x-webhook-event": "order.created" });
    expect(JSON.parse(body)).toMatchObject({ type: "order.created", data: { n: 1 } });
    const row = await del(t, id);
    expect(row).toMatchObject({ status: "entregado", attempts: 1, last_status: 200, last_error: null });
    expect(row.finished_at).toBeTruthy();
    expect(await queueRow(id)).toBeUndefined();
  });

  it("fallo: reintenta con la espera escalonada y registra el motivo", async () => {
    const t = await register("d-retry");
    const ep = await mkEndpoint(t);
    const id = await one(t, ep);
    for (let n = 1; n <= BACKOFF_SECONDS.length; n++) {
      expect(await deliverOne(t.tenantId, id, deps(failSend(503, "El destino respondió 503")))).toBe("retry");
      const row = await del(t, id);
      expect(row).toMatchObject({ status: "pendiente", attempts: n, last_status: 503, last_error: "El destino respondió 503", finished_at: null });
      const q = (await queueRow(id))!;
      const wait = (q.next_attempt_at.getTime() - Date.now()) / 1000;
      expect(wait).toBeGreaterThan(BACKOFF_SECONDS[n - 1]! - 15);
      expect(wait).toBeLessThanOrEqual(BACKOFF_SECONDS[n - 1]! + 1);
    }
    // El siguiente intento (el sexto) ya es el último: se rinde.
    expect(await deliverOne(t.tenantId, id, deps(failSend()))).toBe("failed");
    expect(await del(t, id)).toMatchObject({ status: "fallido", attempts: MAX_ATTEMPTS });
    expect(await queueRow(id)).toBeUndefined();
    expect((await endpointRow(t, ep.id)).consecutive_failures).toBe(1);
  });

  it("un éxito reinicia el contador de fallos seguidos de la conexión", async () => {
    const t = await register("d-reset");
    const ep = await mkEndpoint(t);
    await withTenant(t.tenantId, (db) => db.query("UPDATE webhook_endpoints SET consecutive_failures = 4 WHERE id = $1", [ep.id]));
    await deliverOne(t.tenantId, await one(t, ep), deps(okSend()));
    expect((await endpointRow(t, ep.id)).consecutive_failures).toBe(0);
  });

  it("los tiempos y límites de reintento son los acordados", () => {
    expect([...BACKOFF_SECONDS]).toEqual([60, 300, 1800, 7200, 21600]);
    expect(MAX_ATTEMPTS).toBe(6);
    expect(DISABLE_AFTER).toBe(10);
  });
  it(`tras ${DISABLE_AFTER} entregas rendidas seguidas la conexión se desactiva y deja UNA tarea en «Hoy»`, async () => {
    const t = await register("d-disable");
    const ep = await mkEndpoint(t, { description: "Mi sistema" });
    for (let i = 0; i < DISABLE_AFTER + 1; i++) {
      const id = await one(t, ep);
      await withTenant(t.tenantId, (db) => db.query("UPDATE webhook_deliveries SET attempts = $2 WHERE id = $1", [id, MAX_ATTEMPTS - 1]));
      const out = await deliverOne(t.tenantId, id, deps(failSend()));
      expect(out).toBe(i < DISABLE_AFTER ? "failed" : "failed");
    }
    const e = await endpointRow(t, ep.id);
    expect(e.active).toBe(false);
    expect(e.disabled_reason).toContain(String(DISABLE_AFTER));
    const tasks = await withTenant(t.tenantId, async (db) => (await db.query("SELECT * FROM work_items WHERE dedupe_key = $1", [`webhook-off:${ep.id}`])).rows);
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({ type: "tarea", priority: 1, status: "abierto", source: "sistema" });
    expect(tasks[0].title).toContain("Mi sistema");
  });

  it("una conexión desactivada no envía nada: la entrega queda fallida", async () => {
    const t = await register("d-inactive");
    const ep = await mkEndpoint(t, { active: false });
    const id = await one(t, ep);
    const send = okSend();
    expect(await deliverOne(t.tenantId, id, deps(send))).toBe("failed");
    expect(send).not.toHaveBeenCalled();
    expect((await del(t, id)).last_error).toContain("desactivada");
  });

  it("un destino que ya no es público (cambio de DNS) no se envía y queda registrado", async () => {
    const t = await register("d-blocked");
    const ep = await mkEndpoint(t);
    const id = await one(t, ep);
    const send = okSend();
    const resolve = async () => ({ ok: false as const, reason: "Esa dirección apunta a una red interna. Usa el dominio público de tu sistema." });
    expect(await deliverOne(t.tenantId, id, { send, resolve })).toBe("retry");
    expect(send).not.toHaveBeenCalled();
    expect((await del(t, id)).last_error).toContain("red interna");
  });

  it("un secreto que no se puede leer (por ejemplo, copiado a otra conexión) no se envía", async () => {
    const t = await register("d-aad");
    const a = await mkEndpoint(t);
    const b = await mkEndpoint(t);
    const secretA = await withTenant(t.tenantId, async (db) => (await db.query("SELECT secret_enc, key_version FROM webhook_endpoints WHERE id = $1", [a.id])).rows[0]);
    await withTenant(t.tenantId, (db) => db.query("UPDATE webhook_endpoints SET secret_enc = $2, key_version = $3 WHERE id = $1", [b.id, secretA.secret_enc, secretA.key_version]));
    const id = await one(t, b);
    const send = okSend();
    await deliverOne(t.tenantId, id, deps(send));
    expect(send).not.toHaveBeenCalled();
    expect((await del(t, id)).last_error).toContain("secreto");
  });

  it("el secreto guardado está cifrado y solo se lee con el negocio y la conexión correctos", async () => {
    const t = await register("d-enc");
    const ep = await mkEndpoint(t);
    const row = await endpointRow(t, ep.id);
    expect(row.secret_enc).not.toContain(ep.secret);
    expect(decryptSecret(row.secret_enc, aadFor(t.tenantId, ep.id), row.key_version)).toBe(ep.secret);
    expect(() => decryptSecret(row.secret_enc, aadFor(t.tenantId, randomUUID()), row.key_version)).toThrow();
    expect(() => decryptSecret(row.secret_enc, aadFor(randomUUID(), ep.id), row.key_version)).toThrow();
  });

  it("repetir la misma entrega ya enviada no vuelve a enviar", async () => {
    const t = await register("d-twice");
    const ep = await mkEndpoint(t);
    const id = await one(t, ep);
    const send = okSend();
    expect(await deliverOne(t.tenantId, id, deps(send))).toBe("delivered");
    expect(await deliverOne(t.tenantId, id, deps(send))).toBe("skipped");
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("una entrega de otro negocio no se puede entregar con un tenantId ajeno", async () => {
    const a = await register("d-isoA");
    const b = await register("d-isoB");
    const id = await one(a, await mkEndpoint(a));
    const send = okSend();
    expect(await deliverOne(b.tenantId, id, deps(send))).toBe("skipped");
    expect(send).not.toHaveBeenCalled();
    expect((await del(a, id)).status).toBe("pendiente");
  });

  it("deliverDue: entrega lo vencido en paralelo, cada entrega una sola vez aunque haya dos workers", async () => {
    const t = await register("d-due");
    const ep = await mkEndpoint(t);
    const ids = [await one(t, ep), await one(t, ep), await one(t, ep)];
    const send = vi.fn(async () => { await new Promise((r) => setTimeout(r, 30)); return { ok: true, status: 200, error: null }; });
    const [x, y] = await Promise.all([deliverDue(50, deps(send)), deliverDue(50, deps(send))]);
    expect(x.delivered + y.delivered).toBeGreaterThanOrEqual(3);
    for (const id of ids) expect((await del(t, id)).attempts).toBe(1);
    expect((await deliveries(t, "status = 'entregado'")).length).toBe(3);
  });

  it("limpia lo viejo: borra entregas terminadas de hace más de 14 días de ESTE negocio y no toca lo reciente ni lo ajeno", async () => {
    const a = await register("d-purgeA");
    const b = await register("d-purgeB");
    const epA = await mkEndpoint(a), epB = await mkEndpoint(b);
    const [oldA, newA, oldB] = [await one(a, epA), await one(a, epA), await one(b, epB)];
    for (const [t, id] of [[a, oldA], [a, newA], [b, oldB]] as const) await withTenant(t.tenantId, (db) => db.query("UPDATE webhook_deliveries SET status = 'entregado', finished_at = $2 WHERE id = $1", [id, id === newA ? new Date().toISOString() : new Date(Date.now() - 15 * 86_400_000).toISOString()]));
    await deliverOne(a.tenantId, await one(a, epA), deps(okSend()));
    expect(await deliveries(a, `id = '${oldA}'`)).toHaveLength(0);
    expect(await deliveries(a, `id = '${newA}'`)).toHaveLength(1);
    expect(await deliveries(b, `id = '${oldB}'`)).toHaveLength(1);
  });
});

// ====================================================================== API
describe("API de conexiones", () => {
  it("sin sesión, sin origen o con rol agente, no entra", async () => {
    const t = await register("api-auth");
    expect((await listHooks(api("GET", "/api/webhooks"))).status).toBe(401);
    expect((await create(null as unknown as T)).status).toBe(401);
    expect((await createHook(api("POST", "/api/webhooks", t.cookie, { url: "https://8.8.8.8/h", events: ["order.created"] }, "https://evil.example"))).status).toBe(403);
    const agent = await member(t, "agent");
    expect((await listHooks(api("GET", "/api/webhooks", agent.cookie))).status).toBe(403);
    expect((await create(agent)).status).toBe(403);
    expect((await update(agent, { action: "delete", id: randomUUID() })).status).toBe(403);
    const admin = await member(t, "admin");
    expect((await listHooks(api("GET", "/api/webhooks", admin.cookie))).status).toBe(200);
    expect((await create(admin)).status).toBe(201);
  });

  it("crear: devuelve el secreto UNA vez, lo guarda cifrado y no lo vuelve a mostrar", async () => {
    const t = await register("api-create");
    const res = await create(t, { description: "Mi sistema", events: ["order.created", "order.created", "appointment.created"] });
    expect(res.status).toBe(201);
    const { id, secret } = await res.json();
    expect(secret).toMatch(/^whsec_/);
    const row = await endpointRow(t, id);
    expect(row.events).toEqual(["order.created", "appointment.created"]);
    expect(row.secret_enc).not.toContain(secret);
    expect(decryptSecret(row.secret_enc, aadFor(t.tenantId, id), row.key_version)).toBe(secret);
    const list = await (await listHooks(api("GET", "/api/webhooks", t.cookie))).json();
    expect(JSON.stringify(list)).not.toContain(secret);
    expect(JSON.stringify(list)).not.toMatch(/secret/i);
    expect(list.endpoints[0]).toMatchObject({ id, description: "Mi sistema", active: true, events: ["order.created", "appointment.created"], pending: 0 });
    const audit = await withTenant(t.tenantId, (db) => db.query("SELECT metadata FROM audit_log WHERE action = 'webhook.created'"));
    expect(audit.rows).toHaveLength(1);
    expect(JSON.stringify(audit.rows[0])).not.toContain(secret);
  });

  it.each([
    ["http", { url: "http://8.8.8.8/h" }],
    ["IP privada", { url: "https://10.0.0.5/h" }],
    ["metadatos de la nube", { url: "https://169.254.169.254/latest/meta-data" }],
    ["localhost", { url: "https://localhost/h" }],
    ["con usuario y clave", { url: "https://u:p@8.8.8.8/h" }],
    ["sin avisos", { events: [] }],
    ["aviso desconocido", { events: ["order.deleted"] }],
    ["dirección corta", { url: "https://a" }],
    ["dirección gigante", { url: "https://8.8.8.8/" + "a".repeat(2100) }],
    ["descripción larga", { description: "a".repeat(121) }],
  ])("rechaza: %s", async (_n, body) => {
    const t = await register("api-bad" + Math.random().toString(36).slice(2, 8));
    const res = await create(t, body);
    expect([400, 422]).toContain(res.status);
    expect(await withTenant(t.tenantId, async (db) => (await db.query("SELECT count(*)::int AS n FROM webhook_endpoints")).rows[0].n)).toBe(0);
  });

  it("máximo 10 conexiones por negocio", async () => {
    const t = await register("api-max");
    for (let i = 0; i < 10; i++) expect((await create(t)).status).toBe(201);
    const res = await create(t);
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("limite_conexiones");
  });

  it("la lista oculta los parámetros de la dirección y trae el registro de envíos", async () => {
    const t = await register("api-list");
    const ep = await mkEndpoint(t, { url: "https://8.8.8.8/hook?token=MUYSECRETO" });
    await withTenant(t.tenantId, async (db) => { const p = await product(db, t); await createOrder(db, { tenantId: t.tenantId, source: "manual", status: "confirmado", customerName: "Ana", items: [{ productId: p, quantity: 1 }] }); });
    const list = await (await listHooks(api("GET", "/api/webhooks", t.cookie))).json();
    expect(list.endpoints[0].url).toBe("https://8.8.8.8/hook?…");
    expect(JSON.stringify(list)).not.toContain("MUYSECRETO");
    expect(list.endpoints[0].pending).toBe(1);
    expect(list.deliveries).toHaveLength(1);
    expect(list.deliveries[0]).toMatchObject({ endpointId: ep.id, eventType: "order.created", status: "pendiente", attempts: 0 });
    expect(list.deliveries[0].payload).toBeUndefined();
    expect(list.max).toBe(10);
  });

  it("activar y desactivar: al reactivar se reinician los fallos y se cierra la tarea de aviso", async () => {
    const t = await register("api-toggle");
    const ep = await mkEndpoint(t);
    await withTenant(t.tenantId, async (db) => {
      await db.query("UPDATE webhook_endpoints SET active = false, consecutive_failures = 10, disabled_reason = 'x' WHERE id = $1", [ep.id]);
      await db.query("INSERT INTO work_items (tenant_id, type, title, source, dedupe_key) VALUES ($1,'tarea','Se desactivó','sistema',$2)", [t.tenantId, `webhook-off:${ep.id}`]);
    });
    expect((await update(t, { action: "toggle", id: ep.id, active: true })).status).toBe(200);
    expect(await endpointRow(t, ep.id)).toMatchObject({ active: true, consecutive_failures: 0, disabled_reason: null });
    expect(await withTenant(t.tenantId, async (db) => (await db.query("SELECT status FROM work_items WHERE dedupe_key = $1", [`webhook-off:${ep.id}`])).rows[0].status)).toBe("resuelto");
    expect((await update(t, { action: "toggle", id: ep.id, active: false })).status).toBe(200);
    expect(await endpointRow(t, ep.id)).toMatchObject({ active: false, disabled_reason: "Desactivada por una persona." });
  });

  it("editar: cambia avisos y descripción; la dirección nueva se vuelve a validar", async () => {
    const t = await register("api-edit");
    const ep = await mkEndpoint(t);
    expect((await update(t, { action: "edit", id: ep.id, description: "Nuevo", events: ["appointment.created"] })).status).toBe(200);
    expect(await endpointRow(t, ep.id)).toMatchObject({ description: "Nuevo", events: ["appointment.created"] });
    expect((await update(t, { action: "edit", id: ep.id, url: "https://10.0.0.1/x" })).status).toBe(422);
    expect((await update(t, { action: "edit", id: ep.id, url: "https://1.1.1.1/nuevo" })).status).toBe(200);
    expect((await endpointRow(t, ep.id)).url).toBe("https://1.1.1.1/nuevo");
    expect((await update(t, { action: "edit", id: ep.id, description: null })).status).toBe(200);
    expect((await endpointRow(t, ep.id)).description).toBeNull();
    expect((await update(t, { action: "edit", id: ep.id, events: [] })).status).toBe(400);
  });

  it("rotar el secreto: el nuevo cambia, solo se muestra en esa respuesta y el anterior deja de servir", async () => {
    const t = await register("api-rotate");
    const ep = await mkEndpoint(t);
    const res = await update(t, { action: "rotate", id: ep.id });
    expect(res.status).toBe(200);
    const { secret } = await res.json();
    expect(secret).toMatch(/^whsec_/);
    expect(secret).not.toBe(ep.secret);
    const row = await endpointRow(t, ep.id);
    expect(decryptSecret(row.secret_enc, aadFor(t.tenantId, ep.id), row.key_version)).toBe(secret);
    expect(JSON.stringify(await (await listHooks(api("GET", "/api/webhooks", t.cookie))).json())).not.toContain(secret);
  });

  it("borrar la conexión y todo lo suyo", async () => {
    const t = await register("api-del");
    const ep = await mkEndpoint(t);
    await withTenant(t.tenantId, async (db) => { const p = await product(db, t); await createOrder(db, { tenantId: t.tenantId, source: "manual", status: "confirmado", customerName: "Ana", items: [{ productId: p, quantity: 1 }] }); });
    expect((await update(t, { action: "delete", id: ep.id })).status).toBe(200);
    expect(await endpointRow(t, ep.id)).toBeUndefined();
    expect(await deliveries(t)).toHaveLength(0);
    expect((await update(t, { action: "delete", id: ep.id })).status).toBe(404);
  });

  it("enviar prueba: crea una entrega «webhook.test»; no funciona con la conexión desactivada", async () => {
    const t = await register("api-test");
    const ep = await mkEndpoint(t, { events: ["order.created"] }); // la prueba no depende de la suscripción
    expect((await update(t, { action: "test", id: ep.id })).status).toBe(200);
    const ds = await deliveries(t);
    expect(ds).toHaveLength(1);
    expect(ds[0]).toMatchObject({ event_type: "webhook.test", status: "pendiente" });
    expect(ds[0].payload).toMatchObject({ type: "webhook.test", data: { message: "Prueba de conexión" } });
    expect((await update(t, { action: "toggle", id: ep.id, active: false })).status).toBe(200);
    expect((await update(t, { action: "test", id: ep.id })).status).toBe(409);
  });

  it("reintentar: solo envíos fallidos de conexiones activas; vuelve a la cola desde cero", async () => {
    const t = await register("api-retry");
    const ep = await mkEndpoint(t);
    const eventId = randomUUID();
    const mk = async (status: string) => (await withTenant(t.tenantId, (db) =>
      db.query("INSERT INTO webhook_deliveries (tenant_id, endpoint_id, event_id, event_type, payload, status, attempts, finished_at) VALUES ($1,$2,$3,'order.created','{}'::jsonb,$4,6, CASE WHEN $4 = 'pendiente' THEN NULL ELSE now() END) RETURNING id", [t.tenantId, ep.id, status === "fallido" ? eventId : randomUUID(), status]),
    )).rows[0].id as string;
    const failed = await mk("fallido");
    const done = await mk("entregado");
    expect((await update(t, { action: "retry", deliveryId: done })).status).toBe(409);
    expect((await update(t, { action: "retry", deliveryId: failed })).status).toBe(200);
    expect((await deliveries(t, `id = '${failed}'`))[0]).toMatchObject({ status: "pendiente", attempts: 0, finished_at: null });
    expect(await queueRow(failed)).toBeTruthy();
    expect((await update(t, { action: "retry", deliveryId: failed })).status).toBe(409); // ya está pendiente
  });

  it("un negocio no puede ver ni tocar las conexiones de otro", async () => {
    const a = await register("api-isoA");
    const b = await register("api-isoB");
    const ep = await mkEndpoint(a);
    for (const action of ["toggle", "rotate", "delete", "test"]) {
      const res = await update(b, { action, id: ep.id, active: false });
      expect([404, 409]).toContain(res.status);
    }
    expect((await update(b, { action: "edit", id: ep.id, description: "robado" })).status).toBe(404);
    expect(await endpointRow(a, ep.id)).toMatchObject({ active: true, description: null });
    expect((await (await listHooks(api("GET", "/api/webhooks", b.cookie))).json()).endpoints).toEqual([]);
  });
});
