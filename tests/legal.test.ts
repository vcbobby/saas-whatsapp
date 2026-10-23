import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { POST as signup } from "@/app/api/auth/signup/route";
import { POST as inviteSignup } from "@/app/api/invitations/signup/route";
import { POST as teamInvite } from "@/app/api/team/invite/route";
import { POST as accept } from "@/app/api/legal/accept/route";
import { NextRequest } from "next/server";
import { GET as me } from "@/app/api/me/route";
import { proxy } from "@/proxy";
import { getPool } from "@/lib/db";
import { getConsentMode } from "@/lib/env";
import { getLegalStatus } from "@/lib/legal/consent";
import { LEGAL_SLUGS, LEGAL_VERSION, buildLegalDocs, pendingItems, type LegalFacts } from "@/lib/legal/docs";

const RUN = randomUUID().slice(0, 8);
const ORIGIN = new URL(process.env.APP_URL!).origin;
const PASSWORD = "contraseña-de-prueba-123";
const owner = new Pool({ connectionString: process.env.MIGRATION_DATABASE_URL, max: 2 });
const tenantIds: string[] = [];

const req = (method: string, path: string, cookie?: string, body?: unknown, origin = ORIGIN) =>
  new Request(`${ORIGIN}${path}`, { method, headers: { origin, ...(body !== undefined ? { "content-type": "application/json" } : {}), ...(cookie ? { cookie } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
const cookieOf = (res: Response) => (res.headers.get("set-cookie") ?? "").split(";")[0]!;
const emailOf = (n: string) => `lg-${RUN}-${n}@example.test`;

async function register(name: string, extra: Record<string, unknown> = {}) {
  const res = await signup(req("POST", "/api/auth/signup", undefined, { email: emailOf(name), password: PASSWORD, businessName: `Legal ${name}`, ...extra }));
  expect(res.status).toBe(201);
  const cookie = cookieOf(res);
  const info = await (await me(req("GET", "/api/me", cookie))).json();
  tenantIds.push(info.tenant.id);
  const userId = (await owner.query<{ id: string }>("SELECT id FROM users WHERE email = $1", [emailOf(name)])).rows[0]!.id;
  return { cookie, tenantId: info.tenant.id as string, userId };
}
const rows = async (userId: string) => (await getPool().query("SELECT * FROM legal_latest($1)", [userId])).rows;

afterEach(() => { vi.unstubAllEnvs(); });
afterAll(async () => {
  await owner.query("DELETE FROM users WHERE email LIKE $1", [`lg-${RUN}-%`]);
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
    } catch (e) { await c.query("ROLLBACK"); throw e; } finally { c.release(); }
  }
  await owner.end();
  await getPool().end();
});

const FULL: LegalFacts = { name: "MiMarca", legalName: "Mi Empresa C.A.", domain: "mimarca.example", email: "legal@mimarca.example", address: "Calle 1, Ciudad", country: "Venezuela, Caracas" };
const EMPTY: LegalFacts = { name: "MiMarca", legalName: "", domain: "", email: "", address: "", country: "" };

describe("documentos legales", () => {
  it("están todos, con identificadores únicos y secciones completas", () => {
    const docs = buildLegalDocs(FULL);
    expect(docs.map((d) => d.slug)).toEqual([...LEGAL_SLUGS]);
    expect(new Set(docs.map((d) => d.slug)).size).toBe(docs.length);
    for (const d of docs) {
      expect(d.title.length).toBeGreaterThan(5);
      expect(d.summary.length).toBeGreaterThan(10);
      expect(d.sections.length).toBeGreaterThanOrEqual(3);
      expect(new Set(d.sections.map((s) => s.id)).size).toBe(d.sections.length);
      for (const s of d.sections) {
        expect(s.heading.length).toBeGreaterThan(3);
        expect(s.body.length).toBeGreaterThan(0);
        for (const b of s.body) {
          if (typeof b === "string") expect(b.trim().length).toBeGreaterThan(10);
          else { expect(b.list.length).toBeGreaterThan(0); b.list.forEach((l) => expect(l.trim().length).toBeGreaterThan(10)); }
        }
      }
    }
  });

  it("usan el nombre y los datos configurados; lo que falta queda marcado como [PENDIENTE]", () => {
    const full = JSON.stringify(buildLegalDocs(FULL));
    for (const v of ["MiMarca", "Mi Empresa C.A.", "legal@mimarca.example", "mimarca.example", "Calle 1, Ciudad", "Venezuela, Caracas"]) expect(full).toContain(v);
    expect(full).not.toContain("example.com"); // nunca el correo de ejemplo del código
    const empty = buildLegalDocs(EMPTY);
    const items = pendingItems(empty).map((p) => p.item);
    expect(items).toContain("[PENDIENTE: razón social o nombre completo del titular]");
    expect(items).toContain("[PENDIENTE: correo de contacto]");
    expect(items).toContain("[PENDIENTE: dirección del titular]");
    // Con los datos completos quedan menos pendientes (solo las decisiones que no se pueden inferir).
    expect(pendingItems(buildLegalDocs(FULL)).length).toBeLessThan(items.length);
    expect(pendingItems(buildLegalDocs(FULL)).some((p) => p.item.includes("razón social"))).toBe(false);
  });

  it("cubren lo que se prometió: WhatsApp Business, IA, cookies, reembolsos, tratamiento de datos y derechos", () => {
    const by = Object.fromEntries(buildLegalDocs(FULL).map((d) => [d.slug, JSON.stringify(d)]));
    expect(by["uso-aceptable"]).toMatch(/WhatsApp Business/);
    expect(by["uso-aceptable"]).toMatch(/consentimiento previo/);
    expect(by["uso-aceptable"]).toMatch(/24 horas/);
    expect(by["inteligencia-artificial"]).toMatch(/pu[e]?de dar respuestas incorrectas/);
    expect(by["inteligencia-artificial"]).toMatch(/asistente automatizado/);
    expect(by["cookies"]).toMatch(/__Host-sid/);
    expect(by["cookies"]).toMatch(/No usamos cookies de publicidad/);
    expect(by["reembolsos"]).toMatch(/7 días/);
    expect(by["tratamiento-de-datos"]).toMatch(/responsable/);
    expect(by["tratamiento-de-datos"]).toMatch(/encargado/);
    expect(by["privacidad"]).toMatch(/Tus derechos/);
    expect(by["privacidad"]).toMatch(/Meta/);
    expect(by["terminos"]).toMatch(/Ley aplicable/);
  });

  it("la versión tiene formato válido (la base de datos la exige)", () => {
    expect(LEGAL_VERSION).toMatch(/^[0-9]{4}-[0-9]{2}-[0-9]{2}(-[a-z0-9]{1,20})?$/);
  });
});

describe("consentimiento al crear la cuenta", () => {
  it("modo «required»: sin aceptar no se crea nada; aceptando se registra la versión", async () => {
    vi.stubEnv("LEGAL_CONSENT", "required");
    const no = await signup(req("POST", "/api/auth/signup", undefined, { email: emailOf("sin"), password: PASSWORD, businessName: "Legal sin" }));
    expect(no.status).toBe(400);
    expect((await no.json()).error).toBe("debes_aceptar_terminos");
    expect((await signup(req("POST", "/api/auth/signup", undefined, { email: emailOf("sin"), password: PASSWORD, businessName: "Legal sin", acceptTerms: false }))).status).toBe(400);
    expect((await signup(req("POST", "/api/auth/signup", undefined, { email: emailOf("sin"), password: PASSWORD, businessName: "Legal sin", acceptTerms: "sí" }))).status).toBe(400);
    expect((await owner.query("SELECT 1 FROM users WHERE email = $1", [emailOf("sin")])).rowCount).toBe(0);

    const t = await register("con", { acceptTerms: true });
    const latest = await rows(t.userId);
    expect(latest).toHaveLength(1);
    expect(latest[0]).toMatchObject({ version: LEGAL_VERSION, context: "signup" });
    expect(await getLegalStatus(t.userId)).toMatchObject({ current: LEGAL_VERSION, accepted: LEGAL_VERSION, upToDate: true });
  });

  it("si la cuenta no se puede crear (correo repetido), no queda ninguna aceptación de más", async () => {
    vi.stubEnv("LEGAL_CONSENT", "required");
    const t = await register("dup", { acceptTerms: true });
    const again = await signup(req("POST", "/api/auth/signup", undefined, { email: emailOf("dup"), password: PASSWORD, businessName: "Otra", acceptTerms: true }));
    expect(again.status).toBe(409);
    const n = await getPool().query("SELECT version FROM legal_latest($1)", [t.userId]);
    expect(n.rows).toHaveLength(1);
  });

  it("modo «optional» (solo pruebas): se puede crear sin aceptar y entonces no hay registro", async () => {
    expect(getConsentMode()).toBe("optional");
    const t = await register("opt");
    expect(await rows(t.userId)).toHaveLength(0);
    expect(await getLegalStatus(t.userId)).toMatchObject({ accepted: null, acceptedAt: null, upToDate: false });
  });

  it("«optional» no se permite en producción ni en staging (cierra por defecto)", () => {
    for (const env of ["production", "staging"]) {
      vi.stubEnv("APP_ENV", env);
      vi.stubEnv("LEGAL_CONSENT", "optional");
      expect(() => getConsentMode()).toThrow(/staging ni producción/);
      vi.unstubAllEnvs();
    }
    vi.stubEnv("APP_ENV", "production");
    vi.stubEnv("LEGAL_CONSENT", "required");
    expect(getConsentMode()).toBe("required");
    vi.unstubAllEnvs();
    vi.stubEnv("LEGAL_CONSENT", "otra-cosa");
    expect(() => getConsentMode()).toThrow();
  });

  it("invitaciones: sin aceptar no se consume la invitación; aceptando se registra", async () => {
    vi.stubEnv("LEGAL_CONSENT", "required");
    const t = await register("inv", { acceptTerms: true });
    const inv = await teamInvite(req("POST", "/api/team/invite", t.cookie, { email: emailOf("invitado"), role: "agent" }));
    expect(inv.status).toBe(201);
    const token = ((await inv.json()).inviteUrl as string).split("/").pop()!;
    const no = await inviteSignup(req("POST", "/api/invitations/signup", undefined, { token, password: PASSWORD }));
    expect(no.status).toBe(400);
    expect((await no.json()).error).toBe("debes_aceptar_terminos");
    const ok = await inviteSignup(req("POST", "/api/invitations/signup", undefined, { token, password: PASSWORD, acceptTerms: true }));
    expect(ok.status).toBe(201); // la invitación seguía vigente
    const invitedId = (await owner.query<{ id: string }>("SELECT id FROM users WHERE email = $1", [emailOf("invitado")])).rows[0]!.id;
    expect(await rows(invitedId)).toMatchObject([{ version: LEGAL_VERSION, context: "invitation" }]);
  });
});

describe("volver a aceptar (POST /api/legal/accept)", () => {
  it("registra la versión vigente; es idempotente", async () => {
    const t = await register("re1");
    expect(await getLegalStatus(t.userId)).toMatchObject({ upToDate: false });
    const r1 = await accept(req("POST", "/api/legal/accept", t.cookie, { version: LEGAL_VERSION }));
    expect(r1.status).toBe(200);
    expect(await r1.json()).toMatchObject({ ok: true, version: LEGAL_VERSION });
    const first = (await getLegalStatus(t.userId)).acceptedAt;
    await new Promise((r) => setTimeout(r, 30));
    expect((await accept(req("POST", "/api/legal/accept", t.cookie, { version: LEGAL_VERSION }))).status).toBe(200);
    expect((await getLegalStatus(t.userId)).acceptedAt).toBe(first); // la fecha de la primera aceptación no se pisa
    expect(await getLegalStatus(t.userId)).toMatchObject({ accepted: LEGAL_VERSION, upToDate: true });
    expect(await rows(t.userId)).toMatchObject([{ context: "reaccept" }]);
  });

  it("una versión vieja de la pantalla da 409 y no registra nada; formato malo da 400", async () => {
    const t = await register("re2");
    expect((await accept(req("POST", "/api/legal/accept", t.cookie, { version: "2020-01-01" }))).status).toBe(409);
    expect((await accept(req("POST", "/api/legal/accept", t.cookie, { version: "2099-12-31" }))).status).toBe(409);
    expect((await accept(req("POST", "/api/legal/accept", t.cookie, { version: "x'; DROP TABLE users;--" }))).status).toBe(400);
    expect((await accept(req("POST", "/api/legal/accept", t.cookie, {}))).status).toBe(400);
    expect(await rows(t.userId)).toHaveLength(0);
  });

  it("exige sesión y origen propio", async () => {
    const t = await register("re3");
    expect((await accept(req("POST", "/api/legal/accept", undefined, { version: LEGAL_VERSION }))).status).toBe(401);
    expect((await accept(req("POST", "/api/legal/accept", "sid=falso", { version: LEGAL_VERSION }))).status).toBe(401);
    expect((await accept(req("POST", "/api/legal/accept", t.cookie, { version: LEGAL_VERSION }, "https://malo.example"))).status).toBe(403);
    expect(await rows(t.userId)).toHaveLength(0);
  });

  it("la «última» aceptación es la más reciente: una versión nueva reemplaza a la vieja en el estado", async () => {
    const t = await register("re4");
    await getPool().query("SELECT legal_accept($1, '2020-01-01', 'signup')", [t.userId]);
    expect(await getLegalStatus(t.userId)).toMatchObject({ accepted: "2020-01-01", upToDate: false });
    await accept(req("POST", "/api/legal/accept", t.cookie, { version: LEGAL_VERSION }));
    expect(await getLegalStatus(t.userId)).toMatchObject({ accepted: LEGAL_VERSION, upToDate: true });
  });
});

describe("direcciones /legal", () => {
  const go = (path: string) => proxy(new NextRequest(`${ORIGIN}${path}`));
  const notFound = (r: Response) => (r.headers.get("x-middleware-rewrite") ?? "").endsWith("/no-existe");
  it("los documentos pasan; cualquier otra dirección bajo /legal responde 404 real", async () => {
    for (const slug of LEGAL_SLUGS) expect(notFound(await go(`/legal/${slug}`))).toBe(false);
    expect(notFound(await go("/legal"))).toBe(false);
    for (const bad of ["/legal/no-existe", "/legal/Terminos", "/legal/terminos-x", "/legal/%E0%A4%A", "/legal/..%2Fadmin"]) {
      expect(notFound(await go(bad)), bad).toBe(true);
    }
  });
});

describe("la tabla de aceptaciones", () => {
  it("la aplicación no puede leerla ni escribirla directamente", async () => {
    for (const q of ["SELECT * FROM legal_acceptances", "DELETE FROM legal_acceptances", "UPDATE legal_acceptances SET version = '2000-01-01'", "INSERT INTO legal_acceptances (user_id, version, context) VALUES (gen_random_uuid(), '2026-01-01', 'signup')"]) {
      await expect(getPool().query(q)).rejects.toMatchObject({ code: "42501" });
    }
  });

  it("legal_accept valida: usuario inexistente, versión mal formada y contexto inválido", async () => {
    const t = await register("val");
    await expect(getPool().query("SELECT legal_accept(gen_random_uuid(), '2026-01-01', 'signup')")).rejects.toMatchObject({ code: "P0002" });
    await expect(getPool().query("SELECT legal_accept($1, 'version-mala', 'signup')", [t.userId])).rejects.toMatchObject({ code: "23514" });
    await expect(getPool().query("SELECT legal_accept($1, '2026-01-01', 'otro')", [t.userId])).rejects.toMatchObject({ code: "23514" });
  });

  it("borrar al usuario borra sus aceptaciones (no quedan datos huérfanos)", async () => {
    const t = await register("borrar", { acceptTerms: true });
    expect(await rows(t.userId)).toHaveLength(1);
    // Se saca al usuario del negocio y se borra la cuenta; el negocio se limpia al final con el resto.
    await owner.query("DELETE FROM users WHERE id = $1", [t.userId]);
    expect(await rows(t.userId)).toHaveLength(0);
  });
});
