import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GET as billingGet } from "@/app/api/billing/route";
import { POST as billingPay } from "@/app/api/billing/pay/route";
import { POST as billingSubmit } from "@/app/api/billing/submit/route";
import { GET as adminPayments } from "@/app/api/admin/payments/route";
import { GET as adminProof } from "@/app/api/admin/payments/proof/route";
import { POST as adminDecide } from "@/app/api/admin/payments/decide/route";
import { GET as settingsGet, POST as settingsPost } from "@/app/api/admin/billing-settings/route";
import { POST as planPrice } from "@/app/api/admin/plan-price/route";
import { POST as login } from "@/app/api/auth/login/route";
import { POST as signup } from "@/app/api/auth/signup/route";
import { POST as verify2fa } from "@/app/api/auth/2fa/verify/route";
import { GET as me } from "@/app/api/me/route";
import { hashPassword } from "@/lib/auth/password";
import { getPool, withTenant } from "@/lib/db";
import { tokenHashOf } from "@/lib/auth/session";
import { amountMatches, formatBs, formatUsd, parseAmountToCents } from "@/lib/billing/money";
import { sniffImage } from "@/lib/billing/proof";
import { codeFor, enableMfaDirect } from "./mfa-helpers";

const RUN = randomUUID().slice(0, 8);
const ORIGIN = new URL(process.env.APP_URL!).origin;
const PASSWORD = "contraseña-de-prueba-123";
const owner = new Pool({ connectionString: process.env.MIGRATION_DATABASE_URL, max: 3 });
const tenantIds: string[] = [];
const planIds: string[] = [];
let admin = "";
let planId = "";
let oldSettings: Record<string, unknown> = {};

const req = (method: string, path: string, cookie?: string, body?: unknown) =>
  new Request(`${ORIGIN}${path}`, { method, headers: { origin: ORIGIN, ...(body !== undefined ? { "content-type": "application/json" } : {}), ...(cookie ? { cookie } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
const cookieOf = (res: Response) => (res.headers.get("set-cookie") ?? "").split(";")[0]!;

async function register(name: string) {
  const res = await signup(req("POST", "/api/auth/signup", undefined, { email: `bl-${RUN}-${name}@example.test`, password: PASSWORD, businessName: `Negocio ${name}` }));
  expect(res.status).toBe(201);
  const cookie = cookieOf(res);
  const info = await (await me(req("GET", "/api/me", cookie))).json();
  tenantIds.push(info.tenant.id);
  return { cookie, tenantId: info.tenant.id as string };
}
type T = Awaited<ReturnType<typeof register>>;

async function makeSuperAdmin() {
  const addr = `bl-${RUN}-admin@example.test`;
  const ins = await owner.query<{ id: string }>("INSERT INTO users (email, password_hash, is_super_admin) VALUES ($1,$2,true) RETURNING id", [addr, await hashPassword(PASSWORD)]);
  const secret = await enableMfaDirect(owner, ins.rows[0]!.id);
  const res = await login(req("POST", "/api/auth/login", undefined, { email: addr, password: PASSWORD }));
  const ver = await verify2fa(req("POST", "/api/auth/2fa/verify", cookieOf(res), { code: codeFor(secret) }));
  expect(ver.status).toBe(200);
  return cookieOf(ver);
}

// Imágenes mínimas válidas (cabeceras reales).
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(200, 7)]);
const JPG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(200, 9)]);
const today = () => new Date().toISOString().slice(0, 10);
const daysAgo = (n: number) => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);

const SETTINGS: { rate: number | null; pmBank: string; pmPhone: string; pmHolderId: string; pmHolderName: string; paypal: string; binance: string; notes: string } = { rate: 40.5, pmBank: "0102 Banco de Venezuela", pmPhone: "0414-1234567", pmHolderId: "J-12345678-9", pmHolderName: "Mi Empresa C.A.", paypal: "pagos@example.test", binance: "123456789", notes: "" };
const setSettings = async (s: Partial<typeof SETTINGS> = {}) => expect((await settingsPost(req("POST", "/api/admin/billing-settings", admin, { ...SETTINGS, ...s }))).status).toBe(200);

async function pay(t: T, method: "pago_movil" | "paypal" | "binance" = "pago_movil", months = 1, pid = planId) {
  return billingPay(req("POST", "/api/billing/pay", t.cookie, { planId: pid, months, method }));
}
async function payId(t: T, method: "pago_movil" | "paypal" | "binance" = "pago_movil", months = 1) {
  const r = await pay(t, method, months);
  expect(r.status).toBe(201);
  return (await r.json()).paymentId as string;
}
type PayRow = { id: string; amountUsdCents: number; rate: number | null; amountBsCents: number | null; status: string; quoteExpiresAt: string; reference: string | null; declaredCents: number | null; paidOn: string | null; rejectReason: string | null };
const payments = async (t: T) => (await (await billingGet(req("GET", "/api/billing", t.cookie))).json()).payments as PayRow[];
const submit = (t: T, paymentId: string, o: Record<string, unknown> = {}) =>
  billingSubmit(req("POST", "/api/billing/submit", t.cookie, { paymentId, reference: `REF${randomUUID().replace(/-/g, "").slice(0, 10)}`, bank: "0134 Banesco", phone: "04141112233", paidOn: today(), declared: "40,50", proof: PNG.toString("base64"), ...o }));
