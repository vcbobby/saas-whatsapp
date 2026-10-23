import { createHash, randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { POST as signup } from "@/app/api/auth/signup/route";
import { POST as login } from "@/app/api/auth/login/route";
import { POST as verify2fa } from "@/app/api/auth/2fa/verify/route";
import { PUT as putCosts } from "@/app/api/admin/costos/route";
import { POST as askRoute } from "@/app/api/copilot/route";
import { GET as me } from "@/app/api/me/route";
import { runAgent } from "@/lib/agent/run";
import { askCopilot } from "@/lib/copilot/ask";
import { getAdminBudget, budgetAttention, setAdminBudget } from "@/lib/admin/costs";
import { getAiGuard, parseGuardState, recordAiUsage, resetAiGuardCache, reserveMessageCall, tenantTokens, type AiGuardState } from "@/lib/ai/guard";
import { LlmError, type LlmProvider } from "@/lib/ai/provider";
import { hashPassword } from "@/lib/auth/password";
import { encryptSecret } from "@/lib/crypto";
import { closeLockClient } from "@/lib/queue/lock";
import { getPool, withTenant } from "@/lib/db";
import { ingestBatch } from "@/lib/whatsapp/ingest";
import type { SendResult } from "@/lib/whatsapp/graph";
import { codeFor, enableMfaDirect } from "./mfa-helpers";

// Se puede forzar «IA en pausa» sin tocar los ajustes globales de la base (que comparten todas las pruebas).
vi.mock("@/lib/ai/guard", async (orig) => {
  const real = await orig<typeof import("@/lib/ai/guard")>();
  return { ...real, getAiGuard: vi.fn(real.getAiGuard) };
});

process.env.WHATSAPP_APP_SECRET = "secreto-de-prueba-de-la-app-meta";
process.env.WHATSAPP_VERIFY_TOKEN = "token-de-verificacion-de-prueba-123456";
const RUN = randomUUID().slice(0, 8);
process.env.QUEUE_PREFIX = `test-cg-${RUN}`;
const ORIGIN = new URL(process.env.APP_URL!).origin;
const PASSWORD = "contraseña-de-prueba-123";
const TOKEN = "EAAtoken-de-prueba-del-negocio-1234567890";
const owner = new Pool({ connectionString: process.env.MIGRATION_DATABASE_URL, max: 2 });
const tenantIds: string[] = [];
let seq = 0;
const newPhoneId = () => `7${RUN.replace(/\D/g, "").padEnd(4, "5").slice(0, 4)}${Date.now() % 100000}${seq++}`.slice(0, 18);
const newWaId = () => `58414${String(Date.now()).slice(-6)}${seq++}`.slice(0, 15);

const req = (method: string, path: string, cookie?: string, body?: unknown) =>
  new Request(`${ORIGIN}${path}`, { method, headers: { origin: ORIGIN, ...(body !== undefined ? { "content-type": "application/json" } : {}), ...(cookie ? { cookie } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
const cookieOf = (res: Response) => (res.headers.get("set-cookie") ?? "").split(";")[0]!;
const hashOf = (cookie: string) => createHash("sha256").update(cookie.split("=")[1]!).digest();

async function register(name: string) {
  const email = `cg-${RUN}-${name}@example.test`;
  const res = await signup(req("POST", "/api/auth/signup", undefined, { email, password: PASSWORD, businessName: `Costos ${name}` }));
  expect(res.status).toBe(201);
  const cookie = cookieOf(res);
  const info = await (await me(req("GET", "/api/me", cookie))).json();
  const tenantId = info.tenant.id as string;
  tenantIds.push(tenantId);
  const phoneId = newPhoneId();
  const { payload, keyVersion } = encryptSecret(TOKEN, `wa:${tenantId}:${phoneId}`);
  await owner.query("INSERT INTO tenant_integrations (tenant_id, provider, external_id, secret_enc, key_version) VALUES ($1,'whatsapp',$2,$3,$4)", [tenantId, phoneId, payload, keyVersion]);
  await withTenant(tenantId, (db) => db.query("INSERT INTO tenant_agents (tenant_id, enabled, assistant_name, instructions) VALUES ($1, true, 'Ana', 'Abrimos de 8am a 5pm.')", [tenantId]));
  return { tenantId, phoneId, cookie };
}
type T = Awaited<ReturnType<typeof register>>;

async function superAdmin(name: string) {
  const addr = `cg-${RUN}-${name}@example.test`;
  const ins = await owner.query<{ id: string }>("INSERT INTO users (email, password_hash, is_super_admin) VALUES ($1,$2,true) RETURNING id", [addr, await hashPassword(PASSWORD)]);
  const secret = await enableMfaDirect(owner, ins.rows[0]!.id);
  const res = await login(req("POST", "/api/auth/login", undefined, { email: addr, password: PASSWORD }));
  const ver = await verify2fa(req("POST", "/api/auth/2fa/verify", cookieOf(res), { code: codeFor(secret) }));
  expect(ver.status).toBe(200);
  return cookieOf(ver);
}

let t0 = Math.floor(Date.now() / 1000) - 600;
async function inbound(t: T, waId: string, body: string) {
  const r = await ingestBatch({ phoneNumberId: t.phoneId, statuses: [], messages: [{ waId, name: "Cliente", waMessageId: `wamid.${RUN}.${seq++}`, at: new Date(++t0 * 1000), type: "text", body }] });
  return r.inbound[0]!.messageId;
}
const job = (t: T, messageId: string) => ({ tenantId: t.tenantId, messageId });
const sent = (): SendResult => ({ kind: "sent", waMessageId: `wamid.out.${randomUUID()}` });
function deps(opts: { result?: SendResult; fail?: () => never } = {}) {
  const llm = { name: "stub", generate: vi.fn(async () => { if (opts.fail) opts.fail(); return { text: "Abrimos de 8am a 5pm.", inputTokens: 10, outputTokens: 5, model: "stub" }; }) };
  const send = vi.fn(async () => opts.result ?? sent());
  return { llm, send, raw: { llm: llm as unknown as LlmProvider, send: send as never } };
}
const convOf = (t: T) => withTenant(t.tenantId, async (db) => (await db.query("SELECT status, handoff_reason FROM conversations")).rows[0] as { status: string; handoff_reason: string | null });
const usageOf = (t: T, table = "agent_usage_daily") => withTenant(t.tenantId, async (db) => (await db.query(`SELECT * FROM ${table} WHERE tenant_id = $1`, [t.tenantId])).rows[0]);
const events = (t: T) => withTenant(t.tenantId, async (db) => (await db.query("SELECT kind FROM agent_events ORDER BY created_at")).rows.map((r) => r.kind as string));
const seedUsage = (t: T, table: "agent_usage_daily" | "copilot_usage_daily", input: number, output: number) =>
  withTenant(t.tenantId, (db) => db.query(`INSERT INTO ${table} (tenant_id, day, input_tokens, output_tokens) VALUES ($1, (now() AT TIME ZONE 'utc')::date, $2, $3)`, [t.tenantId, input, output]));
const blockedState: AiGuardState = { blocked: true, reason: "presupuesto", spendUsd: 10, budgetUsd: 10, budgetPct: 100, budgetSet: true, dayTokens: 0, dayLimit: 1000, dayPct: 0, monthIn: 0, monthOut: 0 };

beforeAll(async () => { await getPool().query("SELECT 1"); });
afterEach(() => { vi.unstubAllEnvs(); resetAiGuardCache(); });
afterAll(async () => {
  await closeLockClient();
  await owner.query("DELETE FROM users WHERE email LIKE $1", [`cg-${RUN}-%`]);
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

describe("decisión del presupuesto (ai_guard_eval)", () => {
  const ev = async (...a: (number | null)[]) => (await getPool().query("SELECT ai_guard_eval($1,$2,$3,$4,$5,$6,$7) AS r", a)).rows[0].r;
  it("calcula gasto y porcentajes con precios por millón de tokens", async () => {
    const r = await ev(10, 1, 2, 1000, 1_000_000, 1_000_000, 500);
    expect(r).toMatchObject({ spendUsd: 3, budgetPct: 30, dayPct: 50, blocked: false, reason: null });
  });
  it("corta al llegar al 100 % del presupuesto (justo en el límite ya corta) y dice por qué", async () => {
    expect(await ev(3, 1, 2, 1000, 1_000_000, 1_000_000, 0)).toMatchObject({ blocked: true, reason: "presupuesto" });
    expect(await ev(3.01, 1, 2, 1000, 1_000_000, 1_000_000, 0)).toMatchObject({ blocked: false });
  });
  it("corta por tokens del día aunque no haya presupuesto; sin presupuesto el gasto no corta", async () => {
    expect(await ev(null, 1, 2, 1000, 0, 0, 1000)).toMatchObject({ blocked: true, reason: "tokens_dia", budgetPct: 0 });
    expect(await ev(null, 1, 2, 1000, 9e12, 9e12, 999)).toMatchObject({ blocked: false });
  });
  it("si coinciden, el presupuesto manda en el motivo", async () => {
    expect(await ev(1, 1, 1, 10, 1_000_000, 0, 10)).toMatchObject({ blocked: true, reason: "presupuesto" });
  });
});

describe("estado global (ai_guard_state)", () => {
  it("suma los tokens de hoy de asistente y copiloto; el tope diario por defecto corta; los avisos del 50/80/100 se anotan una sola vez", async () => {
    const t = await register("estado");
    const h = hashOf(await superAdmin("adm-estado"));
    await seedUsage(t, "agent_usage_daily", 4000, 1000);
    await seedUsage(t, "copilot_usage_daily", 600, 400);
    // Todo dentro de una transacción que se deshace: así no quedan avisos falsos en la base.
    const c = await getPool().connect();
    try {
      await c.query("BEGIN");
      const low = parseGuardState((await c.query("SELECT ai_guard_state($1) AS s", [1_000_000_000_000])).rows[0].s);
      expect(low.blocked).toBe(false);
      expect(low.dayTokens).toBeGreaterThanOrEqual(6000);
      const D = low.dayTokens; // el tope por defecto manda cuando los ajustes no fijan otro: justo en D corta, en D + 1 todavía no
      const cut = parseGuardState((await c.query("SELECT ai_guard_state($1) AS s", [D])).rows[0].s);
      expect(cut).toMatchObject({ blocked: true, reason: "tokens_dia", dayLimit: D });
      expect(parseGuardState((await c.query("SELECT ai_guard_state($1) AS s", [D + 1])).rows[0].s)).toMatchObject({ blocked: false, dayLimit: D + 1 });
      const today = (await c.query("SELECT to_char((now() AT TIME ZONE 'utc')::date, 'YYYY-MM-DD') AS d")).rows[0].d as string;
      const levels = async () => {
        const b = (await c.query("SELECT admin_ai_budget_get($1, $2) AS b", [h, 1000])).rows[0].b as { alerts: { kind: string; period: string; level: number }[] };
        return b.alerts.filter((a) => a.kind === "tokens_dia" && a.period === today).map((a) => a.level).sort((x, y) => x - y);
      };
      expect(await levels()).toEqual([50, 80, 100]);
      expect(await levels()).toEqual([50, 80, 100]); // llamar otra vez no repite los avisos
      await expect(c.query("SELECT ai_guard_state(0)")).rejects.toMatchObject({ code: "22023" });
    } finally { await c.query("ROLLBACK"); c.release(); }
  });

  it("la aplicación no puede leer ni escribir los ajustes ni los avisos por su cuenta", async () => {
    for (const q of ["SELECT * FROM ai_budget", "UPDATE ai_budget SET monthly_budget_usd = 1", "SELECT * FROM ai_budget_alerts", "INSERT INTO ai_budget_alerts (kind, period, level, value) VALUES ('tokens_dia', now(), 50, 1)"]) {
      await expect(getPool().query(q)).rejects.toMatchObject({ code: "42501" });
    }
  });

  it("getAiGuard guarda 15 s un estado normal pero NUNCA uno bloqueado (el corte se levanta en cuanto se sube el tope)", async () => {
    const spy = vi.spyOn(getPool(), "query");
    const raw = (blocked: boolean) => ({ rows: [{ s: { blocked, reason: blocked ? "presupuesto" : null, spendUsd: 1, budgetUsd: 1, budgetPct: blocked ? 100 : 10, budgetSet: true, dayTokens: 1, dayLimit: 100, dayPct: 1, monthIn: 1, monthOut: 1 } }] });
    try {
      resetAiGuardCache();
      spy.mockResolvedValueOnce(raw(false) as never);
      expect((await getAiGuard()).blocked).toBe(false);
      expect((await getAiGuard()).blocked).toBe(false); // de la caché: no consulta otra vez
      expect(spy).toHaveBeenCalledTimes(1);

      resetAiGuardCache();
      spy.mockClear();
      spy.mockResolvedValueOnce(raw(true) as never);
      expect((await getAiGuard()).blocked).toBe(true);
      spy.mockResolvedValueOnce(raw(false) as never);
      expect((await getAiGuard()).blocked).toBe(false); // volvió a preguntar y ya no está bloqueado
      expect(spy).toHaveBeenCalledTimes(2);
    } finally { spy.mockRestore(); resetAiGuardCache(); }
  });
});

describe("tokens: se cuentan al llamar, no al enviar", () => {
  it("recordAiUsage suma tokens y llamadas; ignora cifras raras", async () => {
    const t = await register("uso");
    await recordAiUsage(t.tenantId, "agent", 10, 5);
    await recordAiUsage(t.tenantId, "agent", Number.NaN, -3);
    expect(await usageOf(t)).toMatchObject({ input_tokens: "10", output_tokens: "5", ai_calls: 2, replies: 0 });
    expect(await tenantTokens(t.tenantId, "agent")).toEqual({ day: 15, month: 15 });
    expect(await tenantTokens(t.tenantId, "copilot")).toEqual({ day: 0, month: 0 });
  });

  it("si el envío se reintenta, la IA ya gastada queda anotada (y la respuesta aún no cuenta)", async () => {
    const t = await register("reintento-envio");
    const d = deps({ result: { kind: "retry", reason: "red" } as SendResult });
    await expect(runAgent(job(t, await inbound(t, newWaId(), "hola")), d.raw)).rejects.toThrow();
    expect(await usageOf(t)).toMatchObject({ input_tokens: "10", output_tokens: "5", replies: 0, ai_calls: 1 });
  });

  it("una respuesta enviada suma 1 respuesta y los tokens una sola vez", async () => {
    const t = await register("enviada");
    expect(await runAgent(job(t, await inbound(t, newWaId(), "hola")), deps().raw)).toBe("replied");
    expect(await usageOf(t)).toMatchObject({ input_tokens: "10", output_tokens: "5", replies: 1, ai_calls: 1 });
  });
});

describe("topes de tokens por negocio", () => {
  it("tope diario: no llama a la IA y pasa a una persona; otro negocio sigue", async () => {
    vi.stubEnv("AGENT_TENANT_DAILY_TOKEN_LIMIT", "1000");
    const t = await register("tope-dia");
    await seedUsage(t, "agent_usage_daily", 900, 100);
    const d = deps();
    expect(await runAgent(job(t, await inbound(t, newWaId(), "hola")), d.raw)).toBe("limit_reached");
    expect(d.llm.generate).not.toHaveBeenCalled();
    expect(d.send).not.toHaveBeenCalled();
    expect(await convOf(t)).toEqual({ status: "human", handoff_reason: "limite_tokens" });
    expect(await events(t)).toContain("limite_tokens");
    const task = await withTenant(t.tenantId, async (db) => (await db.query("SELECT detail FROM work_items WHERE type = 'atencion_humana'")).rows);
    expect(task[0].detail).toMatch(/tope de consumo de IA/);

    const other = await register("tope-dia-otro");
    expect(await runAgent(job(other, await inbound(other, newWaId(), "hola")), deps().raw)).toBe("replied");
  });

  it("justo debajo del tope diario todavía responde", async () => {
    vi.stubEnv("AGENT_TENANT_DAILY_TOKEN_LIMIT", "1000");
    const t = await register("tope-debajo");
    await seedUsage(t, "agent_usage_daily", 600, 399);
    expect(await runAgent(job(t, await inbound(t, newWaId(), "hola")), deps().raw)).toBe("replied");
  });

  it("tope mensual: cuenta los tokens de días anteriores del mes", async () => {
    vi.stubEnv("AGENT_TENANT_MONTHLY_TOKEN_LIMIT", "1000");
    const t = await register("tope-mes");
    // Ayer solo es «de este mes» si hoy no es día 1 (UTC); en ese caso se usa hoy, que también cuenta para el mes.
    await withTenant(t.tenantId, (db) => db.query("INSERT INTO agent_usage_daily (tenant_id, day, input_tokens) VALUES ($1, GREATEST((now() AT TIME ZONE 'utc')::date - 1, date_trunc('month', now() AT TIME ZONE 'utc')::date), 1500)", [t.tenantId]));
    const d = deps();
    expect(await runAgent(job(t, await inbound(t, newWaId(), "hola")), d.raw)).toBe("limit_reached");
    expect(d.llm.generate).not.toHaveBeenCalled();
    expect(await convOf(t)).toMatchObject({ handoff_reason: "limite_tokens" });
  });

  it("copiloto: el tope de tokens del día corta antes de llamar a la IA y no cuenta la pregunta", async () => {
    vi.stubEnv("COPILOT_TENANT_DAILY_TOKEN_LIMIT", "1000");
    const t = await register("cop-tope");
    await seedUsage(t, "copilot_usage_daily", 700, 300);
    const llm = { name: "stub", generate: vi.fn(async () => ({ text: "ok", inputTokens: 1, outputTokens: 1, model: "s" })) };
    expect(await askCopilot({ tenantId: t.tenantId, businessName: "X", question: "¿cómo voy?" }, { llm: llm as unknown as LlmProvider })).toEqual({ kind: "limit" });
    expect(llm.generate).not.toHaveBeenCalled();
    expect(await usageOf(t, "copilot_usage_daily")).toMatchObject({ questions: 0 });
  });
});

describe("corte global", () => {
  it("con la IA en pausa el asistente no llama al modelo y pasa a una persona", async () => {
    const t = await register("pausa");
    vi.mocked(getAiGuard).mockResolvedValueOnce(blockedState);
    const d = deps();
    expect(await runAgent(job(t, await inbound(t, newWaId(), "hola")), d.raw)).toBe("limit_reached");
    expect(d.llm.generate).not.toHaveBeenCalled();
    expect(await convOf(t)).toEqual({ status: "human", handoff_reason: "ia_pausada" });
    expect(await events(t)).toContain("ia_pausada");
  });

  it("si no se puede consultar el estado, NO se gasta IA (el trabajo se reintenta)", async () => {
    const t = await register("pausa-error");
    vi.mocked(getAiGuard).mockRejectedValueOnce(new Error("base caída"));
    const d = deps();
    await expect(runAgent(job(t, await inbound(t, newWaId(), "hola")), d.raw)).rejects.toThrow("base caída");
    expect(d.llm.generate).not.toHaveBeenCalled();
  });

  it("con la IA en pausa el copiloto no responde ni gasta cupo; por la API da 503", async () => {
    const t = await register("pausa-cop");
    const llm = { name: "stub", generate: vi.fn(async () => ({ text: "ok", inputTokens: 1, outputTokens: 1, model: "s" })) };
    vi.mocked(getAiGuard).mockResolvedValueOnce(blockedState);
    expect(await askCopilot({ tenantId: t.tenantId, businessName: "X", question: "hola" }, { llm: llm as unknown as LlmProvider })).toEqual({ kind: "paused" });
    expect(llm.generate).not.toHaveBeenCalled();
    expect(await usageOf(t, "copilot_usage_daily")).toBeUndefined();
    vi.mocked(getAiGuard).mockResolvedValueOnce(blockedState);
    const res = await askRoute(req("POST", "/api/copilot", t.cookie, { question: "¿cómo voy?" }));
    expect(res.status).toBe(503);
    expect((await res.json()).error).toBe("ia_pausada");
  });
});

describe("reintentos, bucles y picos", () => {
  it("un mismo mensaje no puede llamar a la IA más de N veces aunque la cola reintente", async () => {
    vi.stubEnv("AGENT_MESSAGE_CALL_LIMIT", "2");
    const t = await register("reintentos");
    const m = await inbound(t, newWaId(), "hola");
    const d = deps({ fail: () => { throw new LlmError("429", true, 429); } });
    await expect(runAgent(job(t, m), d.raw)).rejects.toThrow("429");
    await expect(runAgent(job(t, m), d.raw)).rejects.toThrow("429");
    expect(await runAgent(job(t, m), d.raw)).toBe("limit_reached");
    expect(d.llm.generate).toHaveBeenCalledTimes(2);
    expect(await convOf(t)).toEqual({ status: "human", handoff_reason: "reintentos_ia" });
    expect(await events(t)).toContain("reintentos_ia");
    expect(await usageOf(t)).toMatchObject({ ai_errors: 2, ai_calls: 2 });
  });

  it("reserveMessageCall es atómico y respeta el máximo", async () => {
    const t = await register("reserva");
    const m = await inbound(t, newWaId(), "hola");
    const r = await Promise.all([1, 2, 3, 4].map(() => reserveMessageCall(t.tenantId, m, 2)));
    expect(r.filter(Boolean)).toHaveLength(2);
  });

  it("bucle: demasiados mensajes entrantes en pocos minutos (otro bot) cortan antes de gastar IA", async () => {
    vi.stubEnv("AGENT_LOOP_INBOUND_LIMIT", "3");
    const t = await register("bucle");
    const wa = newWaId();
    await inbound(t, wa, "uno");
    await inbound(t, wa, "dos");
    const last = await inbound(t, wa, "tres");
    const d = deps();
    expect(await runAgent(job(t, last), d.raw)).toBe("limit_reached");
    expect(d.llm.generate).not.toHaveBeenCalled();
    expect(await convOf(t)).toEqual({ status: "human", handoff_reason: "posible_bucle" });
    expect(await events(t)).toContain("bucle");
  });

  it("dos mensajes seguidos (por debajo del límite) siguen respondiendo normal", async () => {
    vi.stubEnv("AGENT_LOOP_INBOUND_LIMIT", "3");
    const t = await register("sin-bucle");
    const wa = newWaId();
    await inbound(t, wa, "uno");
    expect(await runAgent(job(t, await inbound(t, wa, "dos")), deps().raw)).toBe("replied");
  });

  it("pico: demasiadas respuestas del negocio en una hora detienen al asistente", async () => {
    vi.stubEnv("AGENT_TENANT_HOURLY_REPLY_LIMIT", "2");
    const t = await register("pico");
    const wa = newWaId();
    const d = deps();
    expect(await runAgent(job(t, await inbound(t, wa, "uno")), d.raw)).toBe("replied");
    expect(await runAgent(job(t, await inbound(t, wa, "dos")), d.raw)).toBe("replied");
    expect(await runAgent(job(t, await inbound(t, wa, "tres")), d.raw)).toBe("limit_reached");
    expect(d.llm.generate).toHaveBeenCalledTimes(2);
    expect(await convOf(t)).toEqual({ status: "human", handoff_reason: "pico_de_uso" });
  });
});

describe("administración de costos", () => {
  it("solo un súper admin con verificación en dos pasos lee o cambia los ajustes", async () => {
    const t = await register("noadmin");
    await expect(getPool().query("SELECT admin_ai_budget_get($1, 1000000)", [hashOf(t.cookie)])).rejects.toMatchObject({ code: "42501" });
    await expect(getPool().query("SELECT admin_ai_budget_set($1, 10, 1, 1, NULL)", [hashOf(t.cookie)])).rejects.toMatchObject({ code: "42501" });
    expect((await putCosts(req("PUT", "/api/admin/costos", undefined, { monthlyBudgetUsd: 10, priceInUsdPerMtok: 1, priceOutUsdPerMtok: 1, dailyTokenLimit: null }))).status).toBe(404); // a quien no es súper admin se le responde como si no existiera
    const res = await putCosts(req("PUT", "/api/admin/costos", t.cookie, { monthlyBudgetUsd: 10, priceInUsdPerMtok: 1, priceOutUsdPerMtok: 1, dailyTokenLimit: null }));
    expect([403, 404]).toContain(res.status);
  });

  it("guarda ajustes válidos, valida los inválidos, no cambia lo anterior si falla", async () => {
    const adm = await superAdmin("adm");
    const h = hashOf(adm);
    const before = await getAdminBudget(h);
    const put = (body: unknown, c = adm) => putCosts(req("PUT", "/api/admin/costos", c, body));
    try {
      // Presupuesto enorme: no puede cortar a nadie mientras dura la prueba.
      const ok = await put({ monthlyBudgetUsd: 1_000_000, priceInUsdPerMtok: 0.5, priceOutUsdPerMtok: 2, dailyTokenLimit: 5_000_000_000 });
      expect(ok.status).toBe(200);
      const saved = await getAdminBudget(h);
      expect(saved.settings).toEqual({ monthlyBudgetUsd: 1_000_000, priceInUsdPerMtok: 0.5, priceOutUsdPerMtok: 2, dailyTokenLimit: 5_000_000_000 });
      expect(saved.state.budgetSet).toBe(true);
      expect(saved.state.blocked).toBe(false);

      for (const bad of [
        { monthlyBudgetUsd: 10, priceInUsdPerMtok: 0, priceOutUsdPerMtok: 0, dailyTokenLimit: null }, // presupuesto sin precios
        { monthlyBudgetUsd: -5, priceInUsdPerMtok: 1, priceOutUsdPerMtok: 1, dailyTokenLimit: null },
        { monthlyBudgetUsd: 10, priceInUsdPerMtok: -1, priceOutUsdPerMtok: 1, dailyTokenLimit: null },
        { monthlyBudgetUsd: 10, priceInUsdPerMtok: 1, priceOutUsdPerMtok: 1, dailyTokenLimit: 5 },
        { monthlyBudgetUsd: "mucho", priceInUsdPerMtok: 1, priceOutUsdPerMtok: 1, dailyTokenLimit: null },
        { monthlyBudgetUsd: 10, priceInUsdPerMtok: 1, priceOutUsdPerMtok: 1 },
      ]) expect((await put(bad)).status).toBe(400);
      await expect(setAdminBudget(h, { monthlyBudgetUsd: 10, priceInUsdPerMtok: 0, priceOutUsdPerMtok: 0, dailyTokenLimit: null })).rejects.toMatchObject({ code: "22023" });
      expect((await getAdminBudget(h)).settings).toEqual(saved.settings); // nada cambió

      expect((await put({ monthlyBudgetUsd: 10, priceInUsdPerMtok: 1, priceOutUsdPerMtok: 1, dailyTokenLimit: null }, "sid=falso")).status).toBe(404);
      // La auditoría de estos cambios no tiene negocio (tenant_id NULL) y solo la leen funciones de la base; se comprobó a mano con el superusuario.
    } finally {
      // Se deja como estaba (sin presupuesto), para no afectar a nadie.
      await setAdminBudget(h, { monthlyBudgetUsd: before.settings.monthlyBudgetUsd, priceInUsdPerMtok: before.settings.priceInUsdPerMtok, priceOutUsdPerMtok: before.settings.priceOutUsdPerMtok, dailyTokenLimit: before.settings.dailyTokenLimit });
    }
    expect((await getAdminBudget(h)).settings).toEqual(before.settings);
  });

  it("el top del mes incluye el negocio con su gasto estimado (todo dentro de una transacción que se deshace)", async () => {
    const h = hashOf(await superAdmin("adm-top"));
    const t = await register("top");
    await seedUsage(t, "agent_usage_daily", 3_000_000_000_000, 1_000_000_000_000);
    const c = await getPool().connect();
    try {
      await c.query("BEGIN");
      await c.query("SELECT admin_ai_budget_set($1, 10000000, 1, 2, 1000000000000)", [h]);
      const b = (await c.query("SELECT admin_ai_budget_get($1, 1000000) AS b", [h])).rows[0].b as { top: { name: string; tokens: number; spendUsd: number }[]; state: { blocked: boolean } };
      const row = b.top.find((r) => r.name === "Costos top");
      expect(Number(row!.tokens)).toBe(4_000_000_000_000);
      expect(Number(row!.spendUsd)).toBe(5_000_000);
      expect(b.top.length).toBeLessThanOrEqual(10);
    } finally {
      await c.query("ROLLBACK");
      c.release();
      await withTenant(t.tenantId, (db) => db.query("DELETE FROM agent_usage_daily"));
    }
  });
});

describe("aviso del Resumen (budgetAttention)", () => {
  const base: AiGuardState = { blocked: false, reason: null, spendUsd: 0, budgetUsd: null, budgetPct: 0, budgetSet: false, dayTokens: 0, dayLimit: 1000, dayPct: 0, monthIn: 0, monthOut: 0 };
  it("no avisa por debajo del 50 %; avisa desde el 50 % con el porcentaje correcto; en pausa avisa siempre", () => {
    expect(budgetAttention(base)).toBeNull();
    expect(budgetAttention({ ...base, budgetSet: true, budgetPct: 49.9 })).toBeNull();
    expect(budgetAttention({ ...base, budgetSet: true, budgetPct: 50 })).toMatchObject({ n: 50, href: "/admin/costos" });
    expect(budgetAttention({ ...base, budgetSet: true, budgetPct: 83.7, dayPct: 20 })).toMatchObject({ n: 83, text: expect.stringContaining("presupuesto") });
    expect(budgetAttention({ ...base, dayPct: 91 })).toMatchObject({ n: 91, text: expect.stringContaining("diario") });
    expect(budgetAttention({ ...base, budgetPct: 99 })).toBeNull(); // sin presupuesto fijado el porcentaje del presupuesto no cuenta
    expect(budgetAttention({ ...base, blocked: true, reason: "tokens_dia", dayPct: 100 })).toMatchObject({ n: 100 });
  });
});
