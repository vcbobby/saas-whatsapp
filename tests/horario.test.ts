import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { POST as signup } from "@/app/api/auth/signup/route";
import { GET as me } from "@/app/api/me/route";
import { GET as hoursGet, PUT as hoursPut } from "@/app/api/hours/route";
import { POST as teamInvite } from "@/app/api/team/invite/route";
import { POST as inviteSignup } from "@/app/api/invitations/signup/route";
import { closedNotice, hmLabel, isOpen, nextOpening, openingText, scheduleText, type Range } from "@/lib/hours/pure";
import { runAgent } from "@/lib/agent/run";
import { type LlmProvider } from "@/lib/ai/provider";
import { encryptSecret } from "@/lib/crypto";
import { getPool, withTenant } from "@/lib/db";
import { closeLockClient } from "@/lib/queue/lock";
import { ingestBatch } from "@/lib/whatsapp/ingest";
import type { SendResult } from "@/lib/whatsapp/graph";

process.env.WHATSAPP_APP_SECRET = "secreto-de-prueba-de-la-app-meta";
process.env.WHATSAPP_VERIFY_TOKEN = "token-de-verificacion-de-prueba-123456";
const RUN = randomUUID().slice(0, 8);
process.env.QUEUE_PREFIX = `test-h-${RUN}`;
const ORIGIN = new URL(process.env.APP_URL!).origin;
const PASSWORD = "contraseña-de-prueba-123";
const TOKEN = "EAAtoken-de-prueba-del-negocio-1234567890";
const owner = new Pool({ connectionString: process.env.MIGRATION_DATABASE_URL, max: 2 });
const tenantIds: string[] = [];
let seq = 0;
const newPhoneId = () => `6${RUN.replace(/\D/g, "").padEnd(4, "3").slice(0, 4)}${Date.now() % 100000}${seq++}`.slice(0, 18);
const newWaId = () => `58412${String(Date.now()).slice(-6)}${seq++}`.slice(0, 15);