const decide = (paymentId: string, approve: boolean, reason?: string) => adminDecide(req("POST", "/api/admin/payments/decide", admin, { paymentId, approve, reason }));
const tenantRow = (t: T) => withTenant(t.tenantId, async (db) => (await db.query("SELECT plan_id, plan_expires_at, status FROM tenants WHERE id = $1", [t.tenantId])).rows[0]);
const hash = (cookie: string) => tokenHashOf(req("GET", "/", cookie))!;

beforeAll(async () => {
  await getPool().query("SELECT 1");
  admin = await makeSuperAdmin();
  oldSettings = (await owner.query("SELECT * FROM platform_settings")).rows[0];
  const p = await owner.query<{ id: string }>("INSERT INTO plans (slug, name, position, max_replies_month, max_members, modules, price_usd_cents) VALUES ($1,'Plan cobro',97,500,4,'{agenda}',1000) RETURNING id", [`bl-${RUN}`]);
  planId = p.rows[0]!.id;
  planIds.push(planId);
  await setSettings();
});
afterAll(async () => {
  await owner.query("DELETE FROM users WHERE email LIKE $1", [`bl-${RUN}-%`]);
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
  // La tasa y los datos de cobro vuelven a como estaban.
  const o = oldSettings as Record<string, unknown>;
  await owner.query("UPDATE platform_settings SET bcv_rate=$1, bcv_rate_at=$2, pm_bank=$3, pm_phone=$4, pm_holder_id=$5, pm_holder_name=$6, paypal_email=$7, binance_id=$8, notes=$9", [o.bcv_rate, o.bcv_rate_at, o.pm_bank, o.pm_phone, o.pm_holder_id, o.pm_holder_name, o.paypal_email, o.binance_id, o.notes]);
  if (planIds.length) await owner.query("DELETE FROM plans WHERE id = ANY($1)", [planIds]);
  await owner.end();
});

describe("montos y comprobantes (funciones puras)", () => {
  it("lee montos escritos de varias formas", () => {
    const ok: Array<[string, number]> = [["40,50", 4050], ["40.50", 4050], ["1.234,56", 123456], ["1,234.56", 123456], ["1.234", 123400], ["12", 1200], ["Bs. 7,5", 750], ["$ 10", 1000], ["0,01", 1], ["1234567,89", 123456789]];
    for (const [i, c] of ok) expect(parseAmountToCents(i), i).toBe(c);
    for (const bad of ["", "abc", "0", "0,00", "-5", "1,2,3x", "12,345", "1.2.3,4,5", "9999999999999999", "1234567890123"]) expect(parseAmountToCents(bad), bad).toBeNull();
  });
  it("formatea dólares y bolívares", () => {
    expect(formatUsd(1050)).toBe("$10,50");
    expect(formatBs(123456)).toBe("Bs. 1.234,56");
  });
  it("tolera 1 % entre lo declarado y lo esperado", () => {
    expect(amountMatches(4050, 4050)).toBe(true);
    expect(amountMatches(4040, 4050)).toBe(true);
    expect(amountMatches(4000, 4050)).toBe(false);
    expect(amountMatches(5000, 4050)).toBe(false);
    expect(amountMatches(1, 1)).toBe(true);
  });
  it("reconoce la imagen por sus primeros bytes", () => {
    expect(sniffImage(PNG)).toBe("image/png");
    expect(sniffImage(JPG)).toBe("image/jpeg");
    expect(sniffImage(Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WEBP"), Buffer.alloc(8)]))).toBe("image/webp");
    expect(sniffImage(Buffer.from("<svg onload=alert(1)>"))).toBeNull();
    expect(sniffImage(Buffer.from("%PDF-1.4 ...."))).toBeNull();
    expect(sniffImage(new Uint8Array([0xff, 0xd8]))).toBeNull();
    expect(sniffImage(Buffer.concat([Buffer.from([0xff, 0x00, 0x00]), Buffer.alloc(50)]))).toBeNull();
    expect(sniffImage(Buffer.concat([Buffer.from([0xff, 0xd8, 0x00]), Buffer.alloc(50)]))).toBeNull();
    expect(sniffImage(Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x00, 0x00]), Buffer.alloc(50)]))).toBeNull();
    expect(sniffImage(Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x00, 0x1a, 0x0a]), Buffer.alloc(50)]))).toBeNull();
    expect(sniffImage(Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WAVE"), Buffer.alloc(8)]))).toBeNull();
    expect(sniffImage(Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WEBX"), Buffer.alloc(8)]))).toBeNull();
  });
});

