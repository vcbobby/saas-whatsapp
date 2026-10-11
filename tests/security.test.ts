import { createHmac } from "node:crypto";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { POST as hookPost } from "@/app/api/webhooks/whatsapp/route";
import { errorResponse, jsonResponse, route } from "@/lib/auth/http";
import { getSecurityEnv } from "@/lib/env";
import { UNKNOWN_IP, clientIp, normalizeIp } from "@/lib/security/client-ip";
import { buildCsp, securityHeaders } from "@/lib/security/headers";
import { POLICIES, closeRateLimit, hitLimit, peekLimit, resetMemoryLimits } from "@/lib/security/rate-limit";

const ORIGIN = new URL(process.env.APP_URL!).origin;
// Una IP distinta por prueba: así las pruebas no se pisan entre sí ni con ejecuciones anteriores.
let n = 0;
const freshIp = () => `10.${Math.floor(Math.random() * 200)}.${Math.floor(Math.random() * 250)}.${(n++ % 250) + 1}`;

const saved = { ...process.env };
beforeEach(() => {
  process.env.RATE_LIMIT_DISABLED = "0"; // aquí SÍ se prueban los límites
  process.env.TRUSTED_PROXY = "cloudflare";
});
afterEach(() => {
  process.env.RATE_LIMIT_DISABLED = saved.RATE_LIMIT_DISABLED;
  if (saved.TRUSTED_PROXY === undefined) delete process.env.TRUSTED_PROXY;
  else process.env.TRUSTED_PROXY = saved.TRUSTED_PROXY;
  resetMemoryLimits();
});
afterAll(async () => {
  await closeRateLimit();
});

const req = (headers: Record<string, string> = {}) => new Request(`${ORIGIN}/x`, { headers });

describe("IP del visitante", () => {
  it("sin proxy de confianza NO se lee ninguna cabecera (no se puede falsificar)", () => {
    const r = req({ "cf-connecting-ip": "1.2.3.4", "x-forwarded-for": "5.6.7.8" });
    expect(clientIp(r, "none")).toBe(UNKNOWN_IP);
  });

  it("cloudflare: usa CF-Connecting-IP y ignora X-Forwarded-For", () => {
    expect(clientIp(req({ "cf-connecting-ip": "1.2.3.4", "x-forwarded-for": "9.9.9.9" }), "cloudflare")).toBe("1.2.3.4");
    expect(clientIp(req({ "x-forwarded-for": "9.9.9.9" }), "cloudflare")).toBe(UNKNOWN_IP);
  });

  it("proxy: usa la ÚLTIMA entrada de X-Forwarded-For (las anteriores las escribe el visitante)", () => {
    expect(clientIp(req({ "x-forwarded-for": "6.6.6.6, 7.7.7.7, 203.0.113.9" }), "proxy")).toBe("203.0.113.9");
    expect(clientIp(req({ "cf-connecting-ip": "1.1.1.1" }), "proxy")).toBe(UNKNOWN_IP);
  });

  it("valores que no son IP -> desconocida (no se usan como clave)", () => {
    for (const bad of ["", "no-es-ip", "1.2.3", "999.1.1.1", "1.2.3.4, 5.6.7.8", "<script>", "a".repeat(500)]) {
      expect(clientIp(req({ "cf-connecting-ip": bad }), "cloudflare")).toBe(UNKNOWN_IP);
    }
  });

  it("IPv6: todas las direcciones de un mismo /64 comparten clave; otro /64 es otra clave", () => {
    const a = normalizeIp("2001:db8:1:2:aaaa:bbbb:cccc:dddd");
    expect(a).toBe("2001:0db8:0001:0002::/64");
    expect(normalizeIp("2001:DB8:1:2::1")).toBe(a);
    expect(normalizeIp("2001:db8:1:2:0:0:0:ffff")).toBe(a);
    expect(normalizeIp("2001:db8:1:3::1")).not.toBe(a);
    expect(normalizeIp("::1")).toBe("0000:0000:0000:0000::/64");
  });

  it("IPv4 disfrazada de IPv6 se trata como la IPv4", () => {
    expect(normalizeIp("::ffff:203.0.113.9")).toBe("203.0.113.9");
    expect(normalizeIp("203.0.113.9")).toBe("203.0.113.9");
  });
});

