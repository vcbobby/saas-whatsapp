import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";
import { Pool } from "pg";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { POST as login } from "@/app/api/auth/login/route";
import { POST as signup } from "@/app/api/auth/signup/route";
import { POST as verify2fa } from "@/app/api/auth/2fa/verify/route";
import { GET as me } from "@/app/api/me/route";
import { hashPassword } from "@/lib/auth/password";
import { getPool } from "@/lib/db";
import { proxy } from "@/proxy";
import { codeFor, enableMfaDirect } from "./mfa-helpers";

const ORIGIN = new URL(process.env.APP_URL!).origin;
const RUN = randomUUID().slice(0, 8);
const email = (n: string) => `proxy-${RUN}-${n}@example.test`;
const PASSWORD = "contraseña-de-prueba-123";
const owner = new Pool({ connectionString: process.env.MIGRATION_DATABASE_URL, max: 2 });
const tenantIds: string[] = [];

const post = (path: string, body: unknown, cookie?: string) =>
  new Request(`${ORIGIN}${path}`, {
    method: "POST",
    headers: { origin: ORIGIN, "content-type": "application/json", ...(cookie ? { cookie } : {}) },
    body: JSON.stringify(body),
  });
const cookieOf = (res: Response) => (res.headers.get("set-cookie") ?? "").split(";")[0]!;
const page = (path: string, cookie?: string) => new NextRequest(`${ORIGIN}${path}`, { headers: cookie ? { cookie } : {} });

const rewritten = (r: Response) => (r.headers.get("x-middleware-rewrite") ?? "").endsWith("/no-existe");
const passed = (r: Response) => r.headers.get("x-middleware-next") === "1" && !r.headers.get("x-middleware-rewrite");

afterEach(() => vi.restoreAllMocks());

afterAll(async () => {
  await owner.query("DELETE FROM users WHERE email LIKE $1", [`proxy-${RUN}-%`]);
  for (const id of tenantIds) {
    const c = await owner.connect();
    try {
      await c.query("BEGIN");
      await c.query("SELECT set_config('app.tenant_id', $1, true)", [id]);
      await c.query("ALTER TABLE audit_log DISABLE TRIGGER audit_log_sin_cambios");
      await c.query("DELETE FROM audit_log WHERE tenant_id = $1", [id]);
      await c.query("ALTER TABLE audit_log ENABLE TRIGGER audit_log_sin_cambios");
      await c.query("DELETE FROM tenants WHERE id = $1", [id]);
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

async function normalUser() {
  const res = await signup(post("/api/auth/signup", { email: email("normal"), password: PASSWORD, businessName: "Negocio proxy" }));
  expect(res.status).toBe(201);
  const cookie = cookieOf(res);
  tenantIds.push((await (await me(new Request(`${ORIGIN}/api/me`, { headers: { cookie } }))).json()).tenant.id);
  return cookie;
}

async function superAdmin(name: string, withMfa: boolean) {
  const addr = email(name);
  const ins = await owner.query<{ id: string }>("INSERT INTO users (email, password_hash, is_super_admin) VALUES ($1, $2, true) RETURNING id", [addr, await hashPassword(PASSWORD)]);
  const secret = withMfa ? await enableMfaDirect(owner, ins.rows[0]!.id) : null;
  const res = await login(post("/api/auth/login", { email: addr, password: PASSWORD }));
  expect(res.status).toBe(200);
  if (!secret) return cookieOf(res);
  const ver = await verify2fa(post("/api/auth/2fa/verify", { code: codeFor(secret) }, cookieOf(res)));
  expect(ver.status).toBe(200);
  return cookieOf(ver);
}

describe("proxy: /admin responde 404 real a quien no es súper admin", () => {
  it("sin sesión, con cookie inventada y con un usuario normal -> se reescribe a una dirección inexistente", async () => {
    const normal = await normalUser();
    for (const cookie of [undefined, "sid=cookie-inventada", normal]) {
      for (const path of ["/admin", "/admin/", "/admin/lo-que-sea"]) {
        expect(rewritten(await proxy(page(path, cookie)))).toBe(true);
      }
    }
  });

  it("un súper admin CON 2FA entra", async () => {
    const cookie = await superAdmin("sa-mfa", true);
    expect(passed(await proxy(page("/admin", cookie)))).toBe(true);
  });

  it("un súper admin SIN 2FA todavía pasa (la página lo manda a /seguridad a activarlo)", async () => {
    const cookie = await superAdmin("sa-sin", false);
    expect(passed(await proxy(page("/admin", cookie)))).toBe(true);
  });

  it("si la base falla al comprobar, se responde 404 (cierra por defecto)", async () => {
    // Sesión de súper admin REAL (sin la falla entraría); después se "cae" la base.
    const cookie = await superAdmin("sa-db", true);
    expect(passed(await proxy(page("/admin", cookie)))).toBe(true);
    vi.spyOn(console, "error").mockImplementation(() => {});
    const q = vi.spyOn(getPool(), "query").mockRejectedValue(new Error("base caída (simulado)"));
    expect(rewritten(await proxy(page("/admin", cookie)))).toBe(true);
    expect(q).toHaveBeenCalled(); // de verdad se intentó consultar la base
  });

  it("solo afecta a /admin: otras direcciones (incluida /administrador) pasan y no tocan la base", async () => {
    const spy = vi.spyOn(getPool(), "query");
    for (const path of ["/", "/entrar", "/panel", "/administrador", "/api/me", "/adminx/y"]) {
      expect(passed(await proxy(page(path)))).toBe(true);
    }
    expect(spy).not.toHaveBeenCalled();
  });

  it("todas las respuestas llevan las cabeceras de seguridad, también la del 404", async () => {
    for (const r of [await proxy(page("/entrar")), await proxy(page("/admin"))]) {
      expect(r.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
      expect(r.headers.get("x-frame-options")).toBe("DENY");
      expect(r.headers.get("referrer-policy")).toBe("no-referrer");
    }
  });
});