describe("cotización", () => {
  it("Pago Móvil: el monto en Bs sale de la tasa del momento y queda congelado", async () => {
    const t = await register("quote");
    await setSettings({ rate: 40.5 });
    const id = await payId(t, "pago_movil", 2);
    const row = (await payments(t)).find((p) => p.id === id)!;
    expect(row.amountUsdCents).toBe(2000);
    expect(row.rate).toBe(40.5);
    expect(row.amountBsCents).toBe(81000); // 20,00 USD × 40,50
    expect(row.status).toBe("pendiente");
    const mins = (new Date(row.quoteExpiresAt).getTime() - Date.now()) / 60000;
    expect(mins).toBeGreaterThan(28);
    expect(mins).toBeLessThanOrEqual(30);
    await setSettings({ rate: 99 });
    const again = (await payments(t)).find((p) => p.id === id)!;
    expect(again.rate).toBe(40.5);
    expect(again.amountBsCents).toBe(81000);
    await setSettings();
  });
  it("redondea al céntimo", async () => {
    const t = await register("round");
    await setSettings({ rate: 36.1236 });
    const id = await payId(t, "pago_movil", 1);
    expect((await payments(t)).find((p) => p.id === id)!.amountBsCents).toBe(Math.round(1000 * 36.1236));
    await setSettings();
  });
  it("PayPal y Binance: sin tasa, 24 h para pagar", async () => {
    const t = await register("intl");
    const id = await payId(t, "paypal");
    const row = (await payments(t)).find((p) => p.id === id)!;
    expect(row.rate).toBeNull();
    expect(row.amountBsCents).toBeNull();
    expect((new Date(row.quoteExpiresAt).getTime() - Date.now()) / 3600000).toBeGreaterThan(23);
  });
  it("con la tasa de hace más de 36 h NO se cotiza en bolívares", async () => {
    const t = await register("stale");
    await owner.query("UPDATE platform_settings SET bcv_rate_at = now() - interval '37 hours'");
    const r = await pay(t, "pago_movil");
    expect(r.status).toBe(409);
    expect((await r.json()).error).toBe("tasa_desactualizada");
    expect((await pay(t, "paypal")).status).toBe(201);
    expect((await (await billingGet(req("GET", "/api/billing", t.cookie))).json()).payee.rateFresh).toBe(false);
    await owner.query("UPDATE platform_settings SET bcv_rate_at = now() - interval '35 hours'");
    expect((await (await billingGet(req("GET", "/api/billing", t.cookie))).json()).payee.rateFresh).toBe(true);
    expect((await pay(t, "pago_movil")).status).toBe(201);
    await setSettings();
  });
  it("sin tasa o sin datos del método, ese método no está disponible", async () => {
    const t = await register("nometh");
    await setSettings({ rate: null });
    expect((await pay(t, "pago_movil")).status).toBe(409);
    await setSettings({ pmPhone: "", paypal: "", binance: "" });
    for (const m of ["pago_movil", "paypal", "binance"] as const) {
      const r = await pay(t, m);
      expect(r.status).toBe(409);
      expect(["metodo_no_disponible", "tasa_desactualizada"]).toContain((await r.json()).error);
    }
    await setSettings();
  });
  it("planes sin precio o inactivos no se pueden comprar; meses fuera de rango no pasan", async () => {
    const t = await register("badplan");
    const free = await owner.query<{ id: string }>("INSERT INTO plans (slug, name, position, max_members, modules) VALUES ($1,'Sin precio',96,2,'{}') RETURNING id", [`bl-free-${RUN}`]);
    planIds.push(free.rows[0]!.id);
    expect((await pay(t, "paypal", 1, free.rows[0]!.id)).status).toBe(404);
    expect((await pay(t, "paypal", 1, randomUUID())).status).toBe(404);
    expect((await pay(t, "paypal", 0)).status).toBe(400);
    expect((await pay(t, "paypal", 13)).status).toBe(400);
    expect((await billingPay(req("POST", "/api/billing/pay", t.cookie, { planId, months: 1, method: "efectivo" }))).status).toBe(400);
    await owner.query("UPDATE plans SET active = false WHERE id = $1", [planId]);
    expect((await pay(t, "paypal")).status).toBe(404);
    await owner.query("UPDATE plans SET active = true WHERE id = $1", [planId]);
  });
  it("máximo 3 pagos abiertos por negocio", async () => {
    const t = await register("max3");
    for (let i = 0; i < 3; i++) await payId(t, "paypal");
    const r = await pay(t, "paypal");
    expect(r.status).toBe(409);
    expect((await r.json()).error).toBe("demasiados_pagos");
  });
  it("las cotizaciones sin comprobante que pasaron el plazo se cierran y liberan cupo", async () => {
    const t = await register("expire-q");
    const ids = [await payId(t, "paypal"), await payId(t, "paypal"), await payId(t, "paypal")];
    await owner.query("UPDATE payments SET quote_expires_at = now() - interval '7 hours' WHERE id = ANY($1)", [ids]);
    expect((await pay(t, "paypal")).status).toBe(201);
    const list = await payments(t);
    expect(list.filter((p) => p.status === "vencido")).toHaveLength(3);
  });
  it("la lista de planes solo trae los que tienen precio y están activos", async () => {
    const t = await register("offers");
    const d = await (await billingGet(req("GET", "/api/billing", t.cookie))).json();
    expect(d.offers.map((o: { id: string }) => o.id)).toContain(planId);
    expect(d.offers.every((o: { priceUsdCents: number }) => o.priceUsdCents > 0)).toBe(true);
    expect(d.payee.pagoMovil.telefono).toBe("0414-1234567");
    expect(d.payee.rateFresh).toBe(true);
  });
});

