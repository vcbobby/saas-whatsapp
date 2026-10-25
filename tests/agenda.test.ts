import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { POST as signup } from "@/app/api/auth/signup/route";
import { GET as me } from "@/app/api/me/route";
import { GET as getConfig } from "@/app/api/agenda/config/route";
import { PUT as putSettings } from "@/app/api/agenda/settings/route";
import { PUT as putHours } from "@/app/api/agenda/hours/route";
import { POST as createService } from "@/app/api/agenda/services/route";
import { POST as updateService } from "@/app/api/agenda/services/update/route";
import { POST as createOff } from "@/app/api/agenda/time-off/route";
import { POST as deleteOff } from "@/app/api/agenda/time-off/delete/route";
import { GET as getSlots } from "@/app/api/agenda/slots/route";
import { can } from "@/lib/auth/permissions";
import { addDays, localDate } from "@/lib/agenda/tz";
import { encryptSecret } from "@/lib/crypto";
import { getPool, withTenant } from "@/lib/db";
import { closeLockClient } from "@/lib/queue/lock";


const RUN = randomUUID().slice(0, 8);
process.env.QUEUE_PREFIX = `test-a-${RUN}`;
const ORIGIN = new URL(process.env.APP_URL!).origin;
const PASSWORD = "contraseña-de-prueba-123";
const TOKEN = "EAAtoken-de-prueba-del-negocio-1234567890";
const owner = new Pool({ connectionString: process.env.MIGRATION_DATABASE_URL, max: 2 });
const tenantIds: string[] = [];
let seq = 0;
const newPhoneId = () => `7${RUN.replace(/\D/g, "").padEnd(4, "5").slice(0, 4)}${Date.now() % 100000}${seq++}`.slice(0, 18);

