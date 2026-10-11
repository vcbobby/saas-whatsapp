import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Redis "caído": todas sus operaciones fallan. El límite debe seguir protegiendo (en memoria) en vez de abrir la puerta.
vi.mock("@/lib/queue/connection", () => {
  const fail = () => Promise.reject(new Error("Redis caído (simulado)"));
  return {
    queuePrefix: () => "test",
    createProducerConnection: () => ({ eval: fail, get: fail, pttl: fail, disconnect: () => {} }),
  };
});

import { POLICIES, hitLimit, peekLimit, resetMemoryLimits } from "@/lib/security/rate-limit";

beforeEach(() => {
  process.env.RATE_LIMIT_DISABLED = "0";
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  resetMemoryLimits();
  process.env.RATE_LIMIT_DISABLED = "1";
});

describe("límite de peticiones cuando Redis falla", () => {
  it("cuenta y corta en memoria", async () => {
    const limit = POLICIES.badSignature.limit;
    for (let i = 0; i < limit; i++) {
      const r = await hitLimit("badSignature", "203.0.113.1");
      expect(r.allowed).toBe(true);
      expect(r.source).toBe("memory");
    }
    const over = await hitLimit("badSignature", "203.0.113.1");
    expect(over.allowed).toBe(false);
    expect(over.retryAfterSec).toBeGreaterThan(0);
    expect((await hitLimit("badSignature", "203.0.113.2")).allowed).toBe(true);
  });

  it("peek también funciona sin Redis y no cuenta", async () => {
    for (let i = 0; i < 30; i++) expect((await peekLimit("badSignature", "203.0.113.3")).allowed).toBe(true);
    for (let i = 0; i < POLICIES.badSignature.limit; i++) await hitLimit("badSignature", "203.0.113.3");
    expect((await peekLimit("badSignature", "203.0.113.3")).allowed).toBe(false);
  });

  it("avisa del fallo una sola vez por minuto (no llena los registros)", async () => {
    const spy = vi.spyOn(console, "error");
    spy.mockClear();
    for (let i = 0; i < 20; i++) await hitLimit("login", `198.51.100.${i}`);
    expect(spy.mock.calls.filter((c) => String(c[0]).includes("[límite]")).length).toBeLessThanOrEqual(1);
  });
});
