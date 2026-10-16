import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { POST as signup } from "@/app/api/auth/signup/route";
import { GET as me } from "@/app/api/me/route";
import { GET as listAppts, POST as createAppt } from "@/app/api/agenda/appointments/route";
import { POST as updateAppt } from "@/app/api/agenda/appointments/update/route";
import { PUT as putSettings } from "@/app/api/agenda/settings/route";
import { PUT as putHours } from "@/app/api/agenda/hours/route";
import { POST as createService } from "@/app/api/agenda/services/route";
import { POST as createOff } from "@/app/api/agenda/time-off/route";
import { GET as getSlots } from "@/app/api/agenda/slots/route";
import { POST as updateService } from "@/app/api/agenda/services/update/route";
import { can } from "@/lib/auth/permissions";
import { ingestBatch } from "@/lib/whatsapp/ingest";
import { addDays, localDate, localToUtc } from "@/lib/agenda/tz";
import { encryptSecret } from "@/lib/crypto";
import { getPool, withTenant } from "@/lib/db";
import { closeLockClient } from "@/lib/queue/lock";
import { isSlotConflict } from "@/lib/agenda/conflict";


const RUN = randomUUID().slice(0, 8);
process.env.QUEUE_PREFIX = `test-p-${RUN}`;
const ORIGIN = new URL(process.env.APP_URL!).origin;
const PASSWORD = "contraseña-de-prueba-123";
const TOKEN = "EAAtoken-de-prueba-del-negocio-1234567890";
const owner = new Pool({ connectionString: process.env.MIGRATION_DATABASE_URL, max: 2 });
const tenantIds: string[] = [];
let seq = 0;
const newWaId = () => `58414${String(Date.now()).slice(-6)}${seq++}`.slice(0, 15);
const newPhoneId = () => `7${RUN.replace(/\D/g, "").padEnd(4, "5").slice(0, 4)}${Date.now() % 100000}${seq++}`.slice(0, 18);