describe("límite de peticiones (Redis)", () => {
  it("deja pasar hasta el tope y corta la siguiente, con tiempo de espera", async () => {
    const ip = freshIp();
    const { limit } = POLICIES.badSignature;
    for (let i = 0; i < limit; i++) expect((await hitLimit("badSignature", ip)).allowed).toBe(true);
    const over = await hitLimit("badSignature", ip);
    expect(over.allowed).toBe(false);
    expect(over.source).toBe("redis");
    expect(over.retryAfterSec).toBeGreaterThan(0);
    expect(over.retryAfterSec).toBeLessThanOrEqual(POLICIES.badSignature.windowSec);
  });

  it("cada IP y cada política tienen su propio cupo", async () => {
    const a = freshIp();
    const b = freshIp();
    for (let i = 0; i < POLICIES.badSignature.limit + 1; i++) await hitLimit("badSignature", a);
    expect((await hitLimit("badSignature", a)).allowed).toBe(false);
    expect((await hitLimit("badSignature", b)).allowed).toBe(true);
    expect((await hitLimit("login", a)).allowed).toBe(true);
  });

  it("es atómico: 60 peticiones simultáneas dejan pasar EXACTAMENTE el tope", async () => {
    const ip = freshIp();
    const results = await Promise.all(Array.from({ length: 60 }, () => hitLimit("badSignature", ip)));
    expect(results.filter((r) => r.allowed)).toHaveLength(POLICIES.badSignature.limit);
  });

  it("la clave vence sola (no se acumulan claves eternas)", async () => {
    const ip = freshIp();
    await hitLimit("signup", ip);
    const Redis = (await import("ioredis")).default;
    const r = new Redis(process.env.REDIS_URL!);
    try {
      const keys = await r.keys(`test:rl:signup:${ip}`);
      expect(keys).toHaveLength(1);
      const ttl = await r.pttl(keys[0]!);
      expect(ttl).toBeGreaterThan(0);
      expect(ttl).toBeLessThanOrEqual(POLICIES.signup.windowSec * 1000);
    } finally {
      r.disconnect();
    }
  });

  it("peek mira sin contar", async () => {
    const ip = freshIp();
    for (let i = 0; i < 50; i++) expect((await peekLimit("badSignature", ip)).allowed).toBe(true);
    for (let i = 0; i < POLICIES.badSignature.limit; i++) await hitLimit("badSignature", ip);
    expect((await peekLimit("badSignature", ip)).allowed).toBe(false);
  });

  it("IP desconocida: cupo ampliado (todos comparten uno) pero con techo", async () => {
    const limit = POLICIES.badSignature.limit * 20;
    // Se usa una clave propia de la prueba para no depender de otras que usen "unknown".
    const results: boolean[] = [];
    for (let i = 0; i < limit + 1; i++) results.push((await hitLimit("badSignature", UNKNOWN_IP)).allowed);
    expect(results.slice(0, limit).every(Boolean)).toBe(true);
    expect(results[limit]).toBe(false);
  });

  it("RATE_LIMIT_DISABLED=1 lo apaga (solo pruebas)", async () => {
    process.env.RATE_LIMIT_DISABLED = "1";
    const ip = freshIp();
    for (let i = 0; i < 50; i++) expect((await hitLimit("badSignature", ip)).allowed).toBe(true);
  });
});

