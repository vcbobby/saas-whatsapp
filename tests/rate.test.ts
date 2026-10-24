import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { POST as settingsPost } from "@/app/api/admin/billing-settings/route";
import { GET as rateGet, POST as ratePost } from "@/app/api/admin/rate/route";
import { POST as login } from "@/app/api/auth/login/route";
import { POST as verify2fa } from "@/app/api/auth/2fa/verify/route";
import { POST as signup } from "@/app/api/auth/signup/route";
import { GET as me } from "@/app/api/me/route";
import { hashPassword } from "@/lib/auth/password";
import { getPool } from "@/lib/db";
import { getRateSources } from "@/lib/env";
import { refreshRate } from "@/lib/billing/rate-refresh";
import { RateSourceError, SOURCES, fetchSource, parseBcvHtml, parseDolarApi, parseVeNumber, type SourceDef } from "@/lib/billing/rate-source";
import { codeFor, enableMfaDirect } from "./mfa-helpers";

const RUN = randomUUID().slice(0, 8);
const ORIGIN = new URL(process.env.APP_URL!).origin;
const PASSWORD = "contraseña-de-prueba-123";
const owner = new Pool({ connectionString: process.env.MIGRATION_DATABASE_URL, max: 2 });
const STARTED = new Date(Date.now() - 1000);
let admin = "";
let customer = "";
let customerTenant = "";
let saved: Record<string, unknown> = {};

