import { afterAll, describe, expect, it, vi } from "vitest";
import { GET as health } from "@/app/api/health/route";
import { getPool } from "@/lib/db";

afterAll(async () => { vi.restoreAllMocks(); await getPool().end(); });

describe("GET /api/health", () => {
  it("responde ok y no revela nada más, sin necesidad de sesión", async () => {
    const res = await health(new Request("http://localhost/api/health"));
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toContain("no-store");
    expect(await res.json()).toEqual({ status: "ok" });
  });

  it("si la base de datos falla responde 503 «degraded» sin mostrar el error", async () => {
    vi.spyOn(getPool(), "query").mockRejectedValueOnce(new Error("password authentication failed for user app_user at 10.0.0.5"));
    const res = await health(new Request("http://localhost/api/health"));
    expect(res.status).toBe(503);
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({ status: "degraded" });
    expect(text).not.toMatch(/password|10\.0\.0\.5|app_user/);
  });
});