describe("route() con límite", () => {
  const ok = () => jsonResponse({ ok: true });
  const call = (handler: (r: Request) => Promise<Response>, ip: string) => handler(req({ "cf-connecting-ip": ip }));

  it("responde 429 con Retry-After y código claro al pasarse; otra IP sigue bien", async () => {
    const handler = route(async () => ok(), { limit: "signup" });
    const ip = freshIp();
    for (let i = 0; i < POLICIES.signup.limit; i++) expect((await call(handler, ip)).status).toBe(200);
    const blocked = await call(handler, ip);
    expect(blocked.status).toBe(429);
    expect(Number(blocked.headers.get("retry-after"))).toBeGreaterThan(0);
    expect((await blocked.json()).error).toBe("demasiadas_peticiones");
    expect((await call(handler, freshIp())).status).toBe(200);
  });

  it("el handler NO se ejecuta cuando está bloqueado", async () => {
    let runs = 0;
    const handler = route(async () => { runs++; return ok(); }, { limit: "signup" });
    const ip = freshIp();
    for (let i = 0; i < POLICIES.signup.limit + 5; i++) await call(handler, ip);
    expect(runs).toBe(POLICIES.signup.limit);
  });

  it("limit:false no limita; por defecto se usa la política 'api'", async () => {
    const free = route(async () => ok(), { limit: false });
    const ip = freshIp();
    for (let i = 0; i < POLICIES.signup.limit + 5; i++) expect((await call(free, ip)).status).toBe(200);
    const def = route(async () => ok());
    expect((await call(def, freshIp())).status).toBe(200);
  });

  it("los errores del handler siguen convirtiéndose igual (500 genérico, 404 por RLS)", async () => {
    const boom = route(async () => { throw Object.assign(new Error("secreto interno"), { code: "XX000" }); });
    const r = await call(boom, freshIp());
    expect(r.status).toBe(500);
    expect(JSON.stringify(await r.json())).not.toContain("secreto");
    const rls = route(async () => { throw Object.assign(new Error("x"), { code: "42501" }); });
    expect((await call(rls, freshIp())).status).toBe(404);
    expect(errorResponse(400, "a", "b").status).toBe(400);
  });
});

describe("webhook: firmas falsas", () => {
  const SECRET = "secreto-de-prueba-de-la-app-meta";
  beforeEach(() => {
    process.env.WHATSAPP_APP_SECRET = SECRET;
    process.env.WHATSAPP_VERIFY_TOKEN = "token-de-verificacion-de-prueba-123456";
  });
  const body = JSON.stringify({ object: "page", entry: [] }); // formato ajeno: si la firma es buena responde 200 "ignored"
  const post = (ip: string, sig: string) =>
    hookPost(new Request(`${ORIGIN}/api/webhooks/whatsapp`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-hub-signature-256": sig, "cf-connecting-ip": ip },
      body,
    }));
  const good = "sha256=" + createHmac("sha256", SECRET).update(body).digest("hex");
  const bad = "sha256=" + "0".repeat(64);

  it("tras 10 firmas falsas se corta esa IP con 429; otra IP con firma buena sigue pasando", async () => {
    const attacker = freshIp();
    for (let i = 0; i < POLICIES.badSignature.limit; i++) expect((await post(attacker, bad)).status).toBe(401);
    const cut = await post(attacker, bad);
    expect(cut.status).toBe(429);
    expect(cut.headers.get("retry-after")).toBeTruthy();
    // Mientras dura el castigo, ni siquiera una firma buena de esa IP entra (hay que esperar).
    expect((await post(attacker, good)).status).toBe(429);
    // Meta (otra IP) no se ve afectada.
    const meta = await post(freshIp(), good);
    expect(meta.status).toBe(200);
  });

  it("sin IP fiable (TRUSTED_PROXY=none) no se castiga a nadie: un atacante no puede dejar fuera a Meta", async () => {
    process.env.TRUSTED_PROXY = "none";
    resetMemoryLimits();
    const top = POLICIES.badSignature.limit * 20; // el cupo compartido de "IP desconocida"
    for (let i = 0; i < top + 5; i++) expect((await post("", bad)).status).toBe(401);
    expect((await post("", good)).status).toBe(200);
  });

  it("las firmas BUENAS nunca gastan el cupo de firmas falsas", async () => {
    const ip = freshIp();
    for (let i = 0; i < POLICIES.badSignature.limit * 3; i++) expect((await post(ip, good)).status).toBe(200);
    expect((await peekLimit("badSignature", ip)).allowed).toBe(true);
  });
});

