import { describe, expect, it } from "vitest";
import { subscriptionNotice, WARN_DAYS } from "@/lib/billing/notice";
import type { Subscription } from "@/lib/billing/data";

const sub = (o: Partial<Subscription>): Subscription => ({ status: "active", planName: "Plan 2", expiresAt: "2026-12-01T00:00:00Z", daysLeft: 30, ...o });

describe("aviso de suscripción", () => {
  it("sin datos, en prueba, sin fecha o con tiempo de sobra: no avisa", () => {
    expect(subscriptionNotice(null, true)).toBeNull();
    expect(subscriptionNotice(sub({ status: "trial", expiresAt: null, daysLeft: null }), true)).toBeNull();
    expect(subscriptionNotice(sub({ expiresAt: null, daysLeft: null }), true)).toBeNull();
    expect(subscriptionNotice(sub({ daysLeft: 6 }), true)).toBeNull();
    expect(subscriptionNotice(sub({ status: "suspended", daysLeft: 1 }), true)).toBeNull();
  });
  it("avisa desde 5 días antes, en singular y plural", () => {
    expect(WARN_DAYS).toBe(5);
    expect(subscriptionNotice(sub({ daysLeft: WARN_DAYS }), true)).toMatchObject({ level: "warn" });
    expect(subscriptionNotice(sub({ daysLeft: 5 }), true)!.text).toContain("vence en 5 días");
    expect(subscriptionNotice(sub({ daysLeft: 1 }), true)!.text).toContain("vence en 1 día.");
    expect(subscriptionNotice(sub({ daysLeft: 0 }), true)!.text).toContain("vence hoy");
  });
  it("pago pendiente es un error y explica que el asistente no responde", () => {
    const n = subscriptionNotice(sub({ status: "past_due", daysLeft: -2 }), true)!;
    expect(n.level).toBe("error");
    expect(n.text).toContain("no responde");
    expect(n.text).toContain("Plan y pagos");
  });
  it("quien no es dueño recibe la indicación de avisarle, sin pedirle que pague", () => {
    for (const s of [sub({ status: "past_due", daysLeft: -1 }), sub({ daysLeft: 2 }), sub({ daysLeft: 0 })]) {
      const t = subscriptionNotice(s, false)!.text;
      expect(t).toContain("dueño");
      expect(t).not.toContain("Plan y pagos");
    }
  });
});