describe("permisos", () => {
  it("sin sesión no se ve ni se paga; el origen se revisa", async () => {
    expect((await billingGet(req("GET", "/api/billing"))).status).toBe(401);
    const t = await register("origin");
    const bad = new Request(`${ORIGIN}/api/billing/pay`, { method: "POST", headers: { origin: "https://malo.test", "content-type": "application/json", cookie: t.cookie }, body: JSON.stringify({ planId, months: 1, method: "paypal" }) });
    expect((await billingPay(bad)).status).toBe(403);
  });
  it("solo el dueño paga: un admin del equipo o una persona de otro negocio no pueden", async () => {
    const a = await register("own-a");
    const b = await register("own-b");
    const bUser = (await owner.query<{ id: string }>("SELECT id FROM users WHERE email = $1", [`bl-${RUN}-own-b@example.test`])).rows[0]!.id;
    const call = (cookie: string, tenant: string) => getPool().query("SELECT payment_create($1,$2,$3,1,'paypal')", [hash(cookie), tenant, planId]);
    await expect(call(b.cookie, a.tenantId)).rejects.toMatchObject({ code: "42501" }); // no es miembro
    await owner.query("INSERT INTO memberships (tenant_id, user_id, role) VALUES ($1,$2,'admin')", [a.tenantId, bUser]);
    await expect(call(b.cookie, a.tenantId)).rejects.toMatchObject({ code: "42501" }); // admin, no dueño
    await expect(getPool().query("SELECT payment_payee($1,$2)", [hash(b.cookie), a.tenantId])).rejects.toMatchObject({ code: "42501" });
    await expect(getPool().query("SELECT payment_submit($1,$2,$3,'ABCD1234',NULL,NULL,CURRENT_DATE,100,$4,'image/png')", [hash(b.cookie), a.tenantId, randomUUID(), PNG])).rejects.toMatchObject({ code: "42501" });
    await owner.query("UPDATE memberships SET role = 'agent' WHERE tenant_id = $1 AND user_id = $2", [a.tenantId, bUser]);
    await expect(call(b.cookie, a.tenantId)).rejects.toMatchObject({ code: "42501" });
    await owner.query("DELETE FROM memberships WHERE tenant_id = $1 AND user_id = $2", [a.tenantId, bUser]);
    await expect(call(a.cookie, a.tenantId)).resolves.toBeDefined(); // el dueño sí
  });
  it("un negocio no ve los pagos de otro y no puede tocar la tabla", async () => {
    const a = await register("iso-a");
    const b = await register("iso-b");
    const id = await payId(a, "paypal");
    expect((await payments(b)).map((p) => p.id)).not.toContain(id);
    await expect(withTenant(b.tenantId, (db) => db.query("SELECT proof FROM payments"))).rejects.toMatchObject({ code: "42501" });
    await expect(withTenant(b.tenantId, (db) => db.query("SELECT * FROM payments"))).rejects.toMatchObject({ code: "42501" });
    await expect(withTenant(a.tenantId, (db) => db.query("UPDATE payments SET status = 'confirmado' WHERE id = $1", [id]))).rejects.toMatchObject({ code: "42501" });
    await expect(withTenant(a.tenantId, (db) => db.query("INSERT INTO payments (tenant_id, plan_id, months, method, amount_usd_cents, quote_expires_at) VALUES ($1,$2,1,'paypal',100,now())", [a.tenantId, planId]))).rejects.toMatchObject({ code: "42501" });
    await expect(withTenant(a.tenantId, (db) => db.query("SELECT * FROM platform_settings"))).rejects.toMatchObject({ code: "42501" });
    const own = await withTenant(a.tenantId, async (db) => (await db.query("SELECT id, status FROM payments WHERE id = $1", [id])).rows);
    expect(own).toHaveLength(1);
  });
  it("el negocio no puede cambiar su vencimiento ni su plan por su cuenta", async () => {
    const t = await register("guard");
    await expect(withTenant(t.tenantId, (db) => db.query("UPDATE tenants SET plan_expires_at = now() + interval '5 years' WHERE id = $1", [t.tenantId]))).rejects.toMatchObject({ code: "42501" });
  });
  it("las rutas del súper admin responden 404 a todos los demás", async () => {
    const t = await register("noadmin");
    const id = await payId(t, "paypal");
    expect((await adminPayments(req("GET", "/api/admin/payments", t.cookie))).status).toBe(404);
    expect((await adminPayments(req("GET", "/api/admin/payments"))).status).toBe(404);
    expect((await adminProof(req("GET", `/api/admin/payments/proof?id=${id}`, t.cookie))).status).toBe(404);
    expect((await decide(id, true)).status).not.toBe(404);
    expect((await adminDecide(req("POST", "/api/admin/payments/decide", t.cookie, { paymentId: id, approve: true }))).status).toBe(404);
    expect((await settingsGet(req("GET", "/api/admin/billing-settings", t.cookie))).status).toBe(404);
    expect((await settingsPost(req("POST", "/api/admin/billing-settings", t.cookie, SETTINGS))).status).toBe(404);
    expect((await planPrice(req("POST", "/api/admin/plan-price", t.cookie, { planId, priceCents: 1 }))).status).toBe(404);
  });
});

