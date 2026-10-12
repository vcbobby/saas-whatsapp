import { describe, expect, it } from "vitest";
import { computeSlots, isSlotAvailable, type SlotInput } from "@/lib/agenda/slots";
import { addDays, formatHm, isValidTimeZone, isValidYmd, isoWeekday, localDate, localParts, localToUtc, parseHm } from "@/lib/agenda/tz";

const iso = (ms: number | null) => (ms === null ? null : new Date(ms).toISOString());

describe("zonas horarias", () => {
  it("valida nombres IANA y rechaza basura", () => {
    expect(isValidTimeZone("America/Caracas")).toBe(true);
    expect(isValidTimeZone("America/Argentina/Buenos_Aires")).toBe(true);
    for (const bad of ["", "UTC", "EST", "Mars/Olympus", "America/Caracas; DROP", "../etc/passwd", "America"]) expect(isValidTimeZone(bad)).toBe(false);
  });

  it("Caracas es UTC-4 todo el año: 08:00 local = 12:00Z", () => {
    expect(iso(localToUtc("2026-03-10", 8 * 60, "America/Caracas"))).toBe("2026-03-10T12:00:00.000Z");
    expect(iso(localToUtc("2026-07-10", 8 * 60, "America/Caracas"))).toBe("2026-07-10T12:00:00.000Z");
  });

  it("con horario de verano: Nueva York cambia de -5 a -4", () => {
    expect(iso(localToUtc("2026-01-15", 9 * 60, "America/New_York"))).toBe("2026-01-15T14:00:00.000Z");
    expect(iso(localToUtc("2026-07-15", 9 * 60, "America/New_York"))).toBe("2026-07-15T13:00:00.000Z");
  });

  it("la hora que no existe (salto de verano) devuelve null; la repetida devuelve la primera", () => {
    expect(localToUtc("2026-03-08", 2 * 60 + 30, "America/New_York")).toBeNull(); // 02:30 no existe ese día
    expect(iso(localToUtc("2026-03-08", 3 * 60, "America/New_York"))).toBe("2026-03-08T07:00:00.000Z");
    expect(iso(localToUtc("2026-11-01", 60 + 30, "America/New_York"))).toBe("2026-11-01T05:30:00.000Z"); // primera 01:30 (EDT)
  });

  it("ida y vuelta en varias zonas", () => {
    for (const tz of ["America/Caracas", "America/Santiago", "Europe/Madrid", "Asia/Kolkata", "Pacific/Auckland"]) {
      for (const ymd of ["2026-01-05", "2026-06-20", "2026-12-31"]) {
        const ms = localToUtc(ymd, 10 * 60 + 15, tz)!;
        const p = localParts(ms, tz);
        expect([p.hour, p.minute]).toEqual([10, 15]);
        expect(localDate(ms, tz)).toBe(ymd);
      }
    }
  });

  it("la fecha local puede ser distinta de la UTC", () => {
    const ms = Date.parse("2026-05-02T02:00:00Z"); // 22:00 del 1 de mayo en Caracas
    expect(localDate(ms, "America/Caracas")).toBe("2026-05-01");
  });

  it("fechas: validar, sumar días, día de la semana", () => {
    expect(isValidYmd("2026-02-28")).toBe(true);
    expect(isValidYmd("2026-02-30")).toBe(false);
    expect(isValidYmd("26-02-01")).toBe(false);
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
    expect(isoWeekday("2026-10-12")).toBe(1); // lunes
    expect(isoWeekday("2026-10-18")).toBe(7); // domingo
  });

  it("horas HH:MM", () => {
    expect(parseHm("08:30")).toBe(510);
    expect(parseHm("24:00")).toBeNull();
    expect(parseHm("24:00", true)).toBe(1440);
    for (const bad of ["8:30", "25:00", "12:60", "ab:cd", ""]) expect(parseHm(bad)).toBeNull();
    expect(formatHm(510)).toBe("08:30");
  });
});

const NOW = Date.parse("2026-10-12T12:00:00Z"); // lunes 08:00 en Caracas
const base: SlotInput = {
  tz: "America/Caracas", nowMs: NOW, fromDate: "2026-10-12", days: 1, durationMin: 60, stepMin: 60,
  hours: [{ weekday: 1, startMin: 9 * 60, endMin: 12 * 60 }, { weekday: 1, startMin: 14 * 60, endMin: 17 * 60 }],
  timeOff: [], busy: [], minNoticeMin: 0, maxDaysAhead: 30,
};
const times = (i: Partial<SlotInput>) => computeSlots({ ...base, ...i }).map((s) => s.time);

