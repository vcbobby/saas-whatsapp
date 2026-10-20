import { describe, expect, it, vi } from "vitest";

// El límite de intentos protege la contraseña actual: si se alcanza, la ruta responde 429 sin tocar nada más.
vi.mock("@/lib/security/rate-limit", async (orig) => ({
  ...(await orig<typeof import("@/lib/security/rate-limit")>()),
  hitLimit: vi.fn(async () => ({ allowed: false, retryAfterSec: 42, source: "redis" as const })),
}));

import { POST as changePassword } from "@/app/api/account/password/route";
import { POLICIES, hitLimit } from "@/lib/security/rate-limit";

describe("límite de la ruta de cambio de contraseña", () => {
  it("usa su propio cupo (10 por 10 minutos) y responde 429 con Retry-After", async () => {
    expect(POLICIES.password).toEqual({ limit: 10, windowSec: 600 });
    const origin = new URL(process.env.APP_URL!).origin;
    const res = await changePassword(new Request(`${origin}/api/account/password`, { method: "POST", headers: { origin, "content-type": "application/json" }, body: JSON.stringify({ currentPassword: "x", newPassword: "y" }) }));
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("42");
    expect(hitLimit).toHaveBeenCalledWith("password", expect.any(String));
  });
});