const req = (method: string, path: string, cookie?: string, body?: unknown) =>
  new Request(`${ORIGIN}${path}`, { method, headers: { origin: ORIGIN, ...(body !== undefined ? { "content-type": "application/json" } : {}), ...(cookie ? { cookie } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
const cookieOf = (res: Response) => (res.headers.get("set-cookie") ?? "").split(";")[0]!;

async function makeSuperAdmin() {
  const addr = `rt-${RUN}-admin@example.test`;
  const ins = await owner.query<{ id: string }>("INSERT INTO users (email, password_hash, is_super_admin) VALUES ($1,$2,true) RETURNING id", [addr, await hashPassword(PASSWORD)]);
  const secret = await enableMfaDirect(owner, ins.rows[0]!.id);
  const res = await login(req("POST", "/api/auth/login", undefined, { email: addr, password: PASSWORD }));
  const ver = await verify2fa(req("POST", "/api/auth/2fa/verify", cookieOf(res), { code: codeFor(secret) }));
  expect(ver.status).toBe(200);
  return cookieOf(ver);
}

const state = async () => (await owner.query("SELECT bcv_rate::float AS rate, bcv_rate_at, rate_mode, rate_source, rate_last_ok_at, rate_last_error, rate_last_attempt_at FROM platform_settings")).rows[0]!;
const history = async () => (await getPool().query<{ h_rate: string; h_kind: string; h_source: string }>("SELECT * FROM admin_rate_history($1)", [await tokenHash()])).rows;
async function tokenHash() {
  const { tokenHashOf } = await import("@/lib/auth/session");
  return tokenHashOf(req("GET", "/", admin))!;
}
const setRate = (rate: number | null, mode: "auto" | "manual" = "auto") =>
  owner.query("UPDATE platform_settings SET bcv_rate = $1, bcv_rate_at = CASE WHEN $1::numeric IS NULL THEN NULL ELSE now() END, rate_mode = $2, rate_last_error = NULL", [rate, mode]);
const src = (name: "dolarapi" | "bcv"): SourceDef => SOURCES[name];
const reading = (rate: number) => ({ rate, publishedAt: null });
const SETTINGS = { rate: 40.5, pmBank: "0102 Banco de Venezuela", pmPhone: "0414-1234567", pmHolderId: "J-12345678-9", pmHolderName: "Mi Empresa C.A.", paypal: "pagos@example.test", binance: "123456789", notes: "" };

beforeAll(async () => {
  saved = (await owner.query("SELECT * FROM platform_settings")).rows[0]!;
  admin = await makeSuperAdmin();
  const r = await signup(req("POST", "/api/auth/signup", undefined, { email: `rt-${RUN}-cli@example.test`, password: PASSWORD, businessName: `Tasa ${RUN}` }));
  customer = cookieOf(r);
  customerTenant = (await (await me(req("GET", "/api/me", customer))).json()).tenant.id;
});

afterAll(async () => {
  const s = saved as Record<string, unknown>;
  await owner.query(
    "UPDATE platform_settings SET bcv_rate=$1, bcv_rate_at=$2, pm_bank=$3, pm_phone=$4, pm_holder_id=$5, pm_holder_name=$6, paypal_email=$7, binance_id=$8, notes=$9, rate_mode=$10, rate_source=$11, rate_last_attempt_at=$12, rate_last_ok_at=$13, rate_last_error=$14",
    [s.bcv_rate, s.bcv_rate_at, s.pm_bank, s.pm_phone, s.pm_holder_id, s.pm_holder_name, s.paypal_email, s.binance_id, s.notes, s.rate_mode, s.rate_source, s.rate_last_attempt_at, s.rate_last_ok_at, s.rate_last_error]);
  // El historial de la tasa no se puede borrar desde la aplicación: la limpieza de pruebas levanta la protección un instante.
  await owner.query("ALTER TABLE rate_history NO FORCE ROW LEVEL SECURITY");
  try { await owner.query("DELETE FROM rate_history WHERE created_at >= $1", [STARTED]); } finally { await owner.query("ALTER TABLE rate_history FORCE ROW LEVEL SECURITY"); }
  await owner.query("DELETE FROM users WHERE email LIKE $1", [`rt-${RUN}-%`]);
  const c = await owner.connect();
  try {
    await c.query("BEGIN");
    await c.query("SELECT set_config('app.tenant_id', $1, true)", [customerTenant]);
    await c.query("ALTER TABLE audit_log DISABLE TRIGGER audit_log_sin_cambios");
    await c.query("DELETE FROM audit_log WHERE tenant_id = $1", [customerTenant]);
    await c.query("ALTER TABLE audit_log ENABLE TRIGGER audit_log_sin_cambios");
    await c.query("DELETE FROM tenants WHERE id = $1", [customerTenant]);
    await c.query("COMMIT");
  } catch (e) { await c.query("ROLLBACK"); throw e; } finally { c.release(); }
  await owner.end();
  await getPool().end();
});

describe("lectura de fuentes (funciones puras)", () => {
  const NOW = Date.parse("2026-10-24T12:00:00Z");
  it("DolarAPI: toma «promedio» (o «venta») y valida", () => {
    expect(parseDolarApi({ promedio: 301.37, fechaActualizacion: "2026-10-23T21:02:47.165Z" }, NOW)).toEqual({ rate: 301.37, publishedAt: new Date("2026-10-23T21:02:47.165Z") });
    expect(parseDolarApi({ promedio: null, venta: 40.55 }, NOW).rate).toBe(40.55);
    expect(parseDolarApi({ promedio: 40, venta: 41 }, NOW).rate).toBe(40); // «promedio» manda
    expect(parseDolarApi({ promedio: 36.123456 }, NOW).rate).toBe(36.1235);
    for (const bad of [null, "x", 5, [], {}, { promedio: 0 }, { promedio: -3 }, { promedio: "40,5" }, { promedio: NaN }, { promedio: Infinity }, { promedio: 1e9 }, { promedio: 0.001 }]) {
      expect(() => parseDolarApi(bad, NOW), JSON.stringify(bad)).toThrow(RateSourceError);
    }
    expect(() => parseDolarApi({ promedio: 40, fechaActualizacion: "no-es-fecha" }, NOW)).toThrow(/fecha/);
    expect(() => parseDolarApi({ promedio: 40, fechaActualizacion: "2026-10-01T00:00:00Z" }, NOW)).toThrow(/7 días/);
    expect(parseDolarApi({ promedio: 40, fechaActualizacion: "2026-10-18T13:00:00Z" }, NOW).rate).toBe(40);
  });
  it("números venezolanos: coma o punto decimal, con o sin miles", () => {
    const ok: Array<[string, number]> = [["301,37290000", 301.3729], ["1.234,56", 1234.56], ["36.5", 36.5], ["40", 40], [" 1.234.567,8 ", 1234567.8], ["1,234.56", 1234.56]];
    for (const [i, n] of ok) expect(parseVeNumber(i), i).toBeCloseTo(n, 6);
    for (const bad of ["", "abc", "-5", "1e5", "$40", ",5"]) expect(() => parseVeNumber(bad), bad).toThrow(RateSourceError);
  });
  it("página del BCV: lee el valor del bloque «dolar»", () => {
    const html = `<html><div id="euro"><strong> 400,00 </strong></div><div class="col-sm-6" id="dolar"><div class="field-content"><span> USD</span><div class="col-sm-6 centrado"><strong> 301,37290000 </strong></div></div></div></html>`;
    expect(parseBcvHtml(html).rate).toBe(301.3729); // NO el euro
    expect(() => parseBcvHtml("<html>nada</html>")).toThrow(/bloque/);
    expect(() => parseBcvHtml(`<div id="dolar">sin valor</div>`)).toThrow(/valor/);
    expect(() => parseBcvHtml(`<div id="dolar"><strong>0,00</strong></div>`)).toThrow(RateSourceError);
    expect(() => parseBcvHtml(`<div id="dolar"><strong>abc</strong></div>`)).toThrow();
  });
  it("fetchSource: tiempo límite, errores HTTP, tamaño y respuestas ilegibles dan error claro", async () => {
    const json = (rate: number) => async () => new Response(JSON.stringify({ promedio: rate }), { status: 200 });
    expect((await fetchSource(src("dolarapi"), json(40.5) as unknown as typeof fetch)).rate).toBe(40.5);
    await expect(fetchSource(src("dolarapi"), (async () => new Response("x", { status: 503 })) as unknown as typeof fetch)).rejects.toThrow(/503/);
    await expect(fetchSource(src("dolarapi"), (async () => { throw new Error("ECONNRESET"); }) as unknown as typeof fetch)).rejects.toThrow(/no respondió/);
    await expect(fetchSource(src("dolarapi"), (async () => new Response("<html>", { status: 200 })) as unknown as typeof fetch)).rejects.toThrow(/ilegible/);
    await expect(fetchSource(src("bcv"), (async () => new Response("a".repeat(1_600_000), { status: 200 })) as unknown as typeof fetch)).rejects.toThrow(/grande/);
    // Siempre sin seguir redirecciones y con límite de tiempo.
    const spy = vi.fn((...args: [unknown, RequestInit?]) => { void args; return Promise.resolve(new Response(JSON.stringify({ promedio: 40 }), { status: 200 })); });
    await fetchSource(src("dolarapi"), spy as unknown as typeof fetch);
    expect(spy.mock.calls[0]![1]).toMatchObject({ redirect: "error" });
    expect(spy.mock.calls[0]![1]!.signal).toBeInstanceOf(AbortSignal);
    expect(SOURCES.dolarapi.url.startsWith("https://")).toBe(true);
    expect(SOURCES.bcv.url.startsWith("https://")).toBe(true);
  });
  it("RATE_SOURCES: por defecto, con orden propio y rechaza nombres desconocidos", () => {
    const keep = process.env.RATE_SOURCES;
    try {
      delete process.env.RATE_SOURCES;
      expect(getRateSources()).toEqual(["dolarapi", "bcv"]);
      process.env.RATE_SOURCES = " BCV , dolarapi,bcv ";
      expect(getRateSources()).toEqual(["bcv", "dolarapi"]);
      process.env.RATE_SOURCES = "dolarapi,otra";
      expect(() => getRateSources()).toThrow(/otra/);
      process.env.RATE_SOURCES = " , ";
      expect(() => getRateSources()).toThrow();
    } finally { if (keep === undefined) delete process.env.RATE_SOURCES; else process.env.RATE_SOURCES = keep; }
  });
});

describe("aplicar la tasa", () => {
  it("modo manual (por defecto): no toca nada", async () => {
    await setRate(40, "manual");
    const read = vi.fn(async () => reading(41));
    expect(await refreshRate({ sources: [src("dolarapi")], read })).toEqual({ status: "skipped" });
    expect(read).not.toHaveBeenCalled();
    expect((await getPool().query("SELECT rate_apply_auto(55, 'x') AS s")).rows[0].s).toBe("manual");
    expect((await state()).rate).toBe(40);
  });

  it("modo automático: aplica, renueva la fecha aunque sea el mismo valor y anota el historial solo si cambió", async () => {
    await setRate(40);
    const before = (await history()).length;
    expect(await refreshRate({ sources: [src("dolarapi")], read: async () => reading(41.2) })).toMatchObject({ status: "ok", source: "dolarapi", rate: 41.2 });
    let s = await state();
    expect(s).toMatchObject({ rate: 41.2, rate_source: "dolarapi", rate_last_error: null });
    expect(Date.now() - new Date(s.rate_last_ok_at).getTime()).toBeLessThan(10_000);
    expect((await history()).length).toBe(before + 1);
    expect((await history())[0]).toMatchObject({ h_kind: "auto", h_source: "dolarapi" });
    // Mismo valor otra vez, con la fecha vieja: se renueva la fecha y NO se agrega historial.
    await owner.query("UPDATE platform_settings SET bcv_rate_at = now() - interval '30 hours'");
    await refreshRate({ sources: [src("dolarapi")], read: async () => reading(41.2) });
    s = await state();
    expect(Date.now() - new Date(s.bcv_rate_at).getTime()).toBeLessThan(10_000);
    expect((await history()).length).toBe(before + 1);
  });

  it("rechaza cambios de más de ±15 % (y no prueba otra fuente)", async () => {
    await setRate(40);
    const second = vi.fn(async () => reading(40.5));
    let calls = 0;
    const read = async (d: SourceDef) => { calls++; return d.name === "dolarapi" ? reading(46.1) : second(); };
    const r = await refreshRate({ sources: [src("dolarapi"), src("bcv")], read });
    expect(r).toMatchObject({ status: "rejected", rate: 46.1 });
    expect(calls).toBe(1);
    const s = await state();
    expect(s.rate).toBe(40);
    expect(s.rate_last_error).toMatch(/rechazado/i);
    expect((await history())[0]).toMatchObject({ h_kind: "rejected" });
    expect(Number((await history())[0]!.h_rate)).toBe(46.1);
    // Una lectura buena después limpia el aviso.
    expect(await refreshRate({ sources: [src("dolarapi")], read: async () => reading(40.3) })).toMatchObject({ status: "ok" });
    expect((await state()).rate_last_error).toBeNull();
  });

  it("los límites exactos: -15 % y +15 % pasan; un poco más, no", async () => {
    const q = async (from: number, to: number) => { await setRate(from); return (await getPool().query("SELECT rate_apply_auto($1, 't') AS s", [to])).rows[0].s as string; };
    expect(await q(40, 34)).toBe("ok");
    expect(await q(40, 46)).toBe("ok");
    expect(await q(40, 33.99)).toBe("rejected");
    expect(await q(40, 46.01)).toBe("rejected");
    expect(await q(40, 1)).toBe("rejected");
    expect(await q(40, 4000)).toBe("rejected");
  });

  it("sin tasa previa se acepta la primera lectura", async () => {
    await setRate(null);
    expect(await refreshRate({ sources: [src("dolarapi")], read: async () => reading(300) })).toMatchObject({ status: "ok" });
    expect((await state()).rate).toBe(300);
  });

  it("si la primera fuente falla usa la siguiente; si todas fallan deja el error y conserva la tasa", async () => {
    await setRate(40);
    const read = async (d: SourceDef) => { if (d.name === "dolarapi") throw new RateSourceError("dolarapi: no respondió"); return reading(40.8); };
    expect(await refreshRate({ sources: [src("dolarapi"), src("bcv")], read })).toMatchObject({ status: "ok", source: "bcv", rate: 40.8 });
    expect((await state()).rate_source).toBe("bcv");
    const fail = await refreshRate({ sources: [src("dolarapi"), src("bcv")], read: async (d) => { throw new RateSourceError(`${d.name}: caído`); } });
    expect(fail).toMatchObject({ status: "failed" });
    const s = await state();
    expect(s.rate).toBe(40.8);
    expect(s.rate_last_error).toMatch(/dolarapi: caído.*bcv: caído/);
    expect(await refreshRate({ sources: [], read: async () => reading(1) })).toMatchObject({ status: "failed" });
  });

  it("en modo manual los fallos no se anotan", async () => {
    await setRate(40, "manual");
    await getPool().query("SELECT rate_report_failure('algo')");
    expect((await state()).rate_last_error).toBeNull();
  });

  it("valores inválidos se rechazan en la base", async () => {
    await setRate(40);
    for (const bad of [0, -1, 1e9]) await expect(getPool().query("SELECT rate_apply_auto($1, 'x')", [bad])).rejects.toMatchObject({ code: "22023" });
    await expect(getPool().query("SELECT rate_apply_auto(40, '')")).rejects.toMatchObject({ code: "22023" });
    await expect(getPool().query("SELECT rate_apply_auto(NULL, 'x')")).rejects.toMatchObject({ code: "22023" });
  });

  it("la aplicación no puede leer ni escribir el historial directamente", async () => {
    await expect(getPool().query("SELECT * FROM rate_history")).rejects.toMatchObject({ code: "42501" });
    await expect(getPool().query("INSERT INTO rate_history (rate, source, kind) VALUES (1, 'x', 'auto')")).rejects.toMatchObject({ code: "42501" });
    await expect(getPool().query("UPDATE platform_settings SET rate_mode = 'auto'")).rejects.toMatchObject({ code: "42501" });
  });
});

describe("el admin manda", () => {
  it("cambiar de modo: solo súper admin, con valores válidos", async () => {
    await setRate(40, "manual");
    expect((await ratePost(req("POST", "/api/admin/rate", customer, { mode: "auto" }))).status).toBe(404);
    expect((await ratePost(req("POST", "/api/admin/rate", undefined, { mode: "auto" }))).status).toBe(404);
    expect((await rateGet(req("GET", "/api/admin/rate", customer))).status).toBe(404);
    expect((await ratePost(req("POST", "/api/admin/rate", admin, { mode: "otro" }))).status).toBe(400);
    expect((await ratePost(req("POST", "/api/admin/rate", admin, {}))).status).toBe(400);
    const foreign = await ratePost(new Request(`${ORIGIN}/api/admin/rate`, { method: "POST", headers: { origin: "https://malo.example", "content-type": "application/json", cookie: admin }, body: JSON.stringify({ mode: "auto" }) }));
    expect(foreign.status).toBeGreaterThanOrEqual(400);
    expect((await state()).rate_mode).toBe("manual");
    expect((await ratePost(req("POST", "/api/admin/rate", admin, { mode: "auto" }))).status).toBe(200);
    expect((await state()).rate_mode).toBe("auto");
    const h = await (await rateGet(req("GET", "/api/admin/rate", admin))).json();
    expect(Array.isArray(h.history)).toBe(true);
    expect((await ratePost(req("POST", "/api/admin/rate", admin, { mode: "manual" }))).status).toBe(200);
    expect((await state()).rate_mode).toBe("manual");
  });

  it("las funciones de la base exigen súper admin por sí mismas (sin pasar por la ruta)", async () => {
    const { tokenHashOf } = await import("@/lib/auth/session");
    const cust = tokenHashOf(req("GET", "/", customer))!;
    await setRate(40, "manual");
    await expect(getPool().query("SELECT admin_set_rate_mode($1, 'auto')", [cust])).rejects.toBeTruthy();
    await expect(getPool().query("SELECT * FROM admin_rate_history($1)", [cust])).rejects.toBeTruthy();
    await expect(getPool().query("SELECT admin_set_rate_mode($1, 'otro')", [await tokenHash()])).rejects.toMatchObject({ code: "22023" });
    expect((await state()).rate_mode).toBe("manual");
  });

  it("escribir a mano una tasa distinta apaga la automática y queda en el historial; guardar los demás datos no", async () => {
    await setRate(40, "auto");
    // Mismo valor (solo se cambian datos de cobro): sigue automática y no hay historial nuevo.
    const n0 = (await history()).length;
    expect((await settingsPost(req("POST", "/api/admin/billing-settings", admin, { ...SETTINGS, rate: 40, notes: "otra nota" }))).status).toBe(200);
    expect((await state()).rate_mode).toBe("auto");
    expect((await history()).length).toBe(n0);
    // Valor distinto: pasa a manual, queda anotado y la automática ya no lo pisa.
    expect((await settingsPost(req("POST", "/api/admin/billing-settings", admin, { ...SETTINGS, rate: 52.5 }))).status).toBe(200);
    const s = await state();
    expect(s).toMatchObject({ rate: 52.5, rate_mode: "manual", rate_source: "admin" });
    expect((await history())[0]).toMatchObject({ h_kind: "manual", h_source: "admin" });
    expect(await refreshRate({ sources: [src("dolarapi")], read: async () => reading(53) })).toEqual({ status: "skipped" });
    expect((await state()).rate).toBe(52.5);
  });

  it("el administrador puede confirmar a mano un salto que la automática había rechazado", async () => {
    await setRate(40, "auto");
    await refreshRate({ sources: [src("dolarapi")], read: async () => reading(52) });
    expect((await state()).rate).toBe(40);
    expect((await settingsPost(req("POST", "/api/admin/billing-settings", admin, { ...SETTINGS, rate: 52 }))).status).toBe(200);
    expect((await state()).rate).toBe(52);
  });
});