describe("cabeceras de seguridad", () => {
  const prod = { appEnv: "production", dev: false };
  const csp = (o = prod) => buildCsp(o);

  it("la CSP cierra lo importante", () => {
    const c = csp();
    for (const d of ["default-src 'self'", "frame-ancestors 'none'", "object-src 'none'", "base-uri 'self'", "form-action 'self'", "frame-src 'none'"]) {
      expect(c).toContain(d);
    }
    expect(c).toContain("img-src 'self' data: blob:"); // el QR del 2FA
    expect(c).not.toMatch(/\*/); // nada de comodines
    expect(c).not.toContain("http:");
    expect(c).not.toContain("'unsafe-eval'");
  });

  it("'unsafe-eval' y WebSockets solo en desarrollo", () => {
    const dev = csp({ appEnv: "local", dev: true });
    expect(dev).toContain("'unsafe-eval'");
    expect(dev).toContain("ws:");
    expect(csp()).not.toContain("ws:");
  });

  it("upgrade-insecure-requests solo en servidores reales (en tu computadora rompería http://localhost)", () => {
    expect(csp()).toContain("upgrade-insecure-requests");
    expect(csp({ appEnv: "staging", dev: false })).toContain("upgrade-insecure-requests");
    expect(csp({ appEnv: "local", dev: false })).not.toContain("upgrade-insecure-requests");
    expect(csp({ appEnv: "test", dev: false })).not.toContain("upgrade-insecure-requests");
  });

  it("HSTS solo en producción (1 año) y staging (1 día); nunca en local", () => {
    expect(securityHeaders(prod)["Strict-Transport-Security"]).toBe("max-age=31536000");
    expect(securityHeaders({ appEnv: "staging", dev: false })["Strict-Transport-Security"]).toBe("max-age=86400");
    expect(securityHeaders({ appEnv: "local", dev: false })["Strict-Transport-Security"]).toBeUndefined();
    expect(securityHeaders({ appEnv: undefined, dev: false })["Strict-Transport-Security"]).toBeUndefined();
  });

  it("incluye el resto de cabeceras", () => {
    const h = securityHeaders(prod);
    expect(h["X-Content-Type-Options"]).toBe("nosniff");
    expect(h["Referrer-Policy"]).toBe("no-referrer");
    expect(h["X-Frame-Options"]).toBe("DENY");
    expect(h["Permissions-Policy"]).toContain("camera=()");
    expect(h["Cross-Origin-Opener-Policy"]).toBe("same-origin");
    expect(h["Cross-Origin-Resource-Policy"]).toBe("same-origin");
  });
});

describe("configuración de seguridad", () => {
  const withEnv = (vars: Record<string, string | undefined>, fn: () => void) => {
    const before = { ...process.env };
    for (const [k, v] of Object.entries(vars)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    try {
      fn();
    } finally {
      process.env = before;
    }
  };

  it("en producción y staging TRUSTED_PROXY es obligatorio", () => {
    for (const appEnv of ["production", "staging"]) {
      withEnv({ APP_ENV: appEnv, TRUSTED_PROXY: undefined, RATE_LIMIT_DISABLED: "0" }, () => expect(() => getSecurityEnv()).toThrow(/TRUSTED_PROXY/));
      withEnv({ APP_ENV: appEnv, TRUSTED_PROXY: "cloudflare", RATE_LIMIT_DISABLED: "0" }, () => expect(getSecurityEnv().trustedProxy).toBe("cloudflare"));
    }
  });

  it("apagar los límites no se permite en producción ni staging", () => {
    for (const appEnv of ["production", "staging"]) {
      withEnv({ APP_ENV: appEnv, TRUSTED_PROXY: "none", RATE_LIMIT_DISABLED: "1" }, () => expect(() => getSecurityEnv()).toThrow(/RATE_LIMIT_DISABLED/));
    }
  });

  it("en local todo es opcional (por defecto 'none') y valores raros se rechazan", () => {
    withEnv({ APP_ENV: "local", TRUSTED_PROXY: undefined, RATE_LIMIT_DISABLED: undefined }, () => {
      expect(getSecurityEnv()).toEqual({ trustedProxy: "none", rateLimitDisabled: false });
    });
    withEnv({ APP_ENV: "local", TRUSTED_PROXY: "cualquiera" }, () => expect(() => getSecurityEnv()).toThrow());
  });
});