function api(method: string, path: string, cookie?: string, body?: unknown, origin = ORIGIN) {
  return new Request(`${ORIGIN}${path}`, {
    method,
    headers: { origin, ...(body !== undefined ? { "content-type": "application/json" } : {}), ...(cookie ? { cookie } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

async function register(name: string, opts: { agent?: boolean; instructions?: string } = {}) {
  const email = `hr-${RUN}-${name}@example.test`;
  const res = await signup(api("POST", "/api/auth/signup", undefined, { email, password: PASSWORD, businessName: `Negocio ${name}` }));
  expect(res.status).toBe(201);
  const cookie = (res.headers.get("set-cookie") ?? "").split(";")[0]!;
  const info = await (await me(api("GET", "/api/me", cookie))).json();
  const tenantId = info.tenant.id as string;
  tenantIds.push(tenantId);
  const phoneId = newPhoneId();
  const { payload, keyVersion } = encryptSecret(TOKEN, `wa:${tenantId}:${phoneId}`);
  await owner.query("INSERT INTO tenant_integrations (tenant_id, provider, external_id, secret_enc, key_version) VALUES ($1,'whatsapp',$2,$3,$4)", [tenantId, phoneId, payload, keyVersion]);
  if (opts.agent !== false) {
    await withTenant(tenantId, (db) => db.query("INSERT INTO tenant_agents (tenant_id, enabled, assistant_name, instructions) VALUES ($1, true, 'Ana', $2)", [tenantId, opts.instructions ?? "Abrimos de 8am a 5pm. Corte: $10."]));
  }
  return { tenantId, phoneId, cookie, email };
}

type T = Awaited<ReturnType<typeof register>>;
const planSeq = 0;
const planRows: string[] = [];
let t0 = Math.floor(Date.now() / 1000) - 600;
/** Crea un mensaje entrante (como lo haría el webhook) y devuelve su id. */
async function inbound(t: T, waId: string, body: string | null, type = "text") {
  const r = await ingestBatch({ phoneNumberId: t.phoneId, statuses: [], messages: [{ waId, name: "Cliente", waMessageId: `wamid.${RUN}.${seq++}`, at: new Date(++t0 * 1000), type, body }] });
  return r.inbound[0]!.messageId;
}
const job = (t: T, messageId: string) => ({ tenantId: t.tenantId, messageId });

const sent = (id = `wamid.out.${randomUUID()}`): SendResult => ({ kind: "sent", waMessageId: id });
function deps(opts: { text?: string; result?: SendResult | (() => SendResult | Promise<SendResult>); delay?: number } = {}) {
  const llm = { name: "stub", generate: vi.fn(async () => { if (opts.delay) await new Promise((r) => setTimeout(r, opts.delay)); return { text: opts.text ?? "Hola, abrimos de 8am a 5pm.", inputTokens: 10, outputTokens: 5, model: "stub" }; }) };
  const send = vi.fn(async (...args: unknown[]) => (void args, typeof opts.result === "function" ? opts.result() : (opts.result ?? sent())));
  return { llm: llm as unknown as LlmProvider & { generate: ReturnType<typeof vi.fn> }, send, raw: { llm: llm as unknown as LlmProvider, send: send as never } };
}


beforeAll(async () => { await getPool().query("SELECT 1"); });
afterEach(() => { vi.unstubAllEnvs(); });

afterAll(async () => {
  await closeLockClient();
  await owner.query("DELETE FROM users WHERE email LIKE $1", [`hr-${RUN}-%`]);
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
  if (planRows.length) await owner.query("DELETE FROM plans WHERE id = ANY($1)", [planRows]);
  await owner.end();
  await getPool().end();
});


const WD = (n: number, a: number, b: number): Range => ({ weekday: n, startMin: a, endMin: b });
const TZ = "America/Caracas";
// 2026-11-02 es lunes. 15:00Z = 11:00 en Caracas (UTC-4).
const MON_11 = Date.parse("2026-11-02T15:00:00Z");

describe("horario: lógica", () => {
  const weekdays: Range[] = [1, 2, 3, 4, 5].map((n) => WD(n, 8 * 60, 17 * 60));
  it("etiquetas de hora", () => {
    expect(hmLabel(480)).toBe("8:00 a. m.");
    expect(hmLabel(13 * 60 + 30)).toBe("1:30 p. m.");
    expect(hmLabel(0)).toBe("12:00 a. m.");
    expect(hmLabel(1440)).toBe("medianoche");
  });
  it("abierto o cerrado", () => {
    expect(isOpen(weekdays, TZ, MON_11)).toBe(true);
    expect(isOpen(weekdays, TZ, Date.parse("2026-11-02T22:00:00Z"))).toBe(false); // 18:00
    expect(isOpen(weekdays, TZ, Date.parse("2026-11-07T15:00:00Z"))).toBe(false); // sábado
    expect(isOpen(weekdays, TZ, Date.parse("2026-11-02T21:00:00Z"))).toBe(false); // 17:00 en punto ya cerró
    expect(isOpen([], TZ, MON_11)).toBe(false);
  });
  it("próxima apertura: hoy, mañana, el lunes, ninguna", () => {
    expect(openingText(nextOpening([WD(1, 14 * 60, 18 * 60)], TZ, MON_11)!)).toBe("hoy a las 2:00 p. m.");
    expect(openingText(nextOpening(weekdays, TZ, Date.parse("2026-11-02T22:00:00Z"))!)).toBe("mañana a las 8:00 a. m.");
    expect(openingText(nextOpening(weekdays, TZ, Date.parse("2026-11-06T22:00:00Z"))!)).toBe("el lunes a las 8:00 a. m.");
    expect(nextOpening([], TZ, MON_11)).toBeNull();
  });
  it("zona horaria: el mismo instante es otro día en otra zona", () => {
    // 02:00Z del lunes son las 22:00 del domingo en Caracas.
    expect(isOpen([WD(7, 20 * 60, 23 * 60)], TZ, Date.parse("2026-11-02T02:00:00Z"))).toBe(true);
  });
  it("aviso con y sin texto extra", () => {
    const late = Date.parse("2026-11-02T22:00:00Z");
    expect(closedNotice(weekdays, TZ, late)).toBe("Ahora estamos fuera de horario; una persona te atenderá mañana a las 8:00 a. m.");
    expect(closedNotice(weekdays, TZ, late, "  Urgencias: 0412-0000000 ")).toContain("Urgencias: 0412-0000000");
    expect(closedNotice([], TZ, late)).toBe("Ahora estamos fuera de horario; una persona te atenderá en cuanto volvamos.");
  });
  it("resumen del horario para el asistente agrupa días iguales", () => {
    expect(scheduleText([...weekdays, WD(6, 9 * 60, 13 * 60)])).toBe("lunes a viernes: 8:00 a. m. a 5:00 p. m.; sábado: 9:00 a. m. a 1:00 p. m.");
    expect(scheduleText([WD(1, 480, 720), WD(1, 840, 1080)])).toBe("lunes: 8:00 a. m. a 12:00 p. m. y 2:00 p. m. a 6:00 p. m.");
    expect(scheduleText([])).toBe("");
  });
});

/** Un tramo de 30 minutos, todos los días, que NO contiene el momento actual (en Caracas). */
function closedNowRanges() {
  const p = new Intl.DateTimeFormat("en-GB", { timeZone: TZ, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date());
  const nowMin = Number(p.find((x) => x.type === "hour")!.value) * 60 + Number(p.find((x) => x.type === "minute")!.value);
  const start = nowMin + 60 < 1380 ? nowMin + 60 : 0;
  return [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({ weekday, ranges: [{ start: formatHm(start), end: formatHm(start + 30) }] }));
}
const formatHm = (m: number) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
const allDay = [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({ weekday, ranges: [{ start: "00:00", end: "24:00" }] }));
const putHours = (t: { cookie: string }, b: object, origin = ORIGIN) => hoursPut(api("PUT", "/api/hours", t.cookie, b, origin));
const payload = (o: object = {}) => ({ enabled: true, timezone: TZ, closedNote: null, days: closedNowRanges(), ...o });

describe("horario: API", () => {
  it("guarda, lee, audita y comparte zona con la agenda", async () => {
    const t = await register("api");
    expect((await putHours(t, payload({ timezone: "America/Bogota", closedNote: "Urgencias: 0412" }))).status).toBe(200);
    const got = await (await hoursGet(api("GET", "/api/hours", t.cookie))).json();
    expect(got).toMatchObject({ enabled: true, timezone: "America/Bogota", closedNote: "Urgencias: 0412" });
    expect(got.ranges).toHaveLength(7);
    expect(got.sample).toContain("Urgencias: 0412");
    const tz = await withTenant(t.tenantId, async (db) => (await db.query("SELECT timezone FROM agenda_settings")).rows[0].timezone);
    expect(tz).toBe("America/Bogota");
    const n = await withTenant(t.tenantId, async (db) => (await db.query("SELECT count(*)::int n FROM audit_log WHERE action = 'hours.update'")).rows[0].n);
    expect(n).toBe(1);
  });
  it("valida: sin tramos no se activa, horas malas, cruces, zona inválida, origen ajeno, sin sesión", async () => {
    const t = await register("val");
    expect((await putHours(t, payload({ days: [] }))).status).toBe(400);
    expect((await putHours(t, payload({ enabled: false, days: [] }))).status).toBe(200);
    expect((await putHours(t, payload({ days: [{ weekday: 1, ranges: [{ start: "17:00", end: "08:00" }] }] }))).status).toBe(400);
    expect((await putHours(t, payload({ days: [{ weekday: 1, ranges: [{ start: "08:00", end: "12:00" }, { start: "11:00", end: "14:00" }] }] }))).status).toBe(400);
    expect((await putHours(t, payload({ timezone: "Marte/Olimpo" }))).status).toBe(400);
    expect((await putHours(t, payload({ closedNote: "x".repeat(301) }))).status).toBe(400);
    expect((await putHours(t, payload(), "https://malo.example")).status).toBe(403);
    expect((await hoursGet(api("GET", "/api/hours"))).status).toBe(401);
  });
  it("un agente no puede verlo ni cambiarlo, y otro negocio no ve el horario ajeno", async () => {
    const t = await register("perm");
    const email = `hr-${RUN}-agente@example.test`;
    const inv = await teamInvite(api("POST", "/api/team/invite", t.cookie, { email, role: "agent" }));
    expect(inv.status).toBe(201);
    const token = ((await inv.json()).inviteUrl as string).split("/").pop()!;
    const ok = await inviteSignup(api("POST", "/api/invitations/signup", undefined, { token, password: PASSWORD }));
    const agent = (ok.headers.get("set-cookie") ?? "").split(";")[0]!;
    expect((await hoursGet(api("GET", "/api/hours", agent))).status).toBe(403);
    expect((await putHours({ cookie: agent }, payload())).status).toBe(403);
    await putHours(t, payload());
    const other = await register("otro");
    expect((await (await hoursGet(api("GET", "/api/hours", other.cookie))).json()).ranges).toEqual([]);
  });
});

describe("horario: el asistente", () => {
  const ask = async (t: T) => {
    const m = await inbound(t, newWaId(), "quiero hablar con una persona");
    const d = deps();
    expect(await runAgent(job(t, m), d.raw)).toBe("handoff");
    return d;
  };
  it("fuera de horario: al pasar a una persona avisa cuándo lo atenderán", async () => {
    const t = await register("cerrado");
    await putHours(t, payload({ closedNote: "Urgencias: 0412" }));
    const d = await ask(t);
    const text = d.send.mock.calls[0]![3] as string;
    expect(text).toContain("te comunico con una persona");
    expect(text).toContain("fuera de horario");
    expect(text).toContain("Urgencias: 0412");
  });
  it("en horario, o apagado, o sin configurar: el mensaje no cambia", async () => {
    const open = await register("abierto");
    await putHours(open, payload({ days: allDay }));
    expect((await ask(open)).send.mock.calls[0]![3]).not.toContain("fuera de horario");
    const off = await register("apagado");
    await putHours(off, payload({ enabled: false }));
    expect((await ask(off)).send.mock.calls[0]![3]).not.toContain("fuera de horario");
    const none = await register("nada");
    expect((await ask(none)).send.mock.calls[0]![3]).not.toContain("fuera de horario");
  });
  it("el asistente conoce el horario (y no se avisa en una respuesta normal)", async () => {
    const t = await register("prompt");
    await putHours(t, payload());
    const m = await inbound(t, newWaId(), "¿Qué horario tienen?");
    const d = deps();
    expect(await runAgent(job(t, m), d.raw)).toBe("replied");
    const system = (d.llm.generate.mock.calls[0]![0] as { system: string }).system;
    expect(system).toContain("HORARIO DE ATENCIÓN");
    expect(system).toContain("NO hay personas atendiendo");
    expect(d.send.mock.calls[0]![3]).not.toContain("fuera de horario");
    const sin = await register("sinprompt");
    const m2 = await inbound(sin, newWaId(), "hola");
    const d2 = deps();
    await runAgent(job(sin, m2), d2.raw);
    expect((d2.llm.generate.mock.calls[0]![0] as { system: string }).system).not.toContain("HORARIO DE ATENCIÓN");
  });
});
