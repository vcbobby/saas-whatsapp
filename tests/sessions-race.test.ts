import { randomUUID, randomBytes } from "node:crypto";
import { Pool } from "pg";
import { afterAll, describe, expect, it } from "vitest";
import { POST as signup } from "@/app/api/auth/signup/route";
import { getPool } from "@/lib/db";

const RUN = randomUUID().slice(0, 8);
const ORIGIN = new URL(process.env.APP_URL!).origin;
// Muchas conexiones a la vez: lo que hace falta para que la carrera aparezca.
const owner = new Pool({ connectionString: process.env.MIGRATION_DATABASE_URL, max: 40 });
const emails: string[] = [];

async function userId(name: string) {
  const email = `race-${RUN}-${name}@example.test`;
  emails.push(email);
  const res = await signup(new Request(`${ORIGIN}/api/auth/signup`, { method: "POST", headers: { origin: ORIGIN, "content-type": "application/json" }, body: JSON.stringify({ email, password: "contraseña-de-prueba-123", businessName: `Negocio ${name}` }) }));
  expect(res.status).toBe(201);
  return (await owner.query("SELECT id FROM users WHERE email = $1", [email])).rows[0].id as string;
}
const issue = (id: string, pending: boolean) => owner.query("SELECT auth_issue_session($1, $2, 'test', $3)", [id, randomBytes(32), pending]);
const active = async (id: string, pending: boolean) =>
  (await owner.query("SELECT count(*)::int AS n FROM sessions WHERE user_id = $1 AND mfa_pending = $2 AND revoked_at IS NULL AND expires_at > now()", [id, pending])).rows[0].n as number;

afterAll(async () => {
  await owner.query("DELETE FROM users WHERE email LIKE $1", [`race-${RUN}-%`]);
  const t = await owner.query("SELECT 1");
  void t;
  await owner.end();
  await getPool().end();
});

describe("tope de sesiones con inicios de sesión simultáneos", () => {
  it("40 sesiones completas a la vez dejan exactamente 10 activas", async () => {
    const id = await userId("full");
    await Promise.all(Array.from({ length: 40 }, () => issue(id, false)));
    expect(await active(id, false)).toBe(10);
  });

  it("40 sesiones pendientes de 2FA a la vez dejan como mucho 3", async () => {
    const id = await userId("pend");
    await Promise.all(Array.from({ length: 40 }, () => issue(id, true)));
    expect(await active(id, true)).toBe(3);
  });

  it("repetido varias veces nunca se pasa del tope", async () => {
    const id = await userId("rep");
    for (let i = 0; i < 4; i++) {
      await Promise.all(Array.from({ length: 25 }, () => issue(id, false)));
      expect(await active(id, false)).toBeLessThanOrEqual(10);
    }
  });

  it("el candado es por usuario: no frena a los demás", async () => {
    const a = await userId("a");
    const b = await userId("b");
    await Promise.all([...Array.from({ length: 15 }, () => issue(a, false)), ...Array.from({ length: 15 }, () => issue(b, false))]);
    expect(await active(a, false)).toBe(10);
    expect(await active(b, false)).toBe(10);
  });
});