describe("enviar el comprobante", () => {
  it("camino feliz: queda por revisar con todos los datos", async () => {
    const t = await register("sub-ok");
    const id = await payId(t);
    const r = await submit(t, id, { reference: "ab-1234 5678", declared: "40,50" });
    expect(r.status).toBe(200);
    const row = (await payments(t)).find((p) => p.id === id)!;
    expect(row.status).toBe("por_revisar");
    expect(row.reference).toBe("AB12345678"); // sin símbolos, en mayúsculas
    expect(row.declaredCents).toBe(4050);
    expect(row.paidOn).toBe(today());
    expect(row).not.toHaveProperty("proof");
    const stored = await owner.query("SELECT proof, proof_mime FROM payments WHERE id = $1", [id]);
    expect(Buffer.compare(stored.rows[0].proof, PNG)).toBe(0);
    expect(stored.rows[0].proof_mime).toBe("image/png");
  });
  it("rechaza datos malos con 400", async () => {
    const t = await register("sub-bad");
    const id = await payId(t);
    const cases: Array<[string, Record<string, unknown>]> = [
      ["referencia corta", { reference: "ab" }],
      ["referencia con solo símbolos", { reference: "!!!!----" }],
      ["fecha futura", { paidOn: new Date(Date.now() + 3 * 86400000).toISOString().slice(0, 10) }],
      ["fecha de hace 5 días", { paidOn: daysAgo(5) }],
      ["fecha mal escrita", { paidOn: "ayer" }],
      ["monto ilegible", { declared: "mucho" }],
      ["monto cero", { declared: "0" }],
      ["sin banco (Pago Móvil)", { bank: "" }],
      ["sin teléfono (Pago Móvil)", { phone: "" }],
      ["imagen vacía", { proof: "" }],
      ["no es base64", { proof: "esto no es base64 ".repeat(20) }],
      ["texto disfrazado de imagen", { proof: Buffer.from("<script>alert(1)</script>".repeat(10)).toString("base64") }],
      ["SVG", { proof: Buffer.from("<svg xmlns='http://www.w3.org/2000/svg' onload='alert(1)'>" + " ".repeat(100) + "</svg>").toString("base64") }],
      ["PDF", { proof: Buffer.from("%PDF-1.4" + " ".repeat(200)).toString("base64") }],
    ];
    for (const [name, o] of cases) {
      const r = await submit(t, id, o);
      expect(r.status, name).toBe(400);
    }
    expect((await payments(t)).find((p) => p.id === id)!.status).toBe("pendiente");
  });
  it("imagen de más de 2 MB: 413", async () => {
    const t = await register("sub-big");
    const id = await payId(t);
    const big = Buffer.concat([PNG, Buffer.alloc(2 * 1024 * 1024)]);
    const r = await submit(t, id, { proof: big.toString("base64") });
    expect(r.status).toBe(413);
  });
  it("JPG también vale; en PayPal no hacen falta banco ni teléfono", async () => {
    const t = await register("sub-jpg");
    const id = await payId(t, "paypal");
    expect((await submit(t, id, { bank: "", phone: "", proof: JPG.toString("base64"), declared: "10" })).status).toBe(200);
    const r = await owner.query("SELECT proof_mime FROM payments WHERE id = $1", [id]);
    expect(r.rows[0].proof_mime).toBe("image/jpeg");
  });
  it("no se envía dos veces ni se envía algo que no existe o es de otro negocio", async () => {
    const t = await register("sub-twice");
    const other = await register("sub-other");
    const id = await payId(t);
    expect((await submit(t, id)).status).toBe(200);
    expect((await submit(t, id)).status).toBe(409);
    expect((await submit(t, randomUUID())).status).toBe(404);
    expect((await submit(other, id)).status).toBe(404);
  });
  it("la misma referencia no sirve dos veces (ni en otro negocio) mientras esté en revisión o confirmada", async () => {
    const a = await register("ref-a");
    const b = await register("ref-b");
    const ida = await payId(a);
    const idb = await payId(b);
    expect((await submit(a, ida, { reference: "REPETIDA9999" })).status).toBe(200);
    const r = await submit(b, idb, { reference: "repetida-9999" });
    expect(r.status).toBe(409);
    expect((await r.json()).error).toBe("referencia_repetida");
    // Otro método con la misma referencia sí es otro pago distinto.
    const idc = await payId(b, "paypal");
    expect((await submit(b, idc, { reference: "REPETIDA9999" })).status).toBe(200);
    // Si se rechaza, la referencia se libera.
    const pend = (await adminPayments(req("GET", "/api/admin/payments", admin)));
    expect(pend.status).toBe(200);
    expect((await decide(ida, false, "No aparece en el banco")).status).toBe(200);
    expect((await submit(b, idb, { reference: "REPETIDA9999" })).status).toBe(200);
  });
  it("pasada la cotización sigue valiendo 6 h; después ya no", async () => {
    const t = await register("sub-late");
    const id = await payId(t);
    await owner.query("UPDATE payments SET quote_expires_at = now() - interval '5 hours' WHERE id = $1", [id]);
    expect((await submit(t, id)).status).toBe(200);
    const id2 = await payId(t, "paypal");
    await owner.query("UPDATE payments SET quote_expires_at = now() - interval '7 hours' WHERE id = $1", [id2]);
    expect((await submit(t, id2)).status).toBe(400);
    await getPool().query("SELECT expire_subscriptions()");
    expect((await payments(t)).find((p) => p.id === id2)!.status).toBe("vencido");
  });
});

