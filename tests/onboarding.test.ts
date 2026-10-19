import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { POST as signup } from "@/app/api/auth/signup/route";
import { GET as me } from "@/app/api/me/route";
import { POST as teamInvite } from "@/app/api/team/invite/route";
import { POST as inviteSignup } from "@/app/api/invitations/signup/route";
import { POST as onboard } from "@/app/api/onboarding/route";
import { POST as skipOnboarding } from "@/app/api/onboarding/skip/route";
import { buildInstructions, COUNTRY_DEFAULTS, effectiveType, onboardingSchema, parseHourRange, type OnboardingInput } from "@/lib/onboarding/schema";
import { COUNTRY_CODES } from "@/lib/agent/style";
import { CURRENCIES } from "@/lib/catalog/money";
import { isValidTimeZone } from "@/lib/agenda/tz";
import { getPool, withTenant } from "@/lib/db";

const RUN = randomUUID().slice(0, 8);
const ORIGIN = new URL(process.env.APP_URL!).origin;
const PASSWORD = "contraseña-de-prueba-123";
const owner = new Pool({ connectionString: process.env.MIGRATION_DATABASE_URL, max: 2 });
const tenantIds: string[] = [];
const planIds: string[] = [];

function api(method: string, path: string, cookie?: string, body?: unknown, origin = ORIGIN) {
  return new Request(`${ORIGIN}${path}`, {
    method,
    headers: { origin, ...(body !== undefined ? { "content-type": "application/json" } : {}), ...(cookie ? { cookie } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

async function register(name: string) {
  const email = `ob-${RUN}-${name}@example.test`;
  const res = await signup(api("POST", "/api/auth/signup", undefined, { email, password: PASSWORD, businessName: `Negocio ${name}` }));
  expect(res.status).toBe(201);
  const cookie = (res.headers.get("set-cookie") ?? "").split(";")[0]!;
  const info = await (await me(api("GET", "/api/me", cookie))).json();
  tenantIds.push(info.tenant.id);
  return { tenantId: info.tenant.id as string, cookie };
}
type T = Awaited<ReturnType<typeof register>>;
async function member(t: T, role: "admin" | "agent"): Promise<T> {
  const inv = await teamInvite(api("POST", "/api/team/invite", t.cookie, { email: `ob-${RUN}-${role}-${randomUUID().slice(0, 6)}@example.test`, role }));
  expect(inv.status).toBe(201);
  const token = ((await inv.json()).inviteUrl as string).split("/").pop()!;
  const ok = await inviteSignup(api("POST", "/api/invitations/signup", undefined, { token, password: PASSWORD }));
  expect(ok.status).toBe(201);
  return { tenantId: t.tenantId, cookie: (ok.headers.get("set-cookie") ?? "").split(";")[0]! };
}
beforeAll(async () => { await getPool().query("SELECT 1"); });
afterAll(async () => {
  await owner.query("DELETE FROM users WHERE email LIKE $1", [`ob-${RUN}-%`]);
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
  for (const id of planIds) await owner.query("DELETE FROM plans WHERE id = $1", [id]);
  await owner.end();
  await getPool().end();
});



async function setModules(tenantId: string, modules: string[]) {
  const slug = `o-${RUN}-${planIds.length}`;
  const r = await owner.query<{ id: string }>("INSERT INTO plans (slug, name, position, max_replies_month, max_members, modules) VALUES ($1,$2,99,100,5,$3) RETURNING id", [slug, slug, modules]);
  planIds.push(r.rows[0]!.id);
  const c = await owner.connect();
  try {
    await c.query("BEGIN");
    await c.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
    await c.query("ALTER TABLE tenants DISABLE TRIGGER tenants_plan_guard");
    await c.query("UPDATE tenants SET plan_id = $2 WHERE id = $1", [tenantId, r.rows[0]!.id]);
    await c.query("ALTER TABLE tenants ENABLE TRIGGER tenants_plan_guard");
    await c.query("COMMIT");
  } catch (e) { await c.query("ROLLBACK"); throw e; } finally { c.release(); }
}

const base = (over: Partial<OnboardingInput> = {}): OnboardingInput => ({
  businessType: "citas", country: "VE",
  services: [{ name: "Consulta", durationMinutes: 30, priceText: "$20" }, { name: "Control", durationMinutes: 15 }],
  products: [], hours: { days: [1, 2, 3, 4, 5], start: "09:00", end: "18:00" },
  info: { address: "Av. Bolívar", payments: "Pago Móvil", hours: "", offer: "", other: "" },
  assistantName: "Sofía", tone: "formal", emojiLevel: "ninguno", activate: true, ...over,
});
const post = (t: T, body: unknown) => onboard(api("POST", "/api/onboarding", t.cookie, body));
const state = (t: T) => withTenant(t.tenantId, async (db) => String((await db.query("SELECT onboarding_state FROM tenants WHERE id = $1", [t.tenantId])).rows[0].onboarding_state));
const rows = (t: T, sql: string) => withTenant(t.tenantId, async (db) => (await db.query(sql, [t.tenantId])).rows);

describe("piezas puras del asistente", () => {
  it("cada país tiene zona horaria y moneda válidas", () => {
    for (const c of COUNTRY_CODES) {
      expect(isValidTimeZone(COUNTRY_DEFAULTS[c].timezone)).toBe(true);
      expect((CURRENCIES as readonly string[]).includes(COUNTRY_DEFAULTS[c].currency)).toBe(true);
    }
  });
  it("effectiveType: sin el módulo en el plan, solo atención", () => {
    expect(effectiveType("citas", ["agenda"])).toBe("citas");
    expect(effectiveType("citas", ["catalogo"])).toBe("atencion");
    expect(effectiveType("catalogo", ["catalogo", "agenda"])).toBe("catalogo");
    expect(effectiveType("catalogo", [])).toBe("atencion");
    expect(effectiveType("atencion", ["agenda"])).toBe("atencion");
  });
  it("parseHourRange", () => {
    expect(parseHourRange("09:00", "18:30")).toEqual({ start: 540, end: 1110 });
    expect(typeof parseHourRange("18:00", "09:00")).toBe("string");
    expect(typeof parseHourRange("9am", "18:00")).toBe("string");
    expect(typeof parseHourRange("10:00", "10:00")).toBe("string");
  });
  it("buildInstructions: omite lo vacío y limpia caracteres peligrosos", () => {
    expect(buildInstructions("Café Sol", { offer: "", hours: "", address: "", payments: "", other: "" })).toBe("Sobre el negocio: Café Sol.");
    const t = buildInstructions("Café <b>Sol</b>", { offer: "Vendemos [[café]]\u0007", address: "Calle 1", payments: "", hours: "L-V 8 a 5", other: "" });
    expect(t).toBe("Sobre el negocio: Café b Sol /b. Vendemos café\nDirección: Calle 1\nHorario de atención: L-V 8 a 5");
    expect(t).not.toMatch(/[<>\u0007]|\[\[/);
  });
  it("el esquema rechaza listas largas, tonos raros y textos enormes", () => {
    expect(onboardingSchema.safeParse(base()).success).toBe(true);
    expect(onboardingSchema.safeParse(base({ services: Array.from({ length: 9 }, (_, i) => ({ name: `S${i}`, durationMinutes: 30 })) })).success).toBe(false);
    expect(onboardingSchema.safeParse({ ...base(), tone: "grosero" }).success).toBe(false);
    expect(onboardingSchema.safeParse(base({ info: { other: "x".repeat(601) } })).success).toBe(false);
    expect(onboardingSchema.safeParse(base({ services: [{ name: "A", durationMinutes: 1 }] })).success).toBe(false);
  });
});

describe("POST /api/onboarding", () => {
  it("un negocio nuevo empieza en «pending»", async () => {
    const t = await register("nuevo");
    expect(await state(t)).toBe("pending");
    const def = await owner.query("SELECT column_default FROM information_schema.columns WHERE table_name = 'tenants' AND column_name = 'onboarding_state'");
    expect(def.rows[0].column_default).toContain("pending");
  });

  it("citas: crea servicios, horario, zona horaria y asistente; queda «done» y queda auditado", async () => {
    const t = await register("citas");
    const res = await post(t, base());
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, businessType: "citas", services: 2, hours: true, downgraded: false });
    expect(await state(t)).toBe("done");
    expect((await rows(t, "SELECT name, duration_minutes, price_text FROM agenda_services WHERE tenant_id = $1 ORDER BY name")).map((r) => [r.name, r.duration_minutes, r.price_text])).toEqual([["Consulta", 30, "$20"], ["Control", 15, null]]);
    expect((await rows(t, "SELECT weekday, start_min, end_min FROM agenda_hours WHERE tenant_id = $1 ORDER BY weekday")).map((r) => [r.weekday, r.start_min, r.end_min])).toEqual([1, 2, 3, 4, 5].map((d) => [d, 540, 1080]));
    expect((await rows(t, "SELECT timezone FROM agenda_settings WHERE tenant_id = $1"))[0].timezone).toBe("America/Caracas");
    const a = (await rows(t, "SELECT enabled, assistant_name, instructions, business_type, country, tone, emoji_level FROM tenant_agents WHERE tenant_id = $1"))[0];
    expect(a).toMatchObject({ enabled: true, assistant_name: "Sofía", business_type: "citas", country: "VE", tone: "formal", emoji_level: "ninguno" });
    expect(a.instructions).toContain("Sobre el negocio: Negocio citas.");
    expect(a.instructions).toContain("Dirección: Av. Bolívar");
    expect(a.instructions).toContain("Formas de pago: Pago Móvil");
    expect((await rows(t, "SELECT metadata FROM audit_log WHERE tenant_id = $1 AND action = 'onboarding.completed'")).length).toBe(1);
  });

  it("no se puede completar dos veces (409) ni cambia nada la segunda vez", async () => {
    const t = await register("dos");
    expect((await post(t, base())).status).toBe(200);
    const again = await post(t, base({ assistantName: "Otra", services: [{ name: "Nuevo", durationMinutes: 30 }] }));
    expect(again.status).toBe(409);
    expect((await rows(t, "SELECT assistant_name FROM tenant_agents WHERE tenant_id = $1"))[0].assistant_name).toBe("Sofía");
    expect((await rows(t, "SELECT 1 FROM agenda_services WHERE tenant_id = $1 AND name = 'Nuevo'")).length).toBe(0);
  });

  it("catálogo: productos con su precio y moneda según el país", async () => {
    const t = await register("cat");
    const res = await post(t, base({ businessType: "catalogo", country: "CO", services: [], hours: null, products: [{ name: "Arepa", priceMinor: 1050 }, { name: "Empanada", priceMinor: 300 }] }));
    expect(await res.json()).toMatchObject({ ok: true, businessType: "catalogo", products: 2, services: 0 });
    expect((await rows(t, "SELECT name, price_minor FROM catalog_products WHERE tenant_id = $1 ORDER BY name")).map((r) => [r.name, Number(r.price_minor)])).toEqual([["Arepa", 1050], ["Empanada", 300]]);
    expect((await rows(t, "SELECT currency FROM catalog_settings WHERE tenant_id = $1"))[0].currency).toBe("COP");
    expect((await rows(t, "SELECT timezone FROM agenda_settings WHERE tenant_id = $1"))[0].timezone).toBe("America/Bogota");
    expect((await rows(t, "SELECT 1 FROM agenda_hours WHERE tenant_id = $1")).length).toBe(0);
  });

  it("solo atención: guarda la descripción y NO crea servicios ni productos aunque se los manden", async () => {
    const t = await register("aten");
    const res = await post(t, base({ businessType: "atencion", info: { offer: "Escuela de inglés para adultos", hours: "L-V 8 a 5", address: "", payments: "", other: "" }, products: [{ name: "X", priceMinor: 1 }] }));
    expect(await res.json()).toMatchObject({ ok: true, businessType: "atencion", services: 0, products: 0 });
    expect((await rows(t, "SELECT 1 FROM agenda_services WHERE tenant_id = $1", )).length).toBe(0);
    expect((await rows(t, "SELECT 1 FROM catalog_products WHERE tenant_id = $1")).length).toBe(0);
    const ins = (await rows(t, "SELECT instructions FROM tenant_agents WHERE tenant_id = $1"))[0].instructions as string;
    expect(ins).toContain("Escuela de inglés para adultos");
    expect(ins).toContain("Horario de atención: L-V 8 a 5");
  });

  it("el plan manda: sin el módulo de agenda, «citas» baja a «solo atención» y no se crea la agenda", async () => {
    const t = await register("plan");
    await setModules(t.tenantId, []);
    const res = await post(t, base());
    expect(await res.json()).toMatchObject({ ok: true, businessType: "atencion", downgraded: true, services: 0, hours: false });
    expect((await rows(t, "SELECT business_type FROM tenant_agents WHERE tenant_id = $1"))[0].business_type).toBe("atencion");
    expect((await rows(t, "SELECT 1 FROM agenda_services WHERE tenant_id = $1")).length).toBe(0);
  });

  it("no pisa lo que ya existe: servicios repetidos, horario y texto del negocio", async () => {
    const t = await register("existe");
    await withTenant(t.tenantId, async (db) => {
      await db.query("INSERT INTO agenda_services (tenant_id, name, duration_minutes) VALUES ($1,'consulta',45)", [t.tenantId]);
      await db.query("INSERT INTO agenda_hours (tenant_id, weekday, start_min, end_min) VALUES ($1,6,600,720)", [t.tenantId]);
      await db.query("INSERT INTO tenant_agents (tenant_id, instructions) VALUES ($1,'Mi texto propio, sin plantilla.')", [t.tenantId]);
    });
    const res = await post(t, base());
    expect(await res.json()).toMatchObject({ ok: true, services: 1, hours: false, instructionsKept: true });
    expect((await rows(t, "SELECT name, duration_minutes FROM agenda_services WHERE tenant_id = $1 ORDER BY name")).map((r) => [r.name, r.duration_minutes]).sort()).toEqual([["Control", 15], ["consulta", 45]]);
    expect((await rows(t, "SELECT weekday FROM agenda_hours WHERE tenant_id = $1")).map((r) => r.weekday)).toEqual([6]);
    expect((await rows(t, "SELECT instructions FROM tenant_agents WHERE tenant_id = $1"))[0].instructions).toBe("Mi texto propio, sin plantilla.");
  });

  it("una plantilla sin rellenar sí se reemplaza", async () => {
    const t = await register("plantilla");
    await withTenant(t.tenantId, (db) => db.query("INSERT INTO tenant_agents (tenant_id, instructions) VALUES ($1,'Dirección: [dirección y puntos de referencia]')", [t.tenantId]));
    expect(await (await post(t, base())).json()).toMatchObject({ instructionsKept: false });
    expect((await rows(t, "SELECT instructions FROM tenant_agents WHERE tenant_id = $1"))[0].instructions).toContain("Av. Bolívar");
  });

  it("sin el módulo de catálogo en el plan no se crean productos; y «activar» desactivado deja el asistente apagado", async () => {
    const t = await register("sincat");
    await setModules(t.tenantId, ["agenda"]);
    const res = await post(t, base({ businessType: "catalogo", services: [], hours: null, products: [{ name: "Arepa", priceMinor: 500 }], activate: false }));
    expect(await res.json()).toMatchObject({ ok: true, businessType: "atencion", products: 0, downgraded: true });
    expect((await rows(t, "SELECT 1 FROM catalog_products WHERE tenant_id = $1")).length).toBe(0);
    expect((await rows(t, "SELECT 1 FROM catalog_settings WHERE tenant_id = $1")).length).toBe(0);
    expect((await rows(t, "SELECT enabled FROM tenant_agents WHERE tenant_id = $1"))[0].enabled).toBe(false);
  });

  it("horario con la hora de cierre antes de la de apertura: el mensaje lo explica", async () => {
    const t = await register("msg");
    const res = await post(t, base({ hours: { days: [1], start: "18:00", end: "09:00" } }));
    expect(res.status).toBe(400);
    expect((await res.json()).message).toMatch(/cierre/);
  });

  it("datos inválidos: 400 y no queda NADA a medias", async () => {
    const t = await register("malo");
    expect((await post(t, base({ hours: { days: [1], start: "18:00", end: "09:00" } }))).status).toBe(400);
    expect((await post(t, base({ hours: { days: [1], start: "9am", end: "10:00" } }))).status).toBe(400);
    expect((await post(t, { ...base(), tone: "grosero" })).status).toBe(400);
    expect((await post(t, { ...base(), services: Array.from({ length: 9 }, (_, i) => ({ name: `S${i}`, durationMinutes: 30 })) })).status).toBe(400);
    expect(await state(t)).toBe("pending");
    expect((await rows(t, "SELECT 1 FROM agenda_services WHERE tenant_id = $1")).length).toBe(0);
    expect((await rows(t, "SELECT 1 FROM tenant_agents WHERE tenant_id = $1")).length).toBe(0);
    expect((await rows(t, "SELECT 1 FROM agenda_settings WHERE tenant_id = $1")).length).toBe(0);
  });

  it("sin sesión 401; origen ajeno 403; un agente (sin permiso) 403", async () => {
    expect((await onboard(api("POST", "/api/onboarding", undefined, base()))).status).toBe(401);
    const t = await register("perm");
    expect((await onboard(api("POST", "/api/onboarding", t.cookie, base(), "https://evil.example"))).status).toBe(403);
    const ag = await member(t, "agent");
    expect((await post(ag, base())).status).toBe(403);
    expect((await skipOnboarding(api("POST", "/api/onboarding/skip", ag.cookie))).status).toBe(403);
    expect(await state(t)).toBe("pending");
  });
});

describe("«Lo haré después»", () => {
  it("pasa a «skipped», se puede retomar y completar, y no deshace un «done»", async () => {
    const t = await register("skip");
    expect((await skipOnboarding(api("POST", "/api/onboarding/skip", t.cookie))).status).toBe(200);
    expect(await state(t)).toBe("skipped");
    expect((await post(t, base())).status).toBe(200);
    expect(await state(t)).toBe("done");
    expect((await skipOnboarding(api("POST", "/api/onboarding/skip", t.cookie))).status).toBe(200);
    expect(await state(t)).toBe("done");
  });
  it("aislamiento: completar un negocio no toca a otro", async () => {
    const a = await register("iso-a");
    const b = await register("iso-b");
    expect((await post(a, base())).status).toBe(200);
    expect(await state(b)).toBe("pending");
    expect((await rows(b, "SELECT 1 FROM agenda_services WHERE tenant_id = $1")).length).toBe(0);
  });
});

describe("permisos sobre la tabla de negocios", () => {
  it("la aplicación solo puede cambiar el nombre y el estado del asistente: no el estado de la cuenta, ni la prueba, ni el plan", async () => {
    const t = await register("grants");
    const upd = (set: string) => withTenant(t.tenantId, (db) => db.query(`UPDATE tenants SET ${set} WHERE id = $1`, [t.tenantId]));
    await expect(upd("status = 'active'")).rejects.toMatchObject({ code: "42501" });
    await expect(upd("trial_ends_at = now() + interval '5 years'")).rejects.toMatchObject({ code: "42501" });
    await expect(upd("slug = 'otro-slug'")).rejects.toMatchObject({ code: "42501" });
    await expect(upd("created_at = now()")).rejects.toMatchObject({ code: "42501" });
    await expect(upd("name = 'Otro nombre'")).resolves.toBeDefined(); // el nombre sí lo cambia el negocio (perfil)
    await expect(upd("plan_id = plan_id")).rejects.toMatchObject({ code: "42501" });
    await expect(upd("onboarding_state = 'skipped'")).resolves.toBeDefined();
  });
});