function api(method: string, path: string, cookie?: string, body?: unknown) {
  return new Request(`${ORIGIN}${path}`, {
    method,
    headers: { origin: ORIGIN, ...(body !== undefined ? { "content-type": "application/json" } : {}), ...(cookie ? { cookie } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

async function register(name: string, opts: { agent?: boolean } = {}) {
  const email = `ap-${RUN}-${name}@example.test`;
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
  await owner.query("DELETE FROM users WHERE email LIKE $1", [`ap-${RUN}-%`]);
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




type TT = T;
const post = (fn: (r: Request) => Promise<Response>, path: string, t: TT, body: unknown, method = "POST") => fn(api(method, path, t.cookie, body));
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
const future = (plus = 5) => {
  const date = addDays(localDate(Date.now(), "America/Caracas"), plus);
  return { date, wd: ((new Date(date + "T00:00:00Z").getUTCDay() + 6) % 7) + 1 };
};
/** Instante UTC (ISO) de una hora local de Caracas. */
const at = (date: string, hm: string) => new Date(localToUtc(date, Number(hm.slice(0, 2)) * 60 + Number(hm.slice(3)), "America/Caracas")!).toISOString();

async function ready(name: string, o: { duration?: number } = {}) {
  const t = await register(name);
  expect((await post(putSettings, "/api/agenda/settings", t, { timezone: "America/Caracas", minNoticeMinutes: 120, maxDaysAhead: 60, slotStepMinutes: 30 }, "PUT")).status).toBe(200);
  const days = [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({ weekday, ranges: [{ start: "09:00", end: "12:00" }, { start: "14:00", end: "16:00" }] }));
  expect((await post(putHours, "/api/agenda/hours", t, { days }, "PUT")).status).toBe(200);
  const r = await post(createService, "/api/agenda/services", t, { name: "Corte", durationMinutes: o.duration ?? 60 });
  return { t, s: (await r.json()).id as string };
}
const book = (t: TT, serviceId: string, startsAt: string, extra: Record<string, unknown> = {}) =>
  post(createAppt, "/api/agenda/appointments", t, { serviceId, startsAt, customerName: "María Pérez", ...extra });
const list = async (t: TT, date: string, days = 1) => {
  const r = await listAppts(api("GET", `/api/agenda/appointments?date=${date}&days=${days}`, t.cookie));
  return { status: r.status, body: await r.json() };
};
const act = (t: TT, id: string, action: string, extra: Record<string, unknown> = {}) => post(updateAppt, "/api/agenda/appointments/update", t, { id, action, ...extra });
const rowOf = async (t: TT, id: string) => (await ownerExec(t.tenantId, "SELECT * FROM appointments WHERE id = $1", [id])).rows[0];
const slotTimes = async (t: TT, serviceId: string, date: string) => (await (await getSlots(api("GET", `/api/agenda/slots?serviceId=${serviceId}&date=${date}`, t.cookie))).json()).slots.map((s: { time: string }) => s.time);

describe("citas: permisos", () => {
  it("todos los roles pueden agendar y ver; configurar es solo de dueño y administrador", () => {
    for (const r of ["owner", "admin", "agent"] as const) {
      expect(can(r, "agenda:book")).toBe(true);
      expect(can(r, "agenda:read")).toBe(true);
    }
    expect(can("agent", "agenda:manage")).toBe(false);
    expect(can(null, "agenda:book")).toBe(false);
  });
});

describe("citas: crear", () => {
  it("crea una cita confirmada en un hueco libre y la duración sale del servicio", async () => {
    const { t, s } = await ready("c1", { duration: 90 });
    const { date } = future();
    const r = await book(t, s, at(date, "09:00"), { customerPhone: "+58 414 1234567", notes: "Primera vez" });
    expect(r.status).toBe(201);
    const row = await rowOf(t, (await r.json()).id);
    expect(row).toMatchObject({ status: "confirmada", source: "manual", customer_name: "María Pérez", customer_phone: "+58 414 1234567", notes: "Primera vez", conversation_id: null });
    expect(row.ends_at.getTime() - row.starts_at.getTime()).toBe(90 * 60_000);
    expect(row.starts_at.toISOString()).toBe(at(date, "09:00"));
    expect(row.created_by).toBeTruthy();
  });

  it("al agendar, ese horario (y los que se cruzan) dejan de ofrecerse", async () => {
    const { t, s } = await ready("c2");
    const { date } = future();
    expect(await slotTimes(t, s, date)).toContain("10:00");
    await book(t, s, at(date, "10:00"));
    expect(await slotTimes(t, s, date)).toEqual(["09:00", "11:00", "14:00", "14:30", "15:00"]);
  });

  it("agendar el mismo horario dos veces: la segunda recibe 409 y no se crea otra cita", async () => {
    const { t, s } = await ready("c3");
    const { date } = future();
    expect((await book(t, s, at(date, "10:00"))).status).toBe(201);
    const r = await book(t, s, at(date, "10:00"), { customerName: "Otro" });
    expect(r.status).toBe(409);
    expect((await r.json()).error).toBe("horario_no_disponible");
    expect((await book(t, s, at(date, "10:30"))).status).toBe(409); // se cruza
    expect((await list(t, date)).body.appointments).toHaveLength(1);
  });

  it("CARRERA: seis reservas simultáneas del mismo horario → exactamente una gana y ninguna da error 500", async () => {
    const { t, s } = await ready("c4");
    const { date } = future();
    const rs = await Promise.all(Array.from({ length: 6 }, (_, i) => book(t, s, at(date, "11:00"), { customerName: `Cliente ${i}` })));
    const codes = rs.map((r) => r.status).sort();
    expect(codes).toEqual([201, 409, 409, 409, 409, 409]);
    expect((await list(t, date)).body.appointments).toHaveLength(1);
  });

  it("CARRERA: reservas simultáneas que se pisan a medias → una sola cita activa", async () => {
    const { t, s } = await ready("c5");
    const { date } = future();
    const rs = await Promise.all(["09:00", "09:30", "10:00"].map((hm) => book(t, s, at(date, hm))));
    expect(rs.filter((r) => r.status === 201).length).toBeGreaterThanOrEqual(1);
    for (const r of rs) expect([201, 409]).toContain(r.status);
    const active = (await list(t, date)).body.appointments;
    for (let i = 0; i < active.length; i++) for (let j = i + 1; j < active.length; j++) {
      expect(Date.parse(active[i].endsAt) <= Date.parse(active[j].startsAt) || Date.parse(active[j].endsAt) <= Date.parse(active[i].startsAt)).toBe(true);
    }
  });

  it("CARRERA repetida: ni un solo error 500 (un bloqueo mutuo de la base cuenta como horario ocupado)", async () => {
    const { t, s } = await ready("c5b");
    const seen: Record<number, number> = {};
    for (let i = 1; i <= 40; i++) {
      const { date } = future(i);
      const rs = await Promise.all(["09:00", "09:30", "10:00"].map((hm) => book(t, s, at(date, hm))));
      for (const r of rs) seen[r.status] = (seen[r.status] ?? 0) + 1;
      expect(rs.some((r) => r.status === 201)).toBe(true);
    }
    expect(Object.keys(seen).map(Number).filter((c) => c !== 201 && c !== 409)).toEqual([]);
  }, 60_000);

  it("isSlotConflict reconoce solapamiento (23P01) y bloqueo mutuo (40P01), y nada más", () => {
    expect(isSlotConflict({ code: "23P01" })).toBe(true);
    expect(isSlotConflict({ code: "40P01" })).toBe(true);
    for (const x of [{ code: "23505" }, { code: "40001" }, {}, null, undefined, "40P01", new Error("x")]) expect(isSlotConflict(x)).toBe(false);
  });

  it("rechaza lo que NO es un hueco libre: fuera de horario, fuera de paso, pasado, muy lejano, día bloqueado", async () => {
    const { t, s } = await ready("c6");
    const { date } = future();
    const bad = [
      at(date, "08:00"),          // antes de abrir
      at(date, "11:30"),          // el servicio de 60 min no cabe antes de las 12:00
      at(date, "12:00"),          // pausa
      at(date, "09:10"),          // no es múltiplo del paso
      at(addDays(localDate(Date.now(), "America/Caracas"), -2), "10:00"), // pasado
      at(future(90).date, "10:00"), // más allá del máximo (60 días)
    ];
    for (const b of bad) {
      const r = await book(t, s, b);
      expect(r.status).toBe(409);
    }
    await post(createOff, "/api/agenda/time-off", t, { startsAt: at(date, "00:00"), endsAt: at(addDays(date, 1), "00:00") });
    expect((await book(t, s, at(date, "10:00"))).status).toBe(409);
    expect((await list(t, date)).body.appointments).toHaveLength(0);
  });

  it("servicio inactivo o inexistente: 404", async () => {
    const { t, s } = await ready("c7");
    const { date } = future();
    expect((await book(t, randomUUID(), at(date, "10:00"))).status).toBe(404);
    await post(updateService, "/api/agenda/services/update", t, { id: s, active: false });
    expect((await book(t, s, at(date, "10:00"))).status).toBe(404);
  });

  it("validación de datos: nombre, teléfono, notas, fechas y ids", async () => {
    const { t, s } = await ready("c8");
    const { date } = future();
    const ok = at(date, "10:00");
    for (const extra of [{ customerName: "" }, { customerName: "   " }, { customerName: "x".repeat(121) }, { customerPhone: "abc" }, { customerPhone: "1" }, { notes: "x".repeat(1001) }, { conversationId: "no-uuid" }]) {
      expect((await book(t, s, ok, extra)).status).toBe(400);
    }
    expect((await book(t, s, "mañana a las 10")).status).toBe(400);
    expect((await book(t, s, `${date}T10:00:00`)).status).toBe(400); // sin zona
    expect((await post(createAppt, "/api/agenda/appointments", t, { serviceId: "x", startsAt: ok, customerName: "A" })).status).toBe(400);
    expect((await list(t, date)).body.appointments).toHaveLength(0);
  });

  it("sin sesión 401; origen ajeno 403", async () => {
    const { t, s } = await ready("c9");
    const { date } = future();
    expect((await createAppt(api("POST", "/api/agenda/appointments", undefined, { serviceId: s, startsAt: at(date, "10:00"), customerName: "A" }))).status).toBe(401);
    expect((await updateAppt(api("POST", "/api/agenda/appointments/update", undefined, { id: randomUUID(), action: "cancel" }))).status).toBe(401);
    expect((await listAppts(api("GET", `/api/agenda/appointments?date=${date}`))).status).toBe(401);
    const bad = new Request(`${ORIGIN}/api/agenda/appointments`, { method: "POST", headers: { origin: "https://malo.example", "content-type": "application/json", cookie: t.cookie }, body: JSON.stringify({ serviceId: s, startsAt: at(date, "10:00"), customerName: "A" }) });
    expect((await createAppt(bad)).status).toBe(403);
    const id = (await (await book(t, s, at(date, "10:00"))).json()).id;
    const bad2 = new Request(`${ORIGIN}/api/agenda/appointments/update`, { method: "POST", headers: { origin: "https://malo.example", "content-type": "application/json", cookie: t.cookie }, body: JSON.stringify({ id, action: "cancel" }) });
    expect((await updateAppt(bad2)).status).toBe(403);
    expect((await rowOf(t, id)).status).toBe("confirmada");
  });

  it("vinculada a una conversación: guarda conversación y contacto; de otro negocio: 404", async () => {
    const { t, s } = await ready("v1");
    const other = await ready("v2");
    const waId = newWaId();
    await ingestBatch({ phoneNumberId: t.phoneId, statuses: [], messages: [{ waId, name: "Luis", waMessageId: `wamid.${RUN}.${seq++}`, at: new Date(), type: "text", body: "quiero cita" }] });
    const conv = await withTenant(t.tenantId, async (db) => (await db.query("SELECT id, contact_id FROM conversations LIMIT 1")).rows[0]);
    const { date } = future();
    const r = await book(t, s, at(date, "10:00"), { conversationId: conv.id });
    expect(r.status).toBe(201);
    expect(await rowOf(t, (await r.json()).id)).toMatchObject({ conversation_id: conv.id, contact_id: conv.contact_id });
    expect((await book(other.t, other.s, at(date, "10:00"), { conversationId: conv.id })).status).toBe(404);
    expect(await ownerExec(other.t.tenantId, "SELECT 1 FROM appointments")).toMatchObject({ rowCount: 0 });
  });

  it("negocios distintos pueden reservar a la misma hora; no se ven entre sí", async () => {
    const a = await ready("i1");
    const b = await ready("i2");
    const { date } = future();
    expect((await book(a.t, a.s, at(date, "10:00"))).status).toBe(201);
    expect((await book(b.t, b.s, at(date, "10:00"))).status).toBe(201);
    expect((await list(a.t, date)).body.appointments).toHaveLength(1);
    expect((await book(b.t, a.s, at(date, "14:00"))).status).toBe(404); // servicio ajeno
  });
});

describe("citas: listar", () => {
  it("lista por rango de días locales, ordenada, con nombre del servicio; el día depende de la zona del negocio", async () => {
    const { t, s } = await ready("l1");
    const d1 = future(5).date, d2 = future(6).date, d3 = future(7).date;
    await book(t, s, at(d2, "14:00"), { customerName: "B" });
    await book(t, s, at(d1, "10:00"), { customerName: "A" });
    await book(t, s, at(d3, "09:00"), { customerName: "C" });
    const one = (await list(t, d1)).body;
    expect(one.timezone).toBe("America/Caracas");
    expect(one.appointments.map((a: { customerName: string }) => a.customerName)).toEqual(["A"]);
    expect(one.appointments[0]).toMatchObject({ serviceName: "Corte", status: "confirmada", source: "manual" });
    expect((await list(t, d1, 3)).body.appointments.map((a: { customerName: string }) => a.customerName)).toEqual(["A", "B", "C"]);
    expect((await list(t, d2, 2)).body.appointments.map((a: { customerName: string }) => a.customerName)).toEqual(["B", "C"]);
  });

  it("una cita a las 23:30 locales pertenece a ese día aunque en UTC ya sea el siguiente", async () => {
    const { t, s } = await ready("l2");
    const { date } = future(5);
    await ownerExec(t.tenantId, "INSERT INTO appointments (tenant_id, service_id, customer_name, starts_at, ends_at, source, status) VALUES ($1,$2,'Noche',$3,$4,'manual','confirmada')", [t.tenantId, s, at(date, "23:30"), at(addDays(date, 1), "00:30")]);
    expect((await list(t, date)).body.appointments).toHaveLength(1);
    expect((await list(t, addDays(date, 1))).body.appointments).toHaveLength(0);
  });

  it("incluye las canceladas (con su estado) y valida los parámetros", async () => {
    const { t, s } = await ready("l3");
    const { date } = future();
    const id = (await (await book(t, s, at(date, "10:00"))).json()).id;
    await act(t, id, "cancel");
    expect((await list(t, date)).body.appointments[0].status).toBe("cancelada");
    for (const q of ["date=ayer", "date=2030-02-30", `date=${date}&days=0`, `date=${date}&days=40`, ""]) {
      expect((await listAppts(api("GET", `/api/agenda/appointments?${q}`, t.cookie))).status).toBe(400);
    }
  });
});

describe("citas: cambiar estado", () => {
  const seed = (t: TT, s: string, startsAt: string, status: string) =>
    ownerExec(t.tenantId, "INSERT INTO appointments (tenant_id, service_id, customer_name, starts_at, ends_at, source, status) VALUES ($1,$2,'Ana',$3,$3::timestamptz + interval '1 hour','agente',$4) RETURNING id", [t.tenantId, s, startsAt, status]).then((r) => r.rows[0].id as string);

  it("confirmar una pendiente; no se puede confirmar otra cosa", async () => {
    const { t, s } = await ready("u1");
    const { date } = future();
    const p = await seed(t, s, at(date, "10:00"), "pendiente");
    expect((await act(t, p, "confirm")).status).toBe(200);
    expect((await rowOf(t, p)).status).toBe("confirmada");
    expect((await act(t, p, "confirm")).status).toBe(409);
  });

  it("cancelar libera el horario para otro cliente; una cancelada no cambia más", async () => {
    const { t, s } = await ready("u2");
    const { date } = future();
    const id = (await (await book(t, s, at(date, "10:00"))).json()).id;
    expect((await book(t, s, at(date, "10:00"))).status).toBe(409);
    expect((await act(t, id, "cancel")).status).toBe(200);
    expect((await book(t, s, at(date, "10:00"), { customerName: "Nuevo" })).status).toBe(201);
    for (const a of ["cancel", "confirm", "complete", "no_show"]) expect((await act(t, id, a)).status).toBe(409);
    expect((await act(t, id, "reschedule", { startsAt: at(date, "14:00") })).status).toBe(409);
  });

  it("completada y no asistió: solo cuando la cita ya pasó y estaba confirmada", async () => {
    const { t, s } = await ready("u3");
    const { date } = future();
    const fut = (await (await book(t, s, at(date, "10:00"))).json()).id;
    for (const a of ["complete", "no_show"]) {
      const r = await act(t, fut, a);
      expect(r.status).toBe(409);
      expect((await r.json()).error).toBe("aun_no_ocurre");
    }
    const past = new Date(Date.now() - 3 * 3_600_000).toISOString();
    const a = await seed(t, s, past, "confirmada");
    const b = await seed(t, s, new Date(Date.now() - 6 * 3_600_000).toISOString(), "confirmada");
    const p = await seed(t, s, new Date(Date.now() - 9 * 3_600_000).toISOString(), "pendiente");
    expect((await act(t, a, "complete")).status).toBe(200);
    expect((await act(t, b, "no_show")).status).toBe(200);
    expect((await act(t, p, "complete")).status).toBe(409); // pendiente: primero confirmar
    expect((await rowOf(t, a)).status).toBe("completada");
    expect((await rowOf(t, b)).status).toBe("no_asistio");
    for (const x of [a, b]) for (const act1 of ["cancel", "complete", "no_show", "confirm"]) expect((await act(t, x, act1)).status).toBe(409);
  });

  it("id inexistente o de otro negocio: 404 y no se modifica nada", async () => {
    const a = await ready("u4");
    const b = await ready("u5");
    const { date } = future();
    const id = (await (await book(a.t, a.s, at(date, "10:00"))).json()).id;
    expect((await act(b.t, id, "cancel")).status).toBe(404);
    expect((await act(a.t, randomUUID(), "cancel")).status).toBe(404);
    expect((await rowOf(a.t, id)).status).toBe("confirmada");
  });

  it("acciones y datos inválidos: 400", async () => {
    const { t } = await ready("u6");
    expect((await act(t, randomUUID(), "borrar")).status).toBe(400);
    expect((await act(t, "no-uuid", "cancel")).status).toBe(400);
    expect((await act(t, randomUUID(), "reschedule")).status).toBe(400);
    expect((await act(t, randomUUID(), "reschedule", { startsAt: "luego" })).status).toBe(400);
  });
});

describe("citas: reprogramar", () => {
  it("mueve la cita a otro hueco libre, conserva la duración y libera el anterior", async () => {
    const { t, s } = await ready("r1", { duration: 90 });
    const { date } = future();
    const id = (await (await book(t, s, at(date, "09:00"))).json()).id;
    expect((await act(t, id, "reschedule", { startsAt: at(date, "14:00") })).status).toBe(200);
    const row = await rowOf(t, id);
    expect(row.starts_at.toISOString()).toBe(at(date, "14:00"));
    expect(row.ends_at.getTime() - row.starts_at.getTime()).toBe(90 * 60_000);
    expect(row.status).toBe("confirmada");
    expect(await slotTimes(t, s, date)).toContain("09:00");
  });

  it("puede correrse un poco aunque se cruce con su propio horario anterior", async () => {
    const { t, s } = await ready("r2");
    const { date } = future();
    const id = (await (await book(t, s, at(date, "10:00"))).json()).id;
    expect((await act(t, id, "reschedule", { startsAt: at(date, "10:30") })).status).toBe(200);
    expect((await rowOf(t, id)).starts_at.toISOString()).toBe(at(date, "10:30"));
  });

  it("no se puede mover a un horario ocupado ni inválido, y la cita queda donde estaba", async () => {
    const { t, s } = await ready("r3");
    const { date } = future();
    const a = (await (await book(t, s, at(date, "09:00"))).json()).id;
    await book(t, s, at(date, "10:00"), { customerName: "Otro" });
    for (const hm of ["10:00", "09:30", "12:00", "08:00"]) {
      const r = await act(t, a, "reschedule", { startsAt: at(date, hm) });
      expect(r.status).toBe(409);
      expect((await r.json()).error).toBe("horario_no_disponible");
    }
    expect((await rowOf(t, a)).starts_at.toISOString()).toBe(at(date, "09:00"));
  });

  it("una cita pendiente también se reprograma y sigue pendiente; la cancelada no", async () => {
    const { t, s } = await ready("r4");
    const { date } = future();
    const p = (await ownerExec(t.tenantId, "INSERT INTO appointments (tenant_id, service_id, customer_name, starts_at, ends_at, source, status) VALUES ($1,$2,'Ana',$3,$4,'agente','pendiente') RETURNING id", [t.tenantId, s, at(date, "10:00"), at(date, "11:00")])).rows[0].id;
    expect((await act(t, p, "reschedule", { startsAt: at(date, "14:00") })).status).toBe(200);
    expect((await rowOf(t, p)).status).toBe("pendiente");
  });

  it("reprogramar respeta la duración original aunque el servicio haya cambiado después", async () => {
    const { t, s } = await ready("r5", { duration: 60 });
    const { date } = future();
    const id = (await (await book(t, s, at(date, "09:00"))).json()).id;
    await post(updateService, "/api/agenda/services/update", t, { id: s, durationMinutes: 120 });
    expect((await act(t, id, "reschedule", { startsAt: at(date, "11:00") })).status).toBe(200); // 60 min caben antes de las 12:00; 120 no
    const row = await rowOf(t, id);
    expect(row.ends_at.getTime() - row.starts_at.getTime()).toBe(60 * 60_000);
  });

  it("reservas y reprogramaciones a la vez sobre el mismo hueco: nunca quedan dos citas cruzadas", async () => {
    const { t, s } = await ready("r6");
    const { date } = future();
    const a = (await (await book(t, s, at(date, "09:00"))).json()).id;
    const b = (await (await book(t, s, at(date, "14:00"))).json()).id;
    const rs = await Promise.all([act(t, a, "reschedule", { startsAt: at(date, "11:00") }), act(t, b, "reschedule", { startsAt: at(date, "11:00") }), book(t, s, at(date, "11:00"), { customerName: "Nuevo" })]);
    expect(rs.filter((r) => r.status === 200 || r.status === 201)).toHaveLength(1);
    for (const r of rs) expect([200, 201, 409]).toContain(r.status);
  });
});