describe("huecos libres", () => {
  it("genera los huecos de cada tramo y respeta la duración", () => {
    expect(times({})).toEqual(["09:00", "10:00", "11:00", "14:00", "15:00", "16:00"]);
    expect(times({ durationMin: 90, stepMin: 30 })).toEqual(["09:00", "09:30", "10:00", "10:30", "14:00", "14:30", "15:00", "15:30"]);
  });

  it("un día sin horario no tiene huecos", () => {
    expect(times({ fromDate: "2026-10-13" })).toEqual([]);
    expect(times({ hours: [] })).toEqual([]);
  });

  it("devuelve horas locales y los instantes UTC correctos", () => {
    const s = computeSlots(base)[0]!;
    expect(s).toEqual({ startsAt: "2026-10-12T13:00:00.000Z", endsAt: "2026-10-12T14:00:00.000Z", date: "2026-10-12", time: "09:00" });
  });

  it("preaviso mínimo: no ofrece lo que ya queda muy cerca", () => {
    expect(times({ minNoticeMin: 150 })).toEqual(["11:00", "14:00", "15:00", "16:00"]); // ahora 08:00 → desde 10:30
    expect(times({ minNoticeMin: 120 })).toEqual(["10:00", "11:00", "14:00", "15:00", "16:00"]); // 10:00 exacto sí
  });

  it("no ofrece horas pasadas", () => {
    expect(times({ nowMs: Date.parse("2026-10-12T19:00:00Z") })).toEqual(["15:00", "16:00"]); // ahora 15:00 local: el hueco de las 15:00 aún vale
    expect(times({ nowMs: Date.parse("2026-10-12T19:00:01Z") })).toEqual(["16:00"]);
  });

  it("máximo de días hacia adelante", () => {
    const s = computeSlots({ ...base, fromDate: "2026-10-12", days: 31, hours: [1, 2, 3, 4, 5, 6, 7].map((w) => ({ weekday: w, startMin: 9 * 60, endMin: 10 * 60 })), maxDaysAhead: 3 });
    expect([...new Set(s.map((x) => x.date))]).toEqual(["2026-10-12", "2026-10-13", "2026-10-14"]);
    expect(s.every((x) => Date.parse(x.startsAt) < NOW + 3 * 86_400_000)).toBe(true);
    expect(s.some((x) => x.date === "2026-10-16")).toBe(false);
  });

  it("bloqueos: quita los huecos que se cruzan (aunque el bloqueo cubra solo un pedazo)", () => {
    const off = [{ startMs: Date.parse("2026-10-12T14:30:00Z"), endMs: Date.parse("2026-10-12T15:30:00Z") }]; // 10:30–11:30 local
    expect(times({ timeOff: off })).toEqual(["09:00", "14:00", "15:00", "16:00"]);
  });

  it("citas ocupadas: quita los huecos que se cruzan; una cita que termina justo cuando empieza otro no estorba", () => {
    const busy = [{ startMs: Date.parse("2026-10-12T14:00:00Z"), endMs: Date.parse("2026-10-12T15:00:00Z") }]; // 10:00–11:00 local
    expect(times({ busy })).toEqual(["09:00", "11:00", "14:00", "15:00", "16:00"]);
  });

  it("un servicio largo no cabe si el tramo termina antes", () => {
    expect(times({ durationMin: 180, stepMin: 60 })).toEqual(["09:00", "14:00"]);
    expect(times({ durationMin: 240, stepMin: 60 })).toEqual([]);
  });

  it("varios días, en orden, con el día de la semana correcto", () => {
    const s = computeSlots({ ...base, days: 8, hours: [{ weekday: 1, startMin: 540, endMin: 600 }, { weekday: 3, startMin: 540, endMin: 600 }] });
    expect(s.map((x) => x.date)).toEqual(["2026-10-12", "2026-10-14", "2026-10-19"]);
  });

  it("DST: el día del cambio de hora no ofrece una hora inexistente", () => {
    const s = computeSlots({ ...base, tz: "America/New_York", nowMs: Date.parse("2026-03-01T00:00:00Z"), fromDate: "2026-03-08", durationMin: 30, stepMin: 30, hours: [{ weekday: 7, startMin: 60, endMin: 240 }] });
    expect(s.map((x) => x.time)).toEqual(["01:00", "01:30", "03:00", "03:30"]); // 02:00 y 02:30 no existen
  });

  it("límite de días calculados (31) y valores raros", () => {
    expect(computeSlots({ ...base, days: 1000, hours: [1, 2, 3, 4, 5, 6, 7].map((w) => ({ weekday: w, startMin: 540, endMin: 600 })), maxDaysAhead: 365 })).toHaveLength(31);
    expect(computeSlots({ ...base, days: 0 })).toEqual([]);
    expect(computeSlots({ ...base, days: -3 })).toEqual([]);
  });

  it("isSlotAvailable: solo acepta inicios que son hueco exacto", () => {
    const { fromDate, days, ...rest } = base;
    void fromDate; void days;
    expect(isSlotAvailable(rest, "2026-10-12T13:00:00.000Z")).toBe(true); // 09:00
    expect(isSlotAvailable(rest, "2026-10-12T13:30:00.000Z")).toBe(false); // 09:30 no es múltiplo
    expect(isSlotAvailable(rest, "2026-10-12T16:00:00.000Z")).toBe(false); // 12:00 fuera del tramo
    expect(isSlotAvailable(rest, "no-es-fecha")).toBe(false);
    expect(isSlotAvailable({ ...rest, busy: [{ startMs: Date.parse("2026-10-12T13:00:00Z"), endMs: Date.parse("2026-10-12T14:00:00Z") }] }, "2026-10-12T13:00:00.000Z")).toBe(false);
  });
});