describe("revisión del súper admin", () => {
  const find = async (id: string, status = "por_revisar") => ((await (await adminPayments(req("GET", `/api/admin/payments?status=${status}`, admin))).json()).payments as Array<Record<string, unknown>>).find((p) => p.id === id);

  it("la cola muestra datos del pago, del negocio y si hay imagen; sin la imagen dentro", async () => {
    const t = await register("rev-list");
    const id = await payId(t);
    expect(await find(id)).toBeUndefined();
    await submit(t, id, { reference: "COLA00001111" });
    const p = (await find(id))!;
    expect(p).toMatchObject({ tenantName: "Negocio rev-list", planName: "Plan cobro", method: "pago_movil", amountBsCents: 40500, declaredCents: 4050, hasProof: true, reference: "COLA00001111", payerBank: "0134 Banesco" });
    expect(JSON.stringify(p)).not.toContain("proof\"");
    expect(await find(id, "confirmado")).toBeUndefined();
  });
  it("la imagen se sirve con tipo fijo y cabeceras de seguridad", async () => {
    const t = await register("rev-img");
    const id = await payId(t);
    await submit(t, id, { proof: JPG.toString("base64") });
    const r = await adminProof(req("GET", `/api/admin/payments/proof?id=${id}`, admin));
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toBe("image/jpeg");
    expect(r.headers.get("x-content-type-options")).toBe("nosniff");
    expect(r.headers.get("content-security-policy")).toContain("sandbox");
    expect(r.headers.get("cache-control")).toContain("no-store");
    expect(Buffer.compare(Buffer.from(await r.arrayBuffer()), JPG)).toBe(0);
    expect((await adminProof(req("GET", "/api/admin/payments/proof?id=../../etc/passwd", admin))).status).toBe(404);
    expect((await adminProof(req("GET", `/api/admin/payments/proof?id=${randomUUID()}`, admin))).status).toBe(404);
  });
  it("confirmar activa el plan, pone 30 días por mes y deja el negocio activo", async () => {
    const t = await register("rev-ok");
    const id = await payId(t, "pago_movil", 3);
    await submit(t, id);
    const before = await tenantRow(t);
    expect(before.status).toBe("trial");
    expect((await decide(id, true)).status).toBe(200);
    const after = await tenantRow(t);
    expect(after.plan_id).toBe(planId);
    expect(after.status).toBe("active");
    const days = (new Date(after.plan_expires_at).getTime() - Date.now()) / 86400000;
    expect(days).toBeGreaterThan(89.9);
    expect(days).toBeLessThan(90.1);
    const row = (await payments(t)).find((p) => p.id === id)!;
    expect(row.status).toBe("confirmado");
    const a = await withTenant(t.tenantId, async (db) => (await db.query("SELECT action FROM audit_log WHERE tenant_id = $1 AND action LIKE 'billing.%'", [t.tenantId])).rows);
    expect(a.map((x) => x.action)).toContain("billing.payment.confirm");
  });
  it("renovar el mismo plan suma sobre lo que queda; cambiar de plan empieza hoy", async () => {
    const t = await register("rev-renew");
    const i1 = await payId(t, "paypal", 1);
    await submit(t, i1, { declared: "10" });
    await decide(i1, true);
    const first = new Date((await tenantRow(t)).plan_expires_at).getTime();
    const i2 = await payId(t, "paypal", 1);
    await submit(t, i2, { declared: "10" });
    await decide(i2, true);
    const second = new Date((await tenantRow(t)).plan_expires_at).getTime();
    expect(Math.round((second - first) / 86400000)).toBe(30);
    // Otro plan: empieza desde hoy, no suma lo que quedaba.
    const p2 = await owner.query<{ id: string }>("INSERT INTO plans (slug, name, position, max_members, modules, price_usd_cents) VALUES ($1,'Otro',95,2,'{}',500) RETURNING id", [`bl-otro-${RUN}`]);
    planIds.push(p2.rows[0]!.id);
    const r = await pay(t, "paypal", 1, p2.rows[0]!.id);
    const i3 = (await r.json()).paymentId as string;
    await submit(t, i3, { declared: "5" });
    await decide(i3, true);
    const third = await tenantRow(t);
    expect(third.plan_id).toBe(p2.rows[0]!.id);
    expect((new Date(third.plan_expires_at).getTime() - Date.now()) / 86400000).toBeLessThan(30.1);
  });
  it("una cuenta suspendida sigue suspendida aunque se confirme el pago", async () => {
    const t = await register("rev-susp");
    const id = await payId(t, "paypal");
    await submit(t, id, { declared: "10" });
    await owner.query("SELECT set_config('app.tenant_id', $1, false)", [t.tenantId]);
    const c = await owner.connect();
    try { await c.query("SELECT set_config('app.tenant_id', $1, false)", [t.tenantId]); await c.query("UPDATE tenants SET status = 'suspended' WHERE id = $1", [t.tenantId]); await c.query("SELECT set_config('app.tenant_id', '', false)"); } finally { c.release(); }
    await decide(id, true);
    expect((await tenantRow(t)).status).toBe("suspended");
  });
  it("rechazar exige motivo, no cambia el plan y el negocio ve el motivo", async () => {
    const t = await register("rev-no");
    const id = await payId(t);
    await submit(t, id);
    const before = await tenantRow(t);
    expect((await adminDecide(req("POST", "/api/admin/payments/decide", admin, { paymentId: id, approve: false }))).status).toBe(400);
    expect((await decide(id, false, "   ")).status).not.toBe(200);
    expect((await decide(id, false, "El monto no coincide")).status).toBe(200);
    const row = (await payments(t)).find((p) => p.id === id)!;
    expect(row.status).toBe("rechazado");
    expect(row.rejectReason).toBe("El monto no coincide");
    const after = await tenantRow(t);
    expect(after.plan_id).toBe(before.plan_id);
    expect(after.plan_expires_at).toBeNull();
  });
  it("un estado desconocido en la cola vuelve a «por revisar»", async () => {
    const t = await register("rev-unk");
    const id = await payId(t);
    await submit(t, id, { reference: "DESCONOCIDO01" });
    const r = await (await adminPayments(req("GET", "/api/admin/payments?status=loquesea", admin))).json();
    expect(r.payments.map((p: { id: string }) => p.id)).toContain(id);
    expect(r.payments.every((p: { status: string }) => p.status === "por_revisar")).toBe(true);
  });
  it("las funciones también se defienden solas (sin pasar por las rutas)", async () => {
    const t = await register("rev-sql");
    const id = await payId(t);
    await submit(t, id, { reference: "SOLOSQL00001" });
    const h = hash(admin);
    await expect(getPool().query("SELECT admin_payment_decide($1,$2,false,'  ')", [h, id])).rejects.toMatchObject({ code: "22023" });
    await expect(getPool().query("SELECT admin_payment_decide($1,$2,false,NULL)", [h, id])).rejects.toMatchObject({ code: "22023" });
    await expect(getPool().query("SELECT payment_create($1,$2,$3,0,'paypal')", [hash(t.cookie), t.tenantId, planId])).rejects.toMatchObject({ code: "22023" });
    await expect(getPool().query("SELECT payment_create($1,$2,$3,13,'paypal')", [hash(t.cookie), t.tenantId, planId])).rejects.toMatchObject({ code: "22023" });
    await expect(getPool().query("SELECT admin_set_payment_settings($1,-5,'a','b','c','d','e','f','g')", [h])).rejects.toMatchObject({ code: "22023" });
    await expect(getPool().query("SELECT admin_set_payment_settings($1,0,'a','b','c','d','e','f','g')", [h])).rejects.toMatchObject({ code: "22023" });
    await expect(getPool().query("SELECT admin_set_payment_settings($1,1000000000,'a','b','c','d','e','f','g')", [h])).rejects.toMatchObject({ code: "22023" });
    await expect(getPool().query("SELECT admin_set_plan_price($1,$2,0)", [h, planId])).rejects.toMatchObject({ code: "22023" });
    // quien no es súper admin no puede llamar a las funciones de admin
    await expect(getPool().query("SELECT admin_payment_decide($1,$2,true,NULL)", [hash(t.cookie), id])).rejects.toMatchObject({ code: "42501" });
    await expect(getPool().query("SELECT * FROM admin_list_payments($1,NULL)", [hash(t.cookie)])).rejects.toMatchObject({ code: "42501" });
    await expect(getPool().query("SELECT * FROM admin_payment_proof($1,$2)", [hash(t.cookie), id])).rejects.toMatchObject({ code: "42501" });
    await expect(getPool().query("SELECT admin_get_payment_settings($1)", [hash(t.cookie)])).rejects.toMatchObject({ code: "42501" });
  });
  it("un pago se decide una sola vez y solo si está por revisar", async () => {
    const t = await register("rev-once");
    const id = await payId(t);
    expect((await decide(id, true)).status).toBe(409); // aún sin comprobante
    await submit(t, id);
    expect((await decide(id, true)).status).toBe(200);
    expect((await decide(id, true)).status).toBe(409);
    expect((await decide(id, false, "x")).status).toBe(409);
    expect((await decide(randomUUID(), true)).status).toBe(404);
  });
});

