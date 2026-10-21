import { createHash, randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, describe, expect, it } from "vitest";
import { POST as login } from "@/app/api/auth/login/route";
import { POST as signup } from "@/app/api/auth/signup/route";
import { POST as verify2fa } from "@/app/api/auth/2fa/verify/route";
import { GET as me } from "@/app/api/me/route";
import { adminAttention, signupsNote } from "@/components/AdminOverview";
import { getAdminOverview, type AdminOverview } from "@/lib/admin/overview";
import { hashPassword } from "@/lib/auth/password";
import { getPool } from "@/lib/db";
import { codeFor, enableMfaDirect } from "./mfa-helpers";

const RUN = randomUUID().slice(0, 8);
const ORIGIN = new URL(process.env.APP_URL!).origin;
const PASSWORD = "contraseña-de-prueba-123";
const owner = new Pool({ connectionString: process.env.MIGRATION_DATABASE_URL, max: 2 });
const tenantIds: string[] = [];

const req = (method: string, path: string, cookie?: string, body?: unknown) =>
  new Request(`${ORIGIN}${path}`, { method, headers: { origin: ORIGIN, ...(body !== undefined ? { "content-type": "application/json" } : {}), ...(cookie ? { cookie } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
const cookieOf = (res: Response) => (res.headers.get("set-cookie") ?? "").split(";")[0]!;
const hashOf = (cookie: string) => createHash("sha256").update(cookie.split("=")[1]!).digest();

async function register(name: string) {
  const res = await signup(req("POST", "/api/auth/signup", undefined, { email: `ov-${RUN}-${name}@example.test`, password: PASSWORD, businessName: `Resumen ${name} ${RUN}` }));
  expect(res.status).toBe(201);
  const cookie = cookieOf(res);
  const info = await (await me(req("GET", "/api/me", cookie))).json();
  tenantIds.push(info.tenant.id);
  return { cookie, tenantId: info.tenant.id as string };
}

async function superAdmin(name: string, withMfa = true) {
  const addr = `ov-${RUN}-${name}@example.test`;
  const ins = await owner.query<{ id: string }>("INSERT INTO users (email, password_hash, is_super_admin) VALUES ($1,$2,true) RETURNING id", [addr, await hashPassword(PASSWORD)]);
  if (!withMfa) {
    const res = await login(req("POST", "/api/auth/login", undefined, { email: addr, password: PASSWORD }));
    return cookieOf(res);
  }
  const secret = await enableMfaDirect(owner, ins.rows[0]!.id);
  const res = await login(req("POST", "/api/auth/login", undefined, { email: addr, password: PASSWORD }));
  const ver = await verify2fa(req("POST", "/api/auth/2fa/verify", cookieOf(res), { code: codeFor(secret) }));
  expect(ver.status).toBe(200);
  return cookieOf(ver);
}

const FN = `test_ov_set_${RUN.replace(/-/g, "_")}`;
let fnReady: Promise<void> | null = null;
/** Función de ayuda solo para estos tests: cambia estado/fechas de un negocio por la misma vía que usan las funciones del súper admin (el vencimiento está protegido). */
function ensureFn() {
  fnReady ??= (async () => {
    await owner.query(`CREATE FUNCTION ${FN}(p_tenant uuid, p_status text, p_trial timestamptz, p_exp timestamptz) RETURNS void
      LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
      BEGIN
        UPDATE tenants SET status = COALESCE(p_status, status), trial_ends_at = COALESCE(p_trial, trial_ends_at), plan_expires_at = COALESCE(p_exp, plan_expires_at) WHERE id = p_tenant;
      END $$`);
    await owner.query(`GRANT EXECUTE ON FUNCTION ${FN}(uuid, text, timestamptz, timestamptz) TO app_user`);
  })();
  return fnReady;
}
async function setTenant(tenantId: string, o: { status?: string; trialEnds?: Date; expires?: Date }) {
  await ensureFn();
  await getPool().query(`SELECT ${FN}($1, $2, $3, $4)`, [tenantId, o.status ?? null, o.trialEnds ?? null, o.expires ?? null]);
}
/** Envejece el registro de un negocio (el dueño de la base necesita el contexto del negocio por el RLS forzado). */
async function ageTenant(tenantId: string, hours: number) {
  const c = await owner.connect();
  try {
    await c.query("BEGIN");
    await c.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
    await c.query("UPDATE tenants SET created_at = now() - make_interval(hours => $2) WHERE id = $1", [tenantId, hours]);
    await c.query("COMMIT");
  } catch (e) { await c.query("ROLLBACK"); throw e; } finally { c.release(); }
}
const inDays = (n: number) => new Date(Date.now() + n * 86400000);

afterAll(async () => {
  if (fnReady) await owner.query(`DROP FUNCTION IF EXISTS ${FN}(uuid, text, timestamptz, timestamptz)`);
  await owner.end();
});

const dailySum = (o: AdminOverview) => o.daily.reduce((s, d) => s + d.n, 0);

/** Otras pruebas corren a la vez y crean negocios y mensajes: si una cifra global se descuadra por eso, se repite con negocios nuevos. */
async function retry(fn: (tag: string) => Promise<void>) {
  let last: unknown;
  for (let i = 0; i < 4; i++) {
    try { await fn(`${i}`); return; } catch (e) { last = e; }
  }
  throw last;
}

describe("resumen del súper admin (admin_overview)", () => {
  it("solo lo lee un súper admin con verificación en dos pasos", async () => {
    const a = await register("normal");
    await expect(getPool().query("SELECT admin_overview($1)", [hashOf(a.cookie)])).rejects.toMatchObject({ code: "42501" });
    const sinMfa = await superAdmin("sinmfa", false);
    await expect(getPool().query("SELECT admin_overview($1)", [hashOf(sinMfa)])).rejects.toMatchObject({ code: "42501" });
    await expect(getPool().query("SELECT admin_overview($1)", [Buffer.alloc(32, 1)])).rejects.toMatchObject({ code: "42501" });
  });

  it("cuenta registros y estados, y la zona horaria inválida cae a UTC", async () => {
    await retry(async (tag) => {
    const adm = await superAdmin("adm1");
    const h = hashOf(adm);
    const before = await getAdminOverview(h);

    const t1 = await register(`prueba${tag}`);
    const t2 = await register(`vencida${tag}`);
    const t3 = await register(`activa${tag}`);
    const t4 = await register(`mora${tag}`);
    const t5 = await register(`susp${tag}`);
    await setTenant(t2.tenantId, { trialEnds: inDays(-2) });
    await setTenant(t3.tenantId, { status: "active", expires: inDays(3) });
    await setTenant(t4.tenantId, { status: "past_due" });
    await setTenant(t5.tenantId, { status: "suspended" });
    // Activo con el plan ya vencido: no es «por vencer». Y uno registrado hace 10 días: cuenta en 30 días y en la semana previa, no en la última.
    const t6 = await register(`planvencido${tag}`);
    await setTenant(t6.tenantId, { status: "active", expires: inDays(-1) });
    await ageTenant(t6.tenantId, 240);
    const t7 = await register(`hace5${tag}`);
    await ageTenant(t7.tenantId, 120);
    const t8 = await register(`hace7y12h${tag}`);
    await ageTenant(t8.tenantId, 7 * 24 + 12);
    void t1;

    const after = await getAdminOverview(h);
    const d = (f: (o: AdminOverview) => number) => f(after) - f(before);
    expect(d((o) => o.tenants.total)).toBe(8);
    expect(d((o) => o.tenants.trial)).toBe(3); // los de hoy, hace 5 y hace 8 días
    expect(d((o) => o.tenants.trialExpired)).toBe(1);
    expect(d((o) => o.tenants.active)).toBe(2);
    expect(d((o) => o.tenants.expiringSoon)).toBe(1);
    expect(d((o) => o.tenants.pastDue)).toBe(1);
    expect(d((o) => o.tenants.suspended)).toBe(1);
    expect(d((o) => o.signups.last7)).toBe(6); // las 5 de hoy + la de hace 5 días
    expect(d((o) => o.signups.prev7)).toBe(2); // hace 7 días y medio y hace 10 días
    expect(d((o) => o.signups.last30)).toBe(8);
    expect(d((o) => o.users)).toBe(8);
    expect(d(dailySum)).toBe(8); // la gráfica cubre 14 días: entran todos menos ninguno (el más viejo es de hace 10)
    expect(after.daily).toHaveLength(14);
    expect(after.daily.at(-1)!.day).toBe(after.today);
    expect(after.recent.length).toBeLessThanOrEqual(6);
    expect(after.recent[0]!.name).toContain(RUN);

    // Un plan activo que vence dentro de 30 días no cuenta como «por vencer».
    await setTenant(t3.tenantId, { expires: inDays(30) });
    expect((await getAdminOverview(h)).tenants.expiringSoon - before.tenants.expiringSoon).toBe(0);

    const utc = (await getPool().query("SELECT admin_overview($1, 'Nada/Existe') AS o", [h])).rows[0].o;
    expect(utc.tz).toBe("UTC");
    expect((await getAdminOverview(h)).tz).toBe("America/Caracas");
    });
  });

  it("cuenta los pagos por revisar", async () => {
    await retry(async (tag) => {
    const adm = await superAdmin("adm2");
    const h = hashOf(adm);
    const before = await getAdminOverview(h);
    const t = await register(`pago${tag}`);
    const plan = (await owner.query<{ id: string }>("SELECT id FROM plans ORDER BY position LIMIT 1")).rows[0]!.id;
    for (const status of ["por_revisar", "por_revisar", "pendiente", "confirmado", "rechazado"]) {
      await owner.query("INSERT INTO payments (tenant_id, plan_id, months, method, amount_usd_cents, quote_expires_at, status) VALUES ($1,$2,1,'paypal',500,now() + interval '1 day',$3)", [t.tenantId, plan, status]);
    }
    expect((await getAdminOverview(h)).paymentsToReview - before.paymentsToReview).toBe(2);
    });
  });
});

const base: AdminOverview = {
  tz: "America/Caracas", today: "2026-10-20",
  tenants: { total: 0, trial: 0, trialExpired: 0, active: 0, expiringSoon: 0, pastDue: 0, suspended: 0 },
  signups: { last7: 0, prev7: 0, last30: 0 }, users: 0, paymentsToReview: 0, daily: [], recent: [],
};

describe("textos del resumen", () => {
  it("la atención solo muestra lo que tiene cifra y enlaza a la sección correcta", () => {
    expect(adminAttention(base)).toEqual([]);
    const a = adminAttention({ ...base, paymentsToReview: 2, tenants: { ...base.tenants, expiringSoon: 1, trialExpired: 3, pastDue: 1 } });
    expect(a.map((x) => [x.n, x.text, x.href])).toEqual([
      [2, "pagos por revisar", "/admin/cobros"],
      [1, "plan vence en 7 días", "/admin/negocios"],
      [3, "pruebas vencidas sin pagar", "/admin/negocios"],
      [1, "negocio con pago pendiente", "/admin/negocios"],
    ]);
  });

  it("la tendencia de registros", () => {
    expect(signupsNote({ last7: 0, prev7: 0, last30: 0 })).toBe("Sin registros todavía");
    expect(signupsNote({ last7: 2, prev7: 0, last30: 2 })).toBe("Primera semana con registros");
    expect(signupsNote({ last7: 3, prev7: 2, last30: 5 })).toBe("▲ 50 % vs. semana anterior");
    expect(signupsNote({ last7: 1, prev7: 2, last30: 3 })).toBe("▼ 50 % vs. semana anterior");
    expect(signupsNote({ last7: 2, prev7: 2, last30: 4 })).toBe("= igual que la semana anterior");
  });
});
