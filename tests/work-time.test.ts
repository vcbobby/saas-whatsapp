import { describe, expect, it } from "vitest";
import { dueInfo, messageTime, relativeTime } from "@/lib/work/time";

// 11 de octubre de 2026, 12:00 (hora local de quien corre la prueba).
const NOW = new Date(2026, 9, 11, 12, 0, 0).getTime();
const ago = (ms: number) => new Date(NOW - ms).toISOString();
const MIN = 60_000, HOUR = 60 * MIN, DAY = 24 * HOUR;

describe("relativeTime", () => {
  it("escala: ahora, minutos, horas, días y fecha", () => {
    expect(relativeTime(ago(10_000), NOW)).toBe("ahora");
    expect(relativeTime(ago(MIN), NOW)).toBe("hace 1 min");
    expect(relativeTime(ago(59 * MIN), NOW)).toBe("hace 59 min");
    expect(relativeTime(ago(HOUR), NOW)).toBe("hace 1 h");
    expect(relativeTime(ago(23 * HOUR), NOW)).toBe("hace 23 h");
    expect(relativeTime(ago(DAY), NOW)).toBe("hace 1 día");
    expect(relativeTime(ago(3 * DAY), NOW)).toBe("hace 3 días");
    expect(relativeTime(ago(30 * DAY), NOW)).toMatch(/\d/); // una fecha, p. ej. "11 sept"
    expect(relativeTime(ago(30 * DAY), NOW)).not.toContain("hace");
  });
  it("tolera vacío, basura y fechas del futuro", () => {
    expect(relativeTime(null, NOW)).toBe("");
    expect(relativeTime(undefined, NOW)).toBe("");
    expect(relativeTime("no es fecha", NOW)).toBe("");
    expect(relativeTime(new Date(NOW + 10 * MIN), NOW)).toBe("en el futuro");
    expect(relativeTime(new Date(NOW + 10_000), NOW)).toBe("ahora"); // reloj desfasado unos segundos
  });
});

describe("dueInfo", () => {
  it("atrasada: lo dice y la marca", () => {
    expect(dueInfo(ago(2 * HOUR), NOW)).toEqual({ text: "Venció hace 2 h", overdue: true });
  });
  it("hoy o más adelante: no está atrasada", () => {
    const today = dueInfo(new Date(2026, 9, 11, 15, 0).toISOString(), NOW)!;
    expect(today.overdue).toBe(false);
    expect(today.text.startsWith("Vence hoy, ")).toBe(true);
    const later = dueInfo(new Date(2026, 9, 14, 10, 0).toISOString(), NOW)!;
    expect(later.overdue).toBe(false);
    expect(later.text.startsWith("Vence el ")).toBe(true);
  });
  it("sin fecha o inválida -> nada", () => {
    expect(dueInfo(null, NOW)).toBeNull();
    expect(dueInfo("x", NOW)).toBeNull();
  });
});

describe("messageTime", () => {
  it("hoy solo la hora; otro día, fecha y hora", () => {
    const today = messageTime(new Date(2026, 9, 11, 9, 5).toISOString(), NOW);
    const other = messageTime(new Date(2026, 9, 5, 9, 5).toISOString(), NOW);
    expect(today).not.toContain(",");
    expect(other).toContain(",");
    expect(messageTime("x", NOW)).toBe("");
  });
});
