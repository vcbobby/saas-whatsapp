import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { POST as signup } from "@/app/api/auth/signup/route";
import { GET as me } from "@/app/api/me/route";
import { GET as detailGet } from "@/app/api/customers/detail/route";
import { GET as messagesGet } from "@/app/api/conversations/messages/route";
import { originLabel, originText } from "@/lib/origin";
import { buildReport } from "@/lib/reports/build";
import { reportLines } from "@/lib/reports/pure";
import { loadDemo } from "@/lib/demo/seed";
import { encryptSecret } from "@/lib/crypto";
import { getPool, withTenant } from "@/lib/db";
import { ingestBatch } from "@/lib/whatsapp/ingest";
import { originOf, parseWebhook } from "@/lib/whatsapp/payload";

const RUN = randomUUID().slice(0, 8);
const ORIGIN = new URL(process.env.APP_URL!).origin;
const PASSWORD = "contraseña-de-prueba-123";
const owner = new Pool({ connectionString: process.env.MIGRATION_DATABASE_URL, max: 2 });
const tenantIds: string[] = [];
let seq = 0;
const newPhoneId = () => `7${RUN.replace(/\D/g, "").padEnd(4, "4").slice(0, 4)}${Date.now() % 100000}${seq++}`.slice(0, 18);
const newWaId = () => `58416${String(Date.now()).slice(-6)}${seq++}`.slice(0, 15);

function api(method: string, path: string, cookie?: string) {
  return new Request(`${ORIGIN}${path}`, { method, headers: { origin: ORIGIN, ...(cookie ? { cookie } : {}) } });
}
async function register(name: string) {
  const email = `og-${RUN}-${name}@example.test`;
  const res = await signup(new Request(`${ORIGIN}/api/auth/signup`, { method: "POST", headers: { origin: ORIGIN, "content-type": "application/json" }, body: JSON.stringify({ email, password: PASSWORD, businessName: `Negocio ${name}` }) }));
  expect(res.status).toBe(201);
  const cookie = (res.headers.get("set-cookie") ?? "").split(";")[0]!;
  const info = await (await me(api("GET", "/api/me", cookie))).json();
  const tenantId = info.tenant.id as string;
  tenantIds.push(tenantId);
  const phoneId = newPhoneId();
  const { payload, keyVersion } = encryptSecret("EAAtoken-de-prueba-del-negocio-1234567890", `wa:${tenantId}:${phoneId}`);
  await owner.query("INSERT INTO tenant_integrations (tenant_id, provider, external_id, secret_enc, key_version) VALUES ($1,'whatsapp',$2,$3,$4)", [tenantId, phoneId, payload, keyVersion]);
  return { tenantId, phoneId, cookie };
}
type T = Awaited<ReturnType<typeof register>>;

beforeAll(async () => { await getPool().query("SELECT 1"); });
afterAll(async () => {
  await owner.query("DELETE FROM users WHERE email LIKE $1", [`og-${RUN}-%`]);
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
    } catch (e) { await c.query("ROLLBACK"); throw e; } finally { c.release(); }
  }
  await owner.end();
  await getPool().end();
});

type Org = NonNullable<Parameters<typeof ingestBatch>[0]["messages"][number]["origin"]>;
const msg = (t: T, waId: string, origin: Org | null = null) =>
  ingestBatch({ phoneNumberId: t.phoneId, statuses: [], messages: [{ waId, name: "Cliente", waMessageId: `wamid.${RUN}.${seq++}`, at: new Date(), type: "text", body: "hola", origin }] });
const contactRow = (t: T, waId: string) => withTenant(t.tenantId, async (db) => (await db.query("SELECT id, origin_type, origin_source_id, origin_url, origin_headline, origin_at FROM contacts WHERE wa_id = $1", [waId])).rows[0]);
const AD: Org = { type: "anuncio", sourceId: "120210000000001", url: "https://fb.me/abc", headline: "Gorras 2x1" };

