import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, describe, expect, it, vi } from "vitest";
import { POST as signup } from "@/app/api/auth/signup/route";
import { GET as me } from "@/app/api/me/route";
import { GET as simGet } from "@/app/api/dev/simulador/route";
import { getPool, withTenant } from "@/lib/db";
import { computeBlockers, loadAssistantBlockers, type StatusInput } from "@/lib/agent/status";

const base: StatusInput = { tenantStatus: "active", trialEndsAt: null, agentEnabled: true, whatsappConnected: true, llmConfigured: true, repliesToday: 0, dailyLimit: 300 };
const codes = (o: Partial<StatusInput>) => computeBlockers({ ...base, ...o }).map((b) => b.code);

describe("computeBlockers (por qué el asistente no responde)", () => {
  it("todo en orden → nada que avisar", () => {
    expect(codes({})).toEqual([]);
    expect(codes({ tenantStatus: "trial", trialEndsAt: new Date(Date.now() + 86_400_000) })).toEqual([]);
    expect(codes({ tenantStatus: "trial", trialEndsAt: null })).toEqual([]);
  });
  it("prueba terminada, plan vencido y cuenta suspendida son errores distintos", () => {
    const past = new Date(Date.now() - 1000);
    const t = computeBlockers({ ...base, tenantStatus: "trial", trialEndsAt: past });
    expect(t).toMatchObject([{ code: "trial_ended", level: "error", href: "/plan" }]);
    expect(t[0]!.text).toContain("prueba gratis terminó");
    expect(codes({ tenantStatus: "past_due" })).toEqual(["past_due"]);
    expect(codes({ tenantStatus: "suspended" })).toEqual(["suspended"]);
  });
  it("asistente apagado, sin número, sin IA y tope diario", () => {
    expect(codes({ agentEnabled: false })).toEqual(["disabled"]);
    expect(codes({ whatsappConnected: false })).toEqual(["no_whatsapp"]);
    expect(codes({ llmConfigured: false })).toEqual(["no_llm"]);
    expect(codes({ repliesToday: 299 })).toEqual([]);
    expect(codes({ repliesToday: 300 })).toEqual(["daily_limit"]);
  });
  it("varios motivos a la vez se listan todos, el más grave primero", () => {
    expect(codes({ tenantStatus: "past_due", agentEnabled: false, llmConfigured: false })).toEqual(["past_due", "disabled", "no_llm"]);
  });
  it("los textos no contienen claves ni detalles internos", () => {
    const all = computeBlockers({ tenantStatus: "suspended", trialEndsAt: null, agentEnabled: false, whatsappConnected: false, llmConfigured: false, repliesToday: 999, dailyLimit: 300 });
    for (const b of all) expect(b.text).not.toMatch(/AIza|sk-|postgres|redis:/i);
  });
});

const ORIGIN = new URL(process.env.APP_URL!).origin;
const RUN = randomUUID().slice(0, 8);
const owner = new Pool({ connectionString: process.env.MIGRATION_DATABASE_URL, max: 2 });
const tenantIds: string[] = [];

async function register(name: string) {
  const email = `st-${RUN}-${name}@example.test`;
  const res = await signup(new Request(`${ORIGIN}/api/auth/signup`, { method: "POST", headers: { origin: ORIGIN, "content-type": "application/json" }, body: JSON.stringify({ email, password: "contraseña-de-prueba-123", businessName: `Negocio ${name}` }) }));
  const cookie = (res.headers.get("set-cookie") ?? "").split(";")[0]!;
  const info = await (await me(new Request(`${ORIGIN}/api/me`, { headers: { origin: ORIGIN, cookie } }))).json();
  tenantIds.push(info.tenant.id);
  return { cookie, tenantId: info.tenant.id as string };
}
async function asOwner(tenantId: string, sql: string, params: unknown[] = []) {
  const c = await owner.connect();
  try {
    await c.query("BEGIN");
    await c.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
    await c.query(sql, params);
    await c.query("COMMIT");
  } catch (e) { await c.query("ROLLBACK"); throw e; } finally { c.release(); }
}

describe("loadAssistantBlockers (con la base de datos)", () => {
  it("negocio nuevo: asistente apagado y sin número; luego prueba vencida; luego todo listo", async () => {
    const t = await register("a");
    expect((await loadAssistantBlockers(t.tenantId)).map((b) => b.code).sort()).toEqual(["disabled", "no_whatsapp"]);

    await withTenant(t.tenantId, (db) => db.query("INSERT INTO tenant_agents (tenant_id, enabled, instructions) VALUES ($1, true, 'x')", [t.tenantId]));
    expect((await loadAssistantBlockers(t.tenantId)).map((b) => b.code)).toEqual(["no_whatsapp"]);

    await withTenant(t.tenantId, (db) => db.query("INSERT INTO tenant_integrations (tenant_id, provider, external_id, secret_enc, key_version) VALUES ($1, 'whatsapp', $2, 'x', 1)", [t.tenantId, "98" + RUN + "000"]));
    expect(await loadAssistantBlockers(t.tenantId)).toEqual([]);

    await asOwner(t.tenantId, "UPDATE tenants SET status = 'trial', trial_ends_at = now() - interval '1 day' WHERE id = $1", [t.tenantId]);
    expect((await loadAssistantBlockers(t.tenantId)).map((b) => b.code)).toEqual(["trial_ended"]);

    await asOwner(t.tenantId, "UPDATE tenants SET status = 'active' WHERE id = $1", [t.tenantId]);
    expect(await loadAssistantBlockers(t.tenantId)).toEqual([]);
  });

  it("el simulador devuelve los motivos en vez de dejar esperando sin explicación", async () => {
    const t = await register("b");
    await withTenant(t.tenantId, (db) => db.query("INSERT INTO tenant_agents (tenant_id, enabled, instructions) VALUES ($1, true, 'x')", [t.tenantId]));
    await asOwner(t.tenantId, "UPDATE tenants SET status = 'trial', trial_ends_at = now() - interval '1 hour' WHERE id = $1", [t.tenantId]);
    const v = await (await simGet(new Request(`${ORIGIN}/api/dev/simulador`, { headers: { origin: ORIGIN, cookie: t.cookie } }))).json();
    expect(v.blockers.map((b: { code: string }) => b.code)).toContain("trial_ended");
    expect(JSON.stringify(v.blockers)).not.toMatch(/secret|password/i);
  });
});

afterAll(async () => {
  vi.restoreAllMocks();
  await owner.query("DELETE FROM users WHERE email LIKE $1", [`st-${RUN}-%`]);
  for (const id of tenantIds) {
    const c = await owner.connect();
    try {
      await c.query("BEGIN");
      await c.query("SELECT set_config('app.tenant_id', $1, true)", [id]);
      await c.query("ALTER TABLE audit_log DISABLE TRIGGER audit_log_sin_cambios");
      await c.query("DELETE FROM audit_log WHERE tenant_id = $1", [id]);
      await c.query("ALTER TABLE audit_log ENABLE TRIGGER audit_log_sin_cambios");
      if ((await c.query("DELETE FROM tenants WHERE id = $1", [id])).rowCount !== 1) throw new Error("La limpieza no borró " + id);
      await c.query("COMMIT");
    } catch (e) { await c.query("ROLLBACK"); throw e; } finally { c.release(); }
  }
  await owner.end();
  await getPool().end();
});