describe("datos de cobro y precios", () => {
  it("guarda y lee la configuración; la fecha de la tasa se renueva al guardar", async () => {
    await owner.query("UPDATE platform_settings SET bcv_rate_at = now() - interval '3 days'");
    await setSettings({ rate: 41.25, notes: "Pago de lunes a viernes" });
    const s = (await (await settingsGet(req("GET", "/api/admin/billing-settings", admin))).json()).settings;
    expect(Number(s.bcv_rate)).toBe(41.25);
    expect(s.notes).toBe("Pago de lunes a viernes");
    expect(Date.now() - new Date(s.bcv_rate_at).getTime()).toBeLessThan(60000);
    await setSettings();
  });
  it("rechaza tasas absurdas y vacía los campos en blanco", async () => {
    expect((await settingsPost(req("POST", "/api/admin/billing-settings", admin, { ...SETTINGS, rate: -1 }))).status).toBe(400);
    expect((await settingsPost(req("POST", "/api/admin/billing-settings", admin, { ...SETTINGS, rate: 0 }))).status).toBe(400);
    await setSettings({ paypal: "   " });
    expect((await (await settingsGet(req("GET", "/api/admin/billing-settings", admin))).json()).settings.paypal_email).toBeNull();
    await setSettings();
  });
  it("el precio de un plan se cambia y se quita", async () => {
    const p = await owner.query<{ id: string }>("INSERT INTO plans (slug, name, position, max_members, modules) VALUES ($1,'Precio',94,2,'{}') RETURNING id", [`bl-precio-${RUN}`]);
    planIds.push(p.rows[0]!.id);
    expect((await planPrice(req("POST", "/api/admin/plan-price", admin, { planId: p.rows[0]!.id, priceCents: 2500 }))).status).toBe(200);
    expect((await owner.query("SELECT price_usd_cents FROM plans WHERE id = $1", [p.rows[0]!.id])).rows[0].price_usd_cents).toBe(2500);
    expect((await planPrice(req("POST", "/api/admin/plan-price", admin, { planId: p.rows[0]!.id, priceCents: null }))).status).toBe(200);
    expect((await owner.query("SELECT price_usd_cents FROM plans WHERE id = $1", [p.rows[0]!.id])).rows[0].price_usd_cents).toBeNull();
    expect((await planPrice(req("POST", "/api/admin/plan-price", admin, { planId: p.rows[0]!.id, priceCents: 0 }))).status).toBe(400);
    expect((await planPrice(req("POST", "/api/admin/plan-price", admin, { planId: randomUUID(), priceCents: 100 }))).status).toBe(404);
  });
});