describe("leer el «referral» de Meta", () => {
  it("anuncio y publicación; lo demás se ignora o se limpia", () => {
    expect(originOf({ referral: { source_type: "ad", source_id: "123", source_url: "https://fb.me/x", headline: "Hola" } })).toEqual({ type: "anuncio", sourceId: "123", url: "https://fb.me/x", headline: "Hola" });
    expect(originOf({ referral: { source_type: "post" } })).toEqual({ type: "publicacion", sourceId: null, url: null, headline: null });
    expect(originOf({})).toBeNull();
    expect(originOf({ referral: { source_type: "otro" } })).toBeNull();
    expect(originOf({ referral: "x" })).toBeNull();
    const o = originOf({ referral: { source_type: "ad", source_id: "id con espacios", source_url: "http://inseguro.test/x", headline: "x".repeat(500) } })!;
    expect([o.sourceId, o.url, o.headline!.length]).toEqual([null, null, 200]);
    expect(originOf({ referral: { source_type: "ad", source_url: "javascript:alert(1)" } })!.url).toBeNull();
  });
  it("parseWebhook lo deja en el mensaje; sin referral queda null", () => {
    const body = (referral?: object) => ({ object: "whatsapp_business_account", entry: [{ changes: [{ field: "messages", value: { metadata: { phone_number_id: "12345678" }, messages: [{ from: "584120000000", id: "wamid.X", timestamp: String(Math.floor(Date.now() / 1000)), type: "text", text: { body: "hola" }, ...(referral ? { referral } : {}) }] } }] }] });
    expect(parseWebhook(body({ source_type: "ad", source_id: "9", headline: "Oferta" }))![0]!.messages[0]!.origin).toMatchObject({ type: "anuncio", headline: "Oferta" });
    expect(parseWebhook(body())![0]!.messages[0]!.origin).toBeNull();
  });
  it("textos para mostrar", () => {
    expect(originText("anuncio", "Gorras")).toBe("Llegó desde un anuncio: «Gorras»");
    expect(originText("publicacion", null)).toBe("Llegó desde una publicación");
    expect(originLabel("anuncio", " Gorras ")).toBe("Anuncio: Gorras");
    expect(originLabel("publicacion", "")).toBe("Publicación");
  });
});

describe("guardar el origen", () => {
  it("el primer mensaje desde un anuncio guarda el origen; uno posterior no lo cambia", async () => {
    const t = await register("primero");
    const wa = newWaId();
    await msg(t, wa, AD);
    const a = await contactRow(t, wa);
    expect(a).toMatchObject({ origin_type: "anuncio", origin_source_id: "120210000000001", origin_url: "https://fb.me/abc", origin_headline: "Gorras 2x1" });
    expect(a.origin_at).not.toBeNull();
    await msg(t, wa, { type: "publicacion", sourceId: null, url: null, headline: "Otra cosa" });
    expect(await contactRow(t, wa)).toMatchObject({ origin_type: "anuncio", origin_headline: "Gorras 2x1", origin_source_id: "120210000000001" });
    await msg(t, wa, null);
    expect((await contactRow(t, wa)).origin_type).toBe("anuncio");
  });
  it("quien escribió directo no tiene origen; si luego llega desde un anuncio, se le guarda", async () => {
    const t = await register("directo");
    const wa = newWaId();
    await msg(t, wa);
    expect(await contactRow(t, wa)).toMatchObject({ origin_type: null, origin_at: null, origin_headline: null });
    await msg(t, wa, AD);
    expect(await contactRow(t, wa)).toMatchObject({ origin_type: "anuncio", origin_headline: "Gorras 2x1" });
  });
  it("la base no acepta un origen a medias ni una dirección que no sea https", async () => {
    const t = await register("reglas");
    const wa = newWaId();
    await msg(t, wa);
    await expect(withTenant(t.tenantId, (db) => db.query("UPDATE contacts SET origin_type = 'anuncio' WHERE wa_id = $1", [wa]))).rejects.toThrow();
    await expect(withTenant(t.tenantId, (db) => db.query("UPDATE contacts SET origin_type = 'anuncio', origin_at = now(), origin_url = 'http://x.test' WHERE wa_id = $1", [wa]))).rejects.toThrow();
  });
  it("cada negocio ve solo lo suyo", async () => {
    const a = await register("iso-a"), b = await register("iso-b");
    const wa = newWaId();
    await msg(a, wa, AD);
    expect(await withTenant(b.tenantId, async (db) => (await db.query("SELECT 1 FROM contacts WHERE origin_type IS NOT NULL")).rowCount)).toBe(0);
  });
});

