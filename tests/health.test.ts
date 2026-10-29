import { afterAll, describe, expect, it, vi } from "vitest";
import { GET as health } from "@/app/api/health/route";
import { getPool } from "@/lib/db";

afterAll(async () => { vi.restoreAllMocks(); vi.unstubAllEnvs(); await getPool().end(); });

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

describe("GET /api/health con detalle", () => {
  const TOKEN = "token-de-salud-largo-123";
  const req = (h: Record<string, string> = {}) => new Request("http://localhost/api/health", { headers: h });

  it("sin HEALTH_TOKEN configurado ignora la cabecera y no da detalle", async () => {
    vi.stubEnv("HEALTH_TOKEN", "");
    const body = await (await health(req({ "x-health-token": TOKEN }))).json();
    expect(body).toEqual({ status: "ok" });
  });

  it("con token incorrecto no da detalle", async () => {
    vi.stubEnv("HEALTH_TOKEN", TOKEN);
    const body = await (await health(req({ "x-health-token": "otro-token-incorrecto" }))).json();
    expect(body).toEqual({ status: "ok" });
  });

  it("con token correcto y sin latido del worker responde 503 con el desglose", async () => {
    vi.stubEnv("HEALTH_TOKEN", TOKEN);
    const { createProducerConnection } = await import("@/lib/queue/connection");
    const { heartbeatKey } = await import("@/lib/queue/heartbeat");
    const c = createProducerConnection();
    await c.del(heartbeatKey());
    c.disconnect();
    const res = await health(req({ "x-health-token": TOKEN }));
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ status: "degraded", db: "ok", redis: "ok", worker: "caido", workerLatidoHaceSeg: null });
  });

  it("con latido reciente responde 200 y worker ok; con latido viejo, caído", async () => {
    vi.stubEnv("HEALTH_TOKEN", TOKEN);
    const { createProducerConnection } = await import("@/lib/queue/connection");
    const { writeHeartbeat, heartbeatKey } = await import("@/lib/queue/heartbeat");
    const c = createProducerConnection();
    await writeHeartbeat(c);
    let res = await health(req({ "x-health-token": TOKEN }));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: "ok", worker: "ok" });
    await writeHeartbeat(c, Date.now() - 120_000);
    res = await health(req({ "x-health-token": TOKEN }));
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ worker: "caido" });
    await c.del(heartbeatKey());
    c.disconnect();
  });

  it("la versión pública sigue dando 200 aunque el worker esté caído", async () => {
    vi.stubEnv("HEALTH_TOKEN", TOKEN);
    const res = await health(req());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok" });
  });
});