describe("vencimientos", () => {
  it("quien no renovó pasa a «pago pendiente»; los de prueba y los activados a mano no se tocan", async () => {
    const venc = await register("exp-a");
    const manual = await register("exp-b");
    const trial = await register("exp-c");
    const vigente = await register("exp-d");
    const setT = async (t: T, status: string, exp: string | null) => {
      const c = await owner.connect();
      try {
        await c.query("BEGIN");
        await c.query("SELECT set_config('app.tenant_id', $1, true)", [t.tenantId]);
        await c.query("ALTER TABLE tenants DISABLE TRIGGER tenants_plan_guard");
        await c.query(`UPDATE tenants SET status = $2, plan_expires_at = ${exp ?? "NULL"} WHERE id = $1`, [t.tenantId, status]);
        await c.query("ALTER TABLE tenants ENABLE TRIGGER tenants_plan_guard");
        await c.query("COMMIT");
      } catch (e) { await c.query("ROLLBACK"); throw e; } finally { c.release(); }
    };
    await setT(venc, "active", "now() - interval '1 minute'");
    await setT(manual, "active", null);
    await setT(trial, "trial", "now() - interval '1 day'");
    await setT(vigente, "active", "now() + interval '1 day'");
    const n = Number((await getPool().query("SELECT expire_subscriptions() AS n")).rows[0].n);
    expect(n).toBeGreaterThanOrEqual(1);
    expect((await tenantRow(venc)).status).toBe("past_due");
    expect((await tenantRow(manual)).status).toBe("active");
    expect((await tenantRow(trial)).status).toBe("trial");
    expect((await tenantRow(vigente)).status).toBe("active");
    const again = Number((await getPool().query("SELECT expire_subscriptions() AS n")).rows[0].n);
    expect(again).toBe(0);
    // Pagar de nuevo lo reactiva.
    const id = await payId(venc, "paypal");
    await submit(venc, id, { declared: "10" });
    await decide(id, true);
    expect((await tenantRow(venc)).status).toBe("active");
  });
  it("los días que quedan salen en /api/billing", async () => {
    const t = await register("exp-days");
    const id = await payId(t, "paypal");
    await submit(t, id, { declared: "10" });
    await decide(id, true);
    const d = await (await billingGet(req("GET", "/api/billing", t.cookie))).json();
    expect(d.subscription.status).toBe("active");
    expect(d.subscription.daysLeft).toBe(30);
    expect(d.subscription.planName).toBe("Plan cobro");
  });
});