describe("verlo en pantalla (API) y en el reporte", () => {
  it("la ficha y la conversación traen el origen", async () => {
    const t = await register("api");
    const wa = newWaId();
    await msg(t, wa, AD);
    const c = await contactRow(t, wa);
    const d = await (await detailGet(api("GET", `/api/customers/detail?id=${c.id}`, t.cookie))).json();
    expect(d.customer.origin).toEqual({ type: "anuncio", url: "https://fb.me/abc", headline: "Gorras 2x1" });
    const conv = await withTenant(t.tenantId, async (db) => (await db.query("SELECT id FROM conversations WHERE contact_id = $1", [c.id])).rows[0].id as string);
    const m = await (await messagesGet(api("GET", `/api/conversations/messages?id=${conv}`, t.cookie))).json();
    expect(m.conversation.contact.origin).toEqual({ type: "anuncio", headline: "Gorras 2x1" });
    const wa2 = newWaId();
    await msg(t, wa2);
    const c2 = await contactRow(t, wa2);
    expect((await (await detailGet(api("GET", `/api/customers/detail?id=${c2.id}`, t.cookie))).json()).customer.origin).toBeNull();
  });
  it("el reporte cuenta los clientes nuevos por origen y lo dice en el resumen", async () => {
    const t = await register("rep");
    await withTenant(t.tenantId, async (db) => {
      const ins = (n: string, type: string | null, h: string | null, ago: string) =>
        db.query(`INSERT INTO contacts (tenant_id, wa_id, display_name, origin_type, origin_headline, origin_at, created_at) VALUES ($1,$2,$3,$4,$5, CASE WHEN $4::text IS NULL THEN NULL ELSE now() END, now() - $6::interval)`, [t.tenantId, newWaId(), n, type, h, ago]);
      await ins("A", "anuncio", "Gorras 2x1", "2 days");
      await ins("B", "anuncio", "Gorras 2x1", "3 days");
      await ins("C", "anuncio", "Camisas", "2 days");
      await ins("D", "publicacion", null, "2 days");
      await ins("E", null, null, "2 days");
      await ins("F", "anuncio", "Viejo", "20 days");
    });
    const r = await withTenant(t.tenantId, (db) => buildReport(db, t.tenantId, 7, new Date()));
    expect(r.newCustomers.current).toBe(5);
    expect(r.originTotal).toBe(4);
    expect(r.origins).toEqual([{ label: "Anuncio: Gorras 2x1", count: 2 }, { label: "Publicación", count: 1 }, { label: "Anuncio: Camisas", count: 1 }]);
    expect(reportLines(r).join("\n")).toContain("4 clientes nuevos llegaron desde anuncios o publicaciones; el que más trajo: Anuncio: Gorras 2x1 (2)");
  });
  it("los datos de ejemplo traen clientes con origen para ver el reporte", async () => {
    const t = await register("demo");
    await withTenant(t.tenantId, (db) => loadDemo(db, t.tenantId));
    const rows = await withTenant(t.tenantId, async (db) => (await db.query("SELECT origin_type FROM contacts WHERE demo AND origin_type IS NOT NULL ORDER BY origin_type")).rows);
    expect(rows.map((x) => x.origin_type)).toEqual(["anuncio", "anuncio", "publicacion"]);
  });
});