function api(method: string, path: string, cookie?: string, body?: unknown) {
  return new Request(`${ORIGIN}${path}`, {
    method,
    headers: { origin: ORIGIN, ...(body !== undefined ? { "content-type": "application/json" } : {}), ...(cookie ? { cookie } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

async function register(name: string, opts: { agent?: boolean } = {}) {
  const email = `ag-${RUN}-${name}@example.test`;
  const res = await signup(api("POST", "/api/auth/signup", undefined, { email, password: PASSWORD, businessName: `Negocio ${name}` }));
  expect(res.status).toBe(201);
  const cookie = (res.headers.get("set-cookie") ?? "").split(";")[0]!;
  const info = await (await me(api("GET", "/api/me", cookie))).json();
  const tenantId = info.tenant.id as string;
  tenantIds.push(tenantId);
  const phoneId = newPhoneId();
  const { payload, keyVersion } = encryptSecret(TOKEN, `wa:${tenantId}:${phoneId}`);
  await owner.query("INSERT INTO tenant_integrations (tenant_id, provider, external_id, secret_enc, key_version) VALUES ($1,'whatsapp',$2,$3,$4)", [tenantId, phoneId, payload, keyVersion]);
  if (opts.agent) {
    await withTenant(tenantId, (db) => db.query("INSERT INTO tenant_agents (tenant_id, enabled, assistant_name, instructions) VALUES ($1, true, 'Ana', 'Abrimos de 8am a 5pm.')", [tenantId]));
  }
  return { tenantId, phoneId, cookie };
}
type T = Awaited<ReturnType<typeof register>>;


beforeAll(async () => { await getPool().query("SELECT 1"); });

afterAll(async () => {
  await closeLockClient();
  await owner.query("DELETE FROM users WHERE email LIKE $1", [`ag-${RUN}-%`]);
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



const post = (fn: (r: Request) => Promise<Response>, path: string, t: T, body: unknown, method = "POST") => fn(api(method, path, t.cookie, body));
const putCfg = (t: T, o: Record<string, unknown> = {}) => post(putSettings, "/api/agenda/settings", t, { timezone: "America/Caracas", minNoticeMinutes: 120, maxDaysAhead: 30, slotStepMinutes: 30, ...o }, "PUT");
const putH = (t: T, days: unknown) => post(putHours, "/api/agenda/hours", t, { days }, "PUT");
const mkService = async (t: T, name = "Corte", durationMinutes = 60, extra: Record<string, unknown> = {}) => {
  const r = await post(createService, "/api/agenda/services", t, { name, durationMinutes, ...extra });
  return { status: r.status, id: (await r.json()).id as string };
};
const slots = async (t: T, serviceId: string, date: string, days = 1) => {
  const r = await getSlots(api("GET", `/api/agenda/slots?serviceId=${serviceId}&date=${date}&days=${days}`, t.cookie));
  return { status: r.status, body: await r.json() };
};
const timesOf = (b: { slots: { time: string }[] }) => b.slots.map((s) => s.time);
const ownerExec = async (tenantId: string, sql: string, params: unknown[] = []) => {
  const c = await owner.connect();
  try {
    await c.query("BEGIN");
    await c.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
    const r = await c.query(sql, params);
    await c.query("COMMIT");
    return r;
  } catch (e) {
    await c.query("ROLLBACK");
    throw e;
  } finally {
    c.release();
  }
};
const codeOf = async (p: Promise<unknown>) => { try { await p; return undefined; } catch (e) { return (e as { code?: string }).code; } };
/** Un día (en Caracas) dentro de 5 a 10 días, con su día de la semana. */
const future = (plus = 5) => {
  const date = addDays(localDate(Date.now(), "America/Caracas"), plus);
  const wd = ((new Date(date + "T00:00:00Z").getUTCDay() + 6) % 7) + 1;
  return { date, wd };
};
const allDays = (ranges: { start: string; end: string }[]) => [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({ weekday, ranges }));

describe("agenda: permisos", () => {
  it("leer la agenda: todos los roles; configurarla: solo dueño y administrador", () => {
    expect(can("owner", "agenda:manage")).toBe(true);
    expect(can("admin", "agenda:manage")).toBe(true);
    expect(can("agent", "agenda:manage")).toBe(false);
    for (const r of ["owner", "admin", "agent"] as const) expect(can(r, "agenda:read")).toBe(true);
    expect(can(null, "agenda:read")).toBe(false);
  });
});

describe("agenda: configuración (API)", () => {
  it("un negocio nuevo tiene valores por defecto y sin servicios ni horario", async () => {
    const t = await register("c1");
    const cfg = await (await getConfig(api("GET", "/api/agenda/config", t.cookie))).json();
    expect(cfg.settings).toEqual({ timezone: "America/Caracas", minNoticeMinutes: 120, maxDaysAhead: 30, slotStepMinutes: 30 });
    expect(cfg).toMatchObject({ hours: [], services: [], timeOff: [], canManage: true });
  });

  it("sin sesión: 401 en todo", async () => {
    expect((await getConfig(api("GET", "/api/agenda/config"))).status).toBe(401);
    expect((await putSettings(api("PUT", "/api/agenda/settings", undefined, {}))).status).toBe(401);
    expect((await getSlots(api("GET", `/api/agenda/slots?serviceId=${randomUUID()}&date=2030-01-01`))).status).toBe(401);
  });

  it("origen ajeno: 403 al modificar", async () => {
    const t = await register("c2");
    const bad = new Request(`${ORIGIN}/api/agenda/settings`, { method: "PUT", headers: { origin: "https://malo.example", "content-type": "application/json", cookie: t.cookie }, body: JSON.stringify({ timezone: "America/Caracas", minNoticeMinutes: 0, maxDaysAhead: 5, slotStepMinutes: 30 }) });
    expect((await putSettings(bad)).status).toBe(403);
  });

  it("guarda la zona horaria y las reglas; rechaza valores inválidos", async () => {
    const t = await register("c3");
    expect((await putCfg(t, { timezone: "America/Bogota", minNoticeMinutes: 30, maxDaysAhead: 60, slotStepMinutes: 15 })).status).toBe(200);
    const cfg = await (await getConfig(api("GET", "/api/agenda/config", t.cookie))).json();
    expect(cfg.settings).toEqual({ timezone: "America/Bogota", minNoticeMinutes: 30, maxDaysAhead: 60, slotStepMinutes: 15 });
    for (const bad of [{ timezone: "Mars/Olympus" }, { timezone: "UTC" }, { timezone: "x'; DROP TABLE" }, { minNoticeMinutes: -1 }, { minNoticeMinutes: 99999 }, { maxDaysAhead: 0 }, { maxDaysAhead: 400 }, { slotStepMinutes: 7 }, { slotStepMinutes: 1.5 }]) {
      expect((await putCfg(t, bad)).status).toBe(400);
    }
    expect((await (await getConfig(api("GET", "/api/agenda/config", t.cookie))).json()).settings.timezone).toBe("America/Bogota");
  });

  it("horario semanal: se guarda, se devuelve y un nuevo guardado lo reemplaza", async () => {
    const t = await register("h1");
    expect((await putH(t, [{ weekday: 1, ranges: [{ start: "09:00", end: "12:00" }, { start: "14:00", end: "18:00" }] }, { weekday: 6, ranges: [{ start: "08:00", end: "24:00" }] }])).status).toBe(200);
    let cfg = await (await getConfig(api("GET", "/api/agenda/config", t.cookie))).json();
    expect(cfg.hours).toEqual([{ weekday: 1, startMin: 540, endMin: 720 }, { weekday: 1, startMin: 840, endMin: 1080 }, { weekday: 6, startMin: 480, endMin: 1440 }]);
    expect((await putH(t, [{ weekday: 2, ranges: [{ start: "10:00", end: "11:00" }] }])).status).toBe(200);
    cfg = await (await getConfig(api("GET", "/api/agenda/config", t.cookie))).json();
    expect(cfg.hours).toEqual([{ weekday: 2, startMin: 600, endMin: 660 }]);
    expect((await putH(t, [])).status).toBe(200);
    expect((await (await getConfig(api("GET", "/api/agenda/config", t.cookie))).json()).hours).toEqual([]);
  });

  it("horario inválido: tramos cruzados, fin antes del inicio, formato, día repetido, más de 3 tramos; y NO borra el horario anterior", async () => {
    const t = await register("h2");
    await putH(t, [{ weekday: 1, ranges: [{ start: "09:00", end: "10:00" }] }]);
    const R = (start: string, end: string) => ({ start, end });
    const bads = [
      [{ weekday: 1, ranges: [R("09:00", "11:00"), R("10:00", "12:00")] }],
      [{ weekday: 1, ranges: [R("12:00", "09:00")] }],
      [{ weekday: 1, ranges: [R("09:00", "09:00")] }],
      [{ weekday: 1, ranges: [R("9:00", "10:00")] }],
      [{ weekday: 1, ranges: [R("09:00", "25:00")] }],
      [{ weekday: 1, ranges: [R("24:00", "24:00")] }],
      [{ weekday: 8, ranges: [R("09:00", "10:00")] }],
      [{ weekday: 1, ranges: [R("09:00", "10:00")] }, { weekday: 1, ranges: [R("11:00", "12:00")] }],
      [{ weekday: 1, ranges: [R("01:00", "02:00"), R("03:00", "04:00"), R("05:00", "06:00"), R("07:00", "08:00")] }],
    ];
    for (const b of bads) expect((await putH(t, b)).status).toBe(400);
    expect((await (await getConfig(api("GET", "/api/agenda/config", t.cookie))).json()).hours).toEqual([{ weekday: 1, startMin: 540, endMin: 600 }]);
  });

  it("tramos que se tocan (termina 12:00 / empieza 12:00) sí se permiten", async () => {
    const t = await register("h3");
    expect((await putH(t, [{ weekday: 1, ranges: [{ start: "09:00", end: "12:00" }, { start: "12:00", end: "14:00" }] }])).status).toBe(200);
  });
});

describe("agenda: servicios (API)", () => {
  it("crear, listar, cambiar y desactivar", async () => {
    const t = await register("s1");
    const a = await mkService(t, "Corte de cabello", 45, { priceText: "$8" });
    expect(a.status).toBe(201);
    let cfg = await (await getConfig(api("GET", "/api/agenda/config", t.cookie))).json();
    expect(cfg.services).toEqual([{ id: a.id, name: "Corte de cabello", durationMinutes: 45, priceText: "$8", active: true }]);
    expect((await post(updateService, "/api/agenda/services/update", t, { id: a.id, durationMinutes: 30, priceText: null })).status).toBe(200);
    expect((await post(updateService, "/api/agenda/services/update", t, { id: a.id, active: false })).status).toBe(200);
    cfg = await (await getConfig(api("GET", "/api/agenda/config", t.cookie))).json();
    expect(cfg.services[0]).toMatchObject({ durationMinutes: 30, priceText: null, active: false, name: "Corte de cabello" });
  });

  it("nombre repetido (sin importar mayúsculas) entre activos: 409; si el otro está inactivo, se puede reutilizar", async () => {
    const t = await register("s2");
    const a = await mkService(t, "Barba", 20);
    expect((await mkService(t, "  BARBA ", 20)).status).toBe(409);
    await post(updateService, "/api/agenda/services/update", t, { id: a.id, active: false });
    expect((await mkService(t, "Barba", 25)).status).toBe(201);
    // Reactivar el viejo choca con el nuevo
    expect((await post(updateService, "/api/agenda/services/update", t, { id: a.id, active: true })).status).toBe(409);
  });

  it("validación de servicios", async () => {
    const t = await register("s3");
    for (const bad of [{ name: "", durationMinutes: 30 }, { name: "x".repeat(81), durationMinutes: 30 }, { name: "A", durationMinutes: 4 }, { name: "A", durationMinutes: 481 }, { name: "A", durationMinutes: 30.5 }, { name: "A", durationMinutes: 30, priceText: "x".repeat(41) }]) {
      expect((await post(createService, "/api/agenda/services", t, bad)).status).toBe(400);
    }
  });

  it("máximo de 50 servicios activos", async () => {
    const t = await register("s4");
    await ownerExec(t.tenantId, "INSERT INTO agenda_services (tenant_id, name, duration_minutes) SELECT $1, 'S' || g, 30 FROM generate_series(1, 50) g", [t.tenantId]);
    const r = await post(createService, "/api/agenda/services", t, { name: "Uno más", durationMinutes: 30 });
    expect(r.status).toBe(409);
    expect((await r.json()).error).toBe("limite_servicios");
  });

  it("otro negocio no puede ver ni modificar mis servicios", async () => {
    const a = await register("s5");
    const b = await register("s6");
    const s = await mkService(a, "Privado", 30);
    expect((await post(updateService, "/api/agenda/services/update", b, { id: s.id, name: "Hackeado" })).status).toBe(404);
    expect((await (await getConfig(api("GET", "/api/agenda/config", b.cookie))).json()).services).toEqual([]);
    expect((await slots(b, s.id, future().date)).status).toBe(404);
  });
});

describe("agenda: bloqueos (API)", () => {
  const inDays = (n: number, h = 9) => new Date(Date.now() + n * 86_400_000 + h * 3_600_000).toISOString();

  it("crear, listar y quitar un bloqueo", async () => {
    const t = await register("o1");
    const r = await post(createOff, "/api/agenda/time-off", t, { startsAt: inDays(3), endsAt: inDays(5), reason: "Vacaciones" });
    expect(r.status).toBe(201);
    const { id, appointmentsInside } = await r.json();
    expect(appointmentsInside).toBe(0);
    let cfg = await (await getConfig(api("GET", "/api/agenda/config", t.cookie))).json();
    expect(cfg.timeOff).toHaveLength(1);
    expect(cfg.timeOff[0]).toMatchObject({ id, reason: "Vacaciones" });
    expect((await post(deleteOff, "/api/agenda/time-off/delete", t, { id })).status).toBe(200);
    expect((await post(deleteOff, "/api/agenda/time-off/delete", t, { id })).status).toBe(404);
    cfg = await (await getConfig(api("GET", "/api/agenda/config", t.cookie))).json();
    expect(cfg.timeOff).toEqual([]);
  });

  it("rechaza fechas al revés, ya pasadas, demasiado largas o mal escritas", async () => {
    const t = await register("o2");
    const same = inDays(3); // un solo valor: dos llamadas pueden diferir 1 ms bajo carga
    for (const bad of [
      { startsAt: inDays(5), endsAt: inDays(3) },
      { startsAt: same, endsAt: same },
      { startsAt: inDays(-5), endsAt: inDays(-3) },
      { startsAt: inDays(1), endsAt: inDays(500) },
      { startsAt: "mañana", endsAt: inDays(3) },
      { startsAt: inDays(1), endsAt: inDays(2), reason: "x".repeat(201) },
    ]) expect((await post(createOff, "/api/agenda/time-off", t, bad)).status).toBe(400);
  });

  it("avisa cuántas citas activas quedan dentro del bloqueo (sin tocarlas)", async () => {
    const t = await register("o3");
    const s = await mkService(t, "Corte", 60);
    const start = new Date(Date.now() + 4 * 86_400_000);
    await ownerExec(t.tenantId, "INSERT INTO appointments (tenant_id, service_id, customer_name, starts_at, ends_at, source, status) VALUES ($1,$2,'Ana',$3,$4,'manual','confirmada')", [t.tenantId, s.id, start, new Date(start.getTime() + 3_600_000)]);
    const r = await (await post(createOff, "/api/agenda/time-off", t, { startsAt: inDays(3), endsAt: inDays(6) })).json();
    expect(r.appointmentsInside).toBe(1);
    const still = await ownerExec(t.tenantId, "SELECT status FROM appointments");
    expect(still.rows[0].status).toBe("confirmada");
  });

  it("otro negocio no puede quitar mi bloqueo", async () => {
    const a = await register("o4");
    const b = await register("o5");
    const { id } = await (await post(createOff, "/api/agenda/time-off", a, { startsAt: inDays(3), endsAt: inDays(4) })).json();
    expect((await post(deleteOff, "/api/agenda/time-off/delete", b, { id })).status).toBe(404);
    expect((await (await getConfig(api("GET", "/api/agenda/config", a.cookie))).json()).timeOff).toHaveLength(1);
  });
});

describe("agenda: huecos libres (API)", () => {
  async function ready(name: string, o: Record<string, unknown> = {}) {
    const t = await register(name);
    await putCfg(t, o);
    await putH(t, allDays([{ start: "09:00", end: "12:00" }, { start: "14:00", end: "16:00" }]));
    const s = await mkService(t, "Consulta", 60);
    return { t, s: s.id };
  }

  it("devuelve los huecos del servicio en hora local, con instantes UTC", async () => {
    const { t, s } = await ready("l1");
    const { date } = future();
    const r = await slots(t, s, date);
    expect(r.status).toBe(200);
    expect(timesOf(r.body)).toEqual(["09:00", "09:30", "10:00", "10:30", "11:00", "14:00", "14:30", "15:00"]);
    expect(r.body.slots[0]).toMatchObject({ date, time: "09:00", startsAt: `${date}T13:00:00.000Z`, endsAt: `${date}T14:00:00.000Z` });
  });

  it("cambiar la zona horaria del negocio cambia los instantes UTC pero no la hora local", async () => {
    const { t, s } = await ready("l2", { timezone: "America/Santiago", maxDaysAhead: 120 });
    const { date } = future(40);
    const r = await slots(t, s, date);
    expect(r.body.slots[0].time).toBe("09:00");
    expect(r.body.slots[0].startsAt).not.toBe(`${date}T13:00:00.000Z`);
  });

  it("una cita activa quita los huecos que se cruzan; una cancelada no", async () => {
    const { t, s } = await ready("l3");
    const { date } = future();
    const start = new Date(`${date}T14:00:00Z`); // 10:00 local
    const ins = (status: string) => ownerExec(t.tenantId, "INSERT INTO appointments (tenant_id, service_id, customer_name, starts_at, ends_at, source, status) VALUES ($1,$2,'Ana',$3,$4,'manual',$5) RETURNING id", [t.tenantId, s, start, new Date(start.getTime() + 3_600_000), status]);
    const a = await ins("cancelada");
    expect(timesOf((await slots(t, s, date)).body)).toContain("10:00");
    await ownerExec(t.tenantId, "DELETE FROM appointments WHERE id = $1", [a.rows[0].id]);
    await ins("pendiente");
    expect(timesOf((await slots(t, s, date)).body)).toEqual(["09:00", "11:00", "14:00", "14:30", "15:00"]);
  });

  it("un bloqueo quita los huecos del periodo", async () => {
    const { t, s } = await ready("l4");
    const { date } = future();
    await post(createOff, "/api/agenda/time-off", t, { startsAt: `${date}T13:00:00Z`, endsAt: `${date}T15:00:00Z` }); // 09:00–11:00 local
    expect(timesOf((await slots(t, s, date)).body)).toEqual(["11:00", "14:00", "14:30", "15:00"]);
  });

  it("respeta el máximo de días hacia adelante y el preaviso", async () => {
    const { t, s } = await ready("l5", { maxDaysAhead: 3, minNoticeMinutes: 0 });
    expect((await slots(t, s, future(10).date)).body.slots).toEqual([]);
    const { t: t2, s: s2 } = await ready("l6", { minNoticeMinutes: 10080 });
    expect((await slots(t2, s2, future(2).date)).body.slots).toEqual([]);
    expect((await slots(t2, s2, future(9).date)).body.slots.length).toBeGreaterThan(0);
  });

  it("varios días a la vez, ordenados", async () => {
    const { t, s } = await ready("l7");
    const r = await slots(t, s, future().date, 3);
    const dates = [...new Set(r.body.slots.map((x: { date: string }) => x.date))];
    expect(dates).toHaveLength(3);
    expect(r.body.slots.map((x: { startsAt: string }) => x.startsAt)).toEqual([...r.body.slots.map((x: { startsAt: string }) => x.startsAt)].sort());
  });

  it("servicio inactivo o inexistente: 404; datos mal formados: 400", async () => {
    const { t, s } = await ready("l8");
    await post(updateService, "/api/agenda/services/update", t, { id: s, active: false });
    expect((await slots(t, s, future().date)).status).toBe(404);
    expect((await slots(t, randomUUID(), future().date)).status).toBe(404);
    for (const q of [`serviceId=no-uuid&date=2030-01-01`, `serviceId=${s}&date=2030-02-31`, `serviceId=${s}&date=ayer`, `serviceId=${s}&date=2030-01-01&days=0`, `serviceId=${s}&date=2030-01-01&days=99`]) {
      expect((await getSlots(api("GET", `/api/agenda/slots?${q}`, t.cookie))).status).toBe(400);
    }
  });
});

describe("agenda: base de datos (citas)", () => {
  async function ready(name: string) {
    const t = await register(name);
    const s = (await mkService(t)).id;
    const ins = (start: string, minutes: number, status = "confirmada", tenant = t, service = s) =>
      ownerExec(tenant.tenantId, "INSERT INTO appointments (tenant_id, service_id, customer_name, starts_at, ends_at, source, status) VALUES ($1,$2,'Ana',$3,$3::timestamptz + ($4 || ' minutes')::interval,'manual',$5) RETURNING id", [tenant.tenantId, service, start, String(minutes), status]);
    return { t, s, ins };
  }

  it("dos citas activas que se cruzan: la base de datos lo impide (23P01)", async () => {
    const { ins } = await ready("d1");
    await ins("2031-05-05T14:00:00Z", 60);
    expect(await codeOf(ins("2031-05-05T14:30:00Z", 60))).toBe("23P01");
    expect(await codeOf(ins("2031-05-05T13:30:00Z", 60))).toBe("23P01");
    expect(await codeOf(ins("2031-05-05T14:10:00Z", 10))).toBe("23P01"); // contenida
    expect(await codeOf(ins("2031-05-05T14:00:00Z", 60, "pendiente"))).toBe("23P01");
  });

  it("citas pegadas (una termina cuando empieza la otra) sí caben", async () => {
    const { ins } = await ready("d2");
    await ins("2031-05-05T14:00:00Z", 60);
    await ins("2031-05-05T15:00:00Z", 60);
    await ins("2031-05-05T13:00:00Z", 60);
  });

  it("las canceladas, completadas y no-asistió no bloquean; al reactivar una, vuelve a regir la regla", async () => {
    const { t, ins } = await ready("d3");
    for (const st of ["cancelada", "completada", "no_asistio"]) await ins("2031-05-06T14:00:00Z", 60, st);
    const a = await ins("2031-05-06T14:00:00Z", 60, "confirmada");
    expect(await codeOf(ownerExec(t.tenantId, "UPDATE appointments SET status = 'confirmada' WHERE status = 'cancelada'"))).toBe("23P01");
    await ownerExec(t.tenantId, "UPDATE appointments SET status = 'cancelada' WHERE id = $1", [a.rows[0].id]);
    await ownerExec(t.tenantId, "UPDATE appointments SET status = 'confirmada' WHERE status = 'completada'");
  });

  it("negocios distintos pueden tener citas a la misma hora", async () => {
    const a = await ready("d4");
    const b = await ready("d5");
    await a.ins("2031-05-07T14:00:00Z", 60);
    await b.ins("2031-05-07T14:00:00Z", 60);
  });

  it("una cita no puede usar el servicio de otro negocio", async () => {
    const a = await ready("d6");
    const b = await ready("d7");
    expect(await codeOf(a.ins("2031-05-08T14:00:00Z", 60, "confirmada", a.t, b.s))).toBe("23503");
  });

  it("fin antes del inicio y estados/origen inválidos se rechazan", async () => {
    const { t, s } = await ready("d8");
    const q = (start: string, end: string, st = "confirmada", src = "manual") => ownerExec(t.tenantId, "INSERT INTO appointments (tenant_id, service_id, customer_name, starts_at, ends_at, source, status) VALUES ($1,$2,'A',$3,$4,$6,$5)", [t.tenantId, s, start, end, st, src]);
    expect(await codeOf(q("2031-05-09T15:00:00Z", "2031-05-09T14:00:00Z"))).toBe("23514");
    expect(await codeOf(q("2031-05-09T14:00:00Z", "2031-05-09T15:00:00Z", "inventado"))).toBe("23514");
    expect(await codeOf(q("2031-05-09T14:00:00Z", "2031-05-09T15:00:00Z", "confirmada", "otro"))).toBe("23514");
  });

  it("la aplicación (app_user) solo ve las citas de su negocio", async () => {
    const a = await ready("d9");
    const b = await ready("d10");
    await a.ins("2031-05-10T14:00:00Z", 60);
    const seen = await withTenant(b.t.tenantId, async (db) => (await db.query("SELECT count(*)::int AS n FROM appointments")).rows[0].n);
    expect(seen).toBe(0);
    const mine = await withTenant(a.t.tenantId, async (db) => (await db.query("SELECT count(*)::int AS n FROM appointments")).rows[0].n);
    expect(mine).toBe(1);
  });

  it("horario: la base de datos también impide tramos cruzados y fuera de rango", async () => {
    const t = await register("d11");
    const q = (w: number, a: number, b: number) => withTenant(t.tenantId, (db) => db.query("INSERT INTO agenda_hours (tenant_id, weekday, start_min, end_min) VALUES ($1,$2,$3,$4)", [t.tenantId, w, a, b]));
    await q(1, 540, 720);
    expect(await codeOf(q(1, 600, 800))).toBe("23P01");
    await q(2, 600, 800);
    expect(await codeOf(q(1, 700, 600))).toBe("23514");
    expect(await codeOf(q(8, 100, 200))).toBe("23514");
    expect(await codeOf(q(3, 0, 1441))).toBe("23514");
  });
});
