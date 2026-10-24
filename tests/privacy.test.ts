import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, describe, expect, it } from "vitest";
import { POST as signup } from "@/app/api/auth/signup/route";
import { POST as inviteSignup } from "@/app/api/invitations/signup/route";
import { POST as teamInvite } from "@/app/api/team/invite/route";
import { POST as exportData } from "@/app/api/privacy/export/route";
import { POST as requestDelete } from "@/app/api/privacy/delete/route";
import { POST as cancelDelete } from "@/app/api/privacy/cancel/route";
import { GET as status } from "@/app/api/privacy/status/route";
import { GET as me } from "@/app/api/me/route";
import { getPool, withTenant } from "@/lib/db";
import { purgeDueTenants } from "@/lib/privacy/deletion";
import { EXCLUDED_TABLES, EXPORTED_TABLES, type ExportFile } from "@/lib/privacy/export";
import { codeFor, enableMfaDirect } from "./mfa-helpers";

const RUN = randomUUID().slice(0, 8);
const ORIGIN = new URL(process.env.APP_URL!).origin;
const PASSWORD = "contraseña-de-prueba-123";
const owner = new Pool({ connectionString: process.env.MIGRATION_DATABASE_URL, max: 2 });
const tenantIds: string[] = [];

const req = (method: string, path: string, cookie?: string, body?: unknown, origin = ORIGIN) =>
  new Request(`${ORIGIN}${path}`, { method, headers: { origin, ...(body !== undefined ? { "content-type": "application/json" } : {}), ...(cookie ? { cookie } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
const cookieOf = (res: Response) => (res.headers.get("set-cookie") ?? "").split(";")[0]!;
const emailOf = (n: string) => `pv-${RUN}-${n}@example.test`;

async function register(name: string) {
  const res = await signup(req("POST", "/api/auth/signup", undefined, { email: emailOf(name), password: PASSWORD, businessName: `Privacidad ${name}`, acceptTerms: true }));
  expect(res.status).toBe(201);
  const cookie = cookieOf(res);
  const info = await (await me(req("GET", "/api/me", cookie))).json();
  tenantIds.push(info.tenant.id);
  const userId = (await owner.query<{ id: string }>("SELECT id FROM users WHERE email = $1", [emailOf(name)])).rows[0]!.id;
  return { cookie, tenantId: info.tenant.id as string, userId, name: `Privacidad ${name}` };
}

/** Un agente (no dueño) dentro del negocio, creado por la vía normal de invitaciones. */
async function addAgent(t: { cookie: string }, name: string) {
  const inv = await teamInvite(req("POST", "/api/team/invite", t.cookie, { email: emailOf(name), role: "agent" }));
  expect(inv.status).toBe(201);
  const token = ((await inv.json()).inviteUrl as string).split("/").pop()!;
  const ok = await inviteSignup(req("POST", "/api/invitations/signup", undefined, { token, password: PASSWORD, acceptTerms: true }));
  expect(ok.status).toBe(201);
  const userId = (await owner.query<{ id: string }>("SELECT id FROM users WHERE email = $1", [emailOf(name)])).rows[0]!.id;
  return { cookie: cookieOf(ok), userId };
}

/** Consultas con la conexión dueña (saltan los permisos de la app), siempre dentro de un negocio. */
async function asOwner<T>(tenantId: string, fn: (c: import("pg").PoolClient) => Promise<T>): Promise<T> {
  const c = await owner.connect();
  try {
    await c.query("BEGIN");
    await c.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
    const r = await fn(c);
    await c.query("COMMIT");
    return r;
  } catch (e) { await c.query("ROLLBACK"); throw e; } finally { c.release(); }
}

async function seed(t: { tenantId: string }, tag: string) {
  await withTenant(t.tenantId, async (db) => {
    await db.query("INSERT INTO contacts (tenant_id, wa_id, display_name) VALUES ($1, $2, $3)", [t.tenantId, `58412${RUN.replace(/\D/g, "0").padEnd(7, "0").slice(0, 7)}`, `Cliente ${tag}`]);
    await db.query("INSERT INTO webhook_endpoints (tenant_id, url, events, secret_enc, key_version) VALUES ($1, $2, ARRAY['order.created'], 'SECRETO-WEBHOOK-NO-SALIR', 1)", [t.tenantId, `https://hooks.example.test/${tag}`]);
    await db.query("INSERT INTO tenant_integrations (tenant_id, provider, external_id, secret_enc, key_version) VALUES ($1, 'whatsapp', $2, 'SECRETO-WHATSAPP-NO-SALIR', 1)", [t.tenantId, `pn-${RUN}-${t.tenantId}`]);
  });
}

const tenantExists = async (id: string) => (await asOwner(id, (c) => c.query("SELECT 1 FROM tenants WHERE id = $1", [id]))).rowCount === 1;
const call = (h: (r: Request) => Promise<Response>, path: string, cookie: string | undefined, body: unknown) => h(req("POST", path, cookie, body));
const ex = (cookie: string | undefined, body: unknown) => call(exportData, "/api/privacy/export", cookie, body);
const del = (cookie: string | undefined, body: unknown) => call(requestDelete, "/api/privacy/delete", cookie, body);

afterAll(async () => {
  await owner.query("DELETE FROM users WHERE email LIKE $1", [`pv-${RUN}-%`]);
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
  await owner.end();
  await getPool().end();
});

describe("qué se descarga", () => {
  it("toda tabla con tenant_id está en la descarga o en la lista de excluidas (con motivo)", async () => {
    const r = await owner.query<{ table_name: string }>(
      `SELECT c.table_name FROM information_schema.columns c JOIN information_schema.tables t USING (table_schema, table_name)
       WHERE c.table_schema = 'public' AND c.column_name = 'tenant_id' AND t.table_type = 'BASE TABLE'`);
    const real = r.rows.map((x) => x.table_name).sort();
    const exported = EXPORTED_TABLES.map((x) => x.table);
    const excluded = Object.keys(EXCLUDED_TABLES).filter((k) => !k.includes("."));
    expect(exported.filter((x) => excluded.includes(x))).toEqual([]);
    expect(new Set(exported).size).toBe(exported.length);
    expect([...exported, ...excluded].sort()).toEqual(real);
    for (const v of Object.values(EXCLUDED_TABLES)) expect(v.length).toBeGreaterThan(10);
  });
});

describe("descargar mis datos (POST /api/privacy/export)", () => {
  it("entrega los datos del negocio, sin secretos y sin datos de otro negocio", async () => {
    const a = await register("exa");
    const b = await register("exb");
    await seed(a, "uno");
    await seed(b, "otro");
    await asOwner(a.tenantId, (c) => c.query(
      "INSERT INTO payments (tenant_id, plan_id, months, method, amount_usd_cents, quote_expires_at, proof, proof_mime, reference) SELECT $1, default_plan_id(), 1, 'paypal', 1500, now() + interval '1 day', $2, 'image/png', 'REFPRUEBA1'",
      [a.tenantId, Buffer.from("IMAGEN-SECRETA-DEL-COMPROBANTE")]));
    const agent = await addAgent(a, "exa-agente");

    const res = await ex(a.cookie, { password: PASSWORD });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-disposition")).toMatch(/^attachment; filename="mis-datos-\d{4}-\d{2}-\d{2}\.json"$/);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const text = await res.text();
    const file = JSON.parse(text) as ExportFile;
    expect(file.tenant).toMatchObject({ id: a.tenantId, name: a.name });
    expect(file.members.map((m) => m.email).sort()).toEqual([emailOf("exa"), emailOf("exa-agente")].sort());
    expect(file.members.find((m) => m.email === emailOf("exa"))?.role).toBe("owner");
    expect(file.tables.contacts!.rows.map((r) => r.display_name)).toEqual(["Cliente uno"]);
    expect(file.tables.webhook_endpoints!.rows).toHaveLength(1);
    expect(file.tables.payments!.rows).toHaveLength(1);
    expect(file.tables.payments!.rows[0]).toMatchObject({ method: "paypal", amount_usd_cents: 1500, reference: "REFPRUEBA1" });
    expect(file.tables.payments!.rows[0]).not.toHaveProperty("proof");
    expect(file.tables.invitations!.rows.map((r) => r.email)).toEqual([emailOf("exa-agente")]);
    expect(file.tables.tenant_integrations!.rows[0]).toMatchObject({ provider: "whatsapp" });
    expect(Object.keys(file.tables)).toEqual(EXPORTED_TABLES.map((x) => x.table));
    expect(file.tables.audit_log!.rows.some((r) => r.action === "tenant.exported")).toBe(false); // se anota después de armar el archivo
    // Nada secreto ni de otro negocio.
    for (const bad of ["SECRETO-WEBHOOK-NO-SALIR", "SECRETO-WHATSAPP-NO-SALIR", "secret_enc", "token_hash", "proof_mime\":\"image/png\",\"proof\"", "Cliente otro", "hooks.example.test/otro", b.tenantId, emailOf("exb")]) expect(text).not.toContain(bad);
    // Queda anotado quién descargó.
    const audit = await asOwner(a.tenantId, (c) => c.query("SELECT actor_id FROM audit_log WHERE action = 'tenant.exported'"));
    expect(audit.rows).toEqual([{ actor_id: a.userId }]);
    void agent;
  });

  it("pide contraseña: sin ella o con una incorrecta no entrega nada", async () => {
    const t = await register("expw");
    await seed(t, "pw");
    expect((await ex(t.cookie, {})).status).toBe(400);
    const bad = await ex(t.cookie, { password: "otra-contraseña-incorrecta" });
    expect(bad.status).toBe(401);
    expect(await bad.text()).not.toContain("Cliente pw");
  });

  it("solo la persona dueña: un agente, alguien sin sesión o un origen ajeno reciben rechazo", async () => {
    const t = await register("exrol");
    const agent = await addAgent(t, "exrol-agente");
    expect((await ex(agent.cookie, { password: PASSWORD })).status).toBe(403);
    expect((await ex(undefined, { password: PASSWORD })).status).toBe(401);
    const foreign = await exportData(req("POST", "/api/privacy/export", t.cookie, { password: PASSWORD }, "https://sitio-malo.example"));
    expect(foreign.status).toBeGreaterThanOrEqual(400);
    expect((await (await status(req("GET", "/api/privacy/status", agent.cookie))).json()).error).toBeDefined();
  });

  it("con verificación en dos pasos también pide el código", async () => {
    const t = await register("exmfa");
    const secret = await enableMfaDirect(owner, t.userId);
    expect((await ex(t.cookie, { password: PASSWORD })).status).toBe(401);
    expect((await ex(t.cookie, { password: PASSWORD, code: "000000" })).status).toBe(401);
    expect((await ex(t.cookie, { password: "otra-contraseña-incorrecta", code: codeFor(secret) })).status).toBe(401);
    expect((await ex(t.cookie, { password: PASSWORD, code: codeFor(secret) })).status).toBe(200);
  });

  it("un negocio suspendido puede descargar sus datos igual", async () => {
    const t = await register("exsusp");
    await asOwner(t.tenantId, (c) => c.query("UPDATE tenants SET status = 'suspended' WHERE id = $1", [t.tenantId]));
    expect((await ex(t.cookie, { password: PASSWORD })).status).toBe(200);
  });
});

describe("pedir y cancelar la eliminación", () => {
  it("valida nombre y contraseña, agenda 7 días, es idempotente y se puede cancelar", async () => {
    const t = await register("del");
    const agent = await addAgent(t, "del-agente");
    expect((await del(t.cookie, { password: PASSWORD, confirmName: "otro nombre" })).status).toBe(400);
    expect((await del(t.cookie, { password: "otra-contraseña-incorrecta", confirmName: t.name })).status).toBe(401);
    expect((await del(agent.cookie, { password: PASSWORD, confirmName: t.name })).status).toBe(403);
    expect((await del(undefined, { password: PASSWORD, confirmName: t.name })).status).toBe(401);
    expect(await (await status(req("GET", "/api/privacy/status", t.cookie))).json()).toEqual({ requestedAt: null, scheduledFor: null });

    const ok = await del(t.cookie, { password: PASSWORD, confirmName: ` ${t.name} ` });
    expect(ok.status).toBe(200);
    const when = new Date((await ok.json()).scheduledFor as string).getTime();
    expect(when - Date.now()).toBeGreaterThan(6.99 * 86400_000);
    expect(when - Date.now()).toBeLessThan(7.01 * 86400_000);

    const again = await del(t.cookie, { password: PASSWORD, confirmName: t.name });
    expect(new Date((await again.json()).scheduledFor as string).getTime()).toBe(when);
    expect((await (await status(req("GET", "/api/privacy/status", t.cookie))).json()).scheduledFor).toBeTruthy();

    // El agente no puede cancelar; la dueña sí; y una segunda cancelación avisa que no hay nada pendiente.
    expect((await call(cancelDelete, "/api/privacy/cancel", agent.cookie, {})).status).toBe(403);
    expect((await call(cancelDelete, "/api/privacy/cancel", t.cookie, {})).status).toBe(200);
    expect((await call(cancelDelete, "/api/privacy/cancel", t.cookie, {})).status).toBe(409);
    expect(await (await status(req("GET", "/api/privacy/status", t.cookie))).json()).toEqual({ requestedAt: null, scheduledFor: null });
    const acts = await asOwner(t.tenantId, (c) => c.query("SELECT action FROM audit_log WHERE action LIKE 'tenant.deletion%' ORDER BY created_at, id"));
    expect(acts.rows.map((r) => r.action)).toEqual(["tenant.deletion_requested", "tenant.deletion_cancelled"]);
  });

  it("no se puede cancelar una eliminación cuya fecha ya llegó", async () => {
    const t = await register("delvenc");
    expect((await del(t.cookie, { password: PASSWORD, confirmName: t.name })).status).toBe(200);
    await asOwner(t.tenantId, (c) => c.query("UPDATE tenants SET deletion_requested_at = now() - interval '8 days', deletion_scheduled_for = now() - interval '1 day' WHERE id = $1", [t.tenantId]));
    expect((await call(cancelDelete, "/api/privacy/cancel", t.cookie, {})).status).toBe(409);
  });

  it("las fechas van juntas o ninguna (restricción de la base)", async () => {
    const t = await register("delchk");
    await expect(asOwner(t.tenantId, (c) => c.query("UPDATE tenants SET deletion_scheduled_for = now() WHERE id = $1", [t.tenantId]))).rejects.toThrow(/tenants_deletion_check/);
  });
});

describe("las funciones de la base se defienden solas (sin pasar por las rutas)", () => {
  it("quien no es dueño del negocio no puede pedir, cancelar ni descargar, aunque llame a la función directamente", async () => {
    const t = await register("sql");
    const agent = await addAgent(t, "sql-agente");
    const outsider = await register("sqlfuera");
    for (const who of [agent.userId, outsider.userId]) {
      for (const q of [
        "SELECT tenant_request_deletion($1, $2)",
        "SELECT tenant_cancel_deletion($1, $2)",
        "SELECT * FROM tenant_export_members($1, $2)",
        "SELECT tenant_export_restricted($1, $2, 10)",
      ]) await expect(getPool().query(q, [t.tenantId, who]), q).rejects.toMatchObject({ code: "42501" });
    }
    expect((await (await status(req("GET", "/api/privacy/status", t.cookie))).json()).scheduledFor).toBeNull();
  });
});

describe("borrado definitivo", () => {
  it("borra el negocio, todo lo suyo y a quienes solo pertenecían a él; respeta lo demás", async () => {
    const a = await register("pur");
    const other = await register("purotro"); // negocio distinto que NO debe tocarse
    await seed(a, "pur"); await seed(other, "otro");
    const agent = await addAgent(a, "pur-agente");
    // Una persona que pertenece a los dos negocios: debe sobrevivir (solo pierde su membresía en el borrado).
    await asOwner(a.tenantId, (c) => c.query("INSERT INTO memberships (tenant_id, user_id, role) VALUES ($1, $2, 'agent')", [a.tenantId, other.userId]));
    // Un súper administrador que también es miembro: tampoco se borra.
    const adminId = (await owner.query<{ id: string }>("INSERT INTO users (email, password_hash, is_super_admin) VALUES ($1, $2, true) RETURNING id", [emailOf("pur-admin"), "x".repeat(60)])).rows[0]!.id;
    await asOwner(a.tenantId, (c) => c.query("INSERT INTO memberships (tenant_id, user_id, role) VALUES ($1, $2, 'agent')", [a.tenantId, adminId]));

    expect((await del(a.cookie, { password: PASSWORD, confirmName: a.name })).status).toBe(200);
    // Todavía no llegó la fecha: no se borra nada.
    await purgeDueTenants(50);
    expect(await tenantExists(a.tenantId)).toBe(true);

    await asOwner(a.tenantId, (c) => c.query("UPDATE tenants SET deletion_requested_at = now() - interval '8 days', deletion_scheduled_for = now() - interval '1 day' WHERE id = $1", [a.tenantId]));
    expect(await purgeDueTenants(50)).toBeGreaterThanOrEqual(1);

    expect(await tenantExists(a.tenantId)).toBe(false);
    const tables = (await owner.query<{ table_name: string }>(
      `SELECT c.table_name FROM information_schema.columns c JOIN information_schema.tables t USING (table_schema, table_name)
       WHERE c.table_schema = 'public' AND c.column_name = 'tenant_id' AND t.table_type = 'BASE TABLE'`)).rows.map((r) => r.table_name);
    for (const tb of tables) {
      const left = await asOwner(a.tenantId, (c) => c.query(`SELECT count(*)::int AS n FROM ${tb} WHERE tenant_id = $1`, [a.tenantId]));
      expect({ tb, n: left.rows[0].n }).toEqual({ tb, n: 0 });
    }
    const users = (await owner.query<{ email: string }>("SELECT email FROM users WHERE email = ANY($1)", [[emailOf("pur"), emailOf("pur-agente"), emailOf("purotro"), emailOf("pur-admin")]])).rows.map((r) => r.email).sort();
    expect(users).toEqual([emailOf("pur-admin"), emailOf("purotro")].sort());
    for (const u of [a.userId, agent.userId]) expect((await getPool().query("SELECT * FROM legal_latest($1)", [u])).rowCount).toBe(0);
    expect((await owner.query("SELECT 1 FROM sessions WHERE user_id = ANY($1)", [[a.userId, agent.userId]])).rowCount).toBe(0);
    // El otro negocio y su gente siguen completos.
    const keep = await ex(other.cookie, { password: PASSWORD });
    expect(keep.status).toBe(200);
    expect(((await keep.json()) as ExportFile).tables.contacts!.rows.map((r) => r.display_name)).toEqual(["Cliente otro"]);
    expect((await asOwner(a.tenantId, (c) => c.query("SELECT 1 FROM memberships WHERE user_id = $1 AND tenant_id = $2", [other.userId, a.tenantId]))).rowCount).toBe(0);
    // La sesión de quien se borró ya no sirve.
    expect((await ex(a.cookie, { password: PASSWORD })).status).toBe(401);
    await owner.query("DELETE FROM users WHERE id = $1", [adminId]);
  });

  it("un negocio con la eliminación pedida a futuro no se borra", async () => {
    const t = await register("fut");
    expect((await del(t.cookie, { password: PASSWORD, confirmName: t.name })).status).toBe(200);
    await purgeDueTenants(50);
    expect(await tenantExists(t.tenantId)).toBe(true);
  });
});

describe("el historial de auditoría sigue siendo de solo inserción", () => {
  it("la aplicación no puede borrarlo ni editarlo, ni siquiera marcando app.purge", async () => {
    const t = await register("aud");
    await del(t.cookie, { password: PASSWORD, confirmName: t.name });
    await expect(withTenant(t.tenantId, async (db) => {
      await db.query("SELECT set_config('app.purge', '1', true)");
      await db.query("DELETE FROM audit_log WHERE tenant_id = $1", [t.tenantId]);
    })).rejects.toThrow();
    await expect(withTenant(t.tenantId, (db) => db.query("UPDATE audit_log SET action = 'x' WHERE tenant_id = $1", [t.tenantId]))).rejects.toThrow();
    // Aunque se conecte con la cuenta dueña y marque app.purge, fuera de la función no se puede (SESSION_USER = app_owner): no borra nada.
    const direct = await asOwner(t.tenantId, async (c) => {
      await c.query("SELECT set_config('app.purge', '1', true)");
      return c.query("DELETE FROM audit_log WHERE tenant_id = $1", [t.tenantId]);
    });
    expect(direct.rowCount).toBe(0);
    const left = await asOwner(t.tenantId, (c) => c.query("SELECT count(*)::int AS n FROM audit_log WHERE tenant_id = $1", [t.tenantId]));
    expect(left.rows[0].n).toBeGreaterThanOrEqual(1);
  });
});
