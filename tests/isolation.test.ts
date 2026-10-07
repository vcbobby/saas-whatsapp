import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getPool, resolveTenantIdByPhoneNumberId, withTenant } from "@/lib/db";

const A = randomUUID();
const B = randomUUID();
const telefonoA = `5841${Math.floor(Math.random() * 1e8)}`;
const telefonoB = `5842${Math.floor(Math.random() * 1e8)}`;
const phoneIdA = `pn-${randomUUID()}`;

const ids = { contactoA: "", contactoB: "", convA: "", convB: "" };

async function codigoDeError(promesa: Promise<unknown>): Promise<string | undefined> {
  try {
    await promesa;
    return undefined;
  } catch (e) {
    return (e as { code?: string }).code ?? "sin-codigo";
  }
}

async function crearNegocio(id: string, telefono: string) {
  return withTenant(id, async (db) => {
    await db.query("INSERT INTO tenants (id, name, slug) VALUES ($1, $2, $3)", [
      id,
      `Negocio ${id.slice(0, 4)}`,
      `t-${id.slice(0, 8)}`,
    ]);
    const c = await db.query<{ id: string }>(
      "INSERT INTO contacts (tenant_id, wa_id, display_name) VALUES ($1, $2, 'Cliente') RETURNING id",
      [id, telefono],
    );
    const v = await db.query<{ id: string }>(
      "INSERT INTO conversations (tenant_id, contact_id) VALUES ($1, $2) RETURNING id",
      [id, c.rows[0]!.id],
    );
    await db.query(
      "INSERT INTO messages (tenant_id, conversation_id, direction, body) VALUES ($1, $2, 'in', 'hola')",
      [id, v.rows[0]!.id],
    );
    return { contacto: c.rows[0]!.id, conv: v.rows[0]!.id };
  });
}

describe("aislamiento entre negocios", () => {
  beforeAll(async () => {
    const a = await crearNegocio(A, telefonoA);
    const b = await crearNegocio(B, telefonoB);
    ids.contactoA = a.contacto;
    ids.convA = a.conv;
    ids.contactoB = b.contacto;
    ids.convB = b.conv;
  });

  afterAll(async () => {
    await withTenant(A, (db) => db.query("DELETE FROM tenants WHERE id = $1", [A]));
    await withTenant(B, (db) => db.query("DELETE FROM tenants WHERE id = $1", [B]));
    await getPool().end();
  });

  it("el negocio A solo ve sus propias filas", async () => {
    const r = await withTenant(A, async (db) => ({
      tenants: (await db.query("SELECT id FROM tenants")).rows,
      contactos: (await db.query("SELECT id FROM contacts")).rows,
      conversaciones: (await db.query("SELECT id FROM conversations")).rows,
      mensajes: (await db.query("SELECT id FROM messages")).rows,
    }));
    expect(r.tenants).toHaveLength(1);
    expect(r.contactos).toEqual([{ id: ids.contactoA }]);
    expect(r.conversaciones).toEqual([{ id: ids.convA }]);
    expect(r.mensajes).toHaveLength(1);
  });

  it("A no puede leer un contacto de B ni conociendo su id", async () => {
    const r = await withTenant(A, (db) =>
      db.query("SELECT * FROM contacts WHERE id = $1", [ids.contactoB]),
    );
    expect(r.rows).toHaveLength(0);
  });

  it("A no puede modificar ni borrar filas de B", async () => {
    const upd = await withTenant(A, (db) =>
      db.query("UPDATE contacts SET display_name = 'hackeado' WHERE id = $1", [ids.contactoB]),
    );
    const del = await withTenant(A, (db) =>
      db.query("DELETE FROM messages WHERE tenant_id = $1", [B]),
    );
    expect(upd.rowCount).toBe(0);
    expect(del.rowCount).toBe(0);
    const nombre = await withTenant(B, (db) =>
      db.query("SELECT display_name FROM contacts WHERE id = $1", [ids.contactoB]),
    );
    expect(nombre.rows[0]?.display_name).toBe("Cliente");
  });

  it("A no puede insertar filas a nombre de B", async () => {
    const codigo = await codigoDeError(
      withTenant(A, (db) =>
        db.query("INSERT INTO contacts (tenant_id, wa_id) VALUES ($1, '584100000000')", [B]),
      ),
    );
    expect(codigo).toBe("42501");
  });

  it("A no puede mover una fila a B con UPDATE", async () => {
    const codigo = await codigoDeError(
      withTenant(A, (db) => db.query("UPDATE contacts SET tenant_id = $1", [B])),
    );
    expect(codigo).toBe("42501");
  });

  it("una conversación de A no puede apuntar a un contacto de B", async () => {
    const codigo = await codigoDeError(
      withTenant(A, (db) =>
        db.query("INSERT INTO conversations (tenant_id, contact_id) VALUES ($1, $2)", [
          A,
          ids.contactoB,
        ]),
      ),
    );
    expect(codigo).toBe("23503");
  });

  it("sin negocio fijado no se ve ninguna fila", async () => {
    const r = await getPool().query("SELECT id FROM contacts");
    expect(r.rows).toHaveLength(0);
  });

  it("el negocio fijado no se arrastra a la siguiente consulta de la misma conexión", async () => {
    const unica = new Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
    try {
      await withTenantEn(unica, A);
      const despues = await unica.query("SELECT id FROM contacts");
      expect(despues.rows).toHaveLength(0);
    } finally {
      await unica.end();
    }
  });

  it("rechaza identificadores de negocio inválidos o con inyección", async () => {
    await expect(withTenant("no-es-uuid", async () => 1)).rejects.toThrow(/inválido/);
    await expect(withTenant(`${A}'; DROP TABLE tenants;--`, async () => 1)).rejects.toThrow(
      /inválido/,
    );
  });

  it("la aplicación no es superusuario, no salta RLS y no es dueña de las tablas", async () => {
    const rol = await getPool().query(
      "SELECT rolsuper, rolbypassrls, current_user AS usuario FROM pg_roles WHERE rolname = current_user",
    );
    expect(rol.rows[0].rolsuper).toBe(false);
    expect(rol.rows[0].rolbypassrls).toBe(false);
    const dueno = await getPool().query(
      "SELECT tableowner FROM pg_tables WHERE schemaname = 'public' AND tablename = 'contacts'",
    );
    expect(dueno.rows[0].tableowner).not.toBe(rol.rows[0].usuario);
  });

  it("la aplicación no puede ver la tabla de migraciones ni crear tablas", async () => {
    expect(await codigoDeError(getPool().query("SELECT * FROM schema_migrations"))).toBe("42501");
    expect(await codigoDeError(getPool().query("CREATE TABLE intruso (x int)"))).toBe("42501");
  });

  it("las integraciones de A son invisibles para B y se resuelven por número", async () => {
    await withTenant(A, (db) =>
      db.query(
        "INSERT INTO tenant_integrations (tenant_id, provider, external_id, secret_enc) VALUES ($1, 'whatsapp', $2, 'cifrado')",
        [A, phoneIdA],
      ),
    );
    const vistaB = await withTenant(B, (db) => db.query("SELECT id FROM tenant_integrations"));
    expect(vistaB.rows).toHaveLength(0);
    const sinContexto = await getPool().query("SELECT id FROM tenant_integrations");
    expect(sinContexto.rows).toHaveLength(0);

    expect(await resolveTenantIdByPhoneNumberId(phoneIdA)).toBe(A);
    expect(await resolveTenantIdByPhoneNumberId("numero-inexistente")).toBeNull();
  });

  it("la auditoría es de solo inserción y respeta el aislamiento", async () => {
    const c = await getPool().connect();
    try {
      await c.query("BEGIN");
      await c.query("SELECT set_config('app.tenant_id', $1, true)", [A]);
      await c.query("INSERT INTO audit_log (tenant_id, action) VALUES ($1, 'prueba')", [A]);

      await c.query("SAVEPOINT s1");
      expect(await codigoDeError(c.query("UPDATE audit_log SET action = 'x'"))).toBe("42501");
      await c.query("ROLLBACK TO SAVEPOINT s1");

      await c.query("SAVEPOINT s2");
      expect(await codigoDeError(c.query("DELETE FROM audit_log"))).toBe("42501");
      await c.query("ROLLBACK TO SAVEPOINT s2");

      await c.query("SAVEPOINT s3");
      expect(
        await codigoDeError(c.query("INSERT INTO audit_log (tenant_id, action) VALUES ($1, 'x')", [B])),
      ).toBe("42501");
      await c.query("ROLLBACK TO SAVEPOINT s3");
    } finally {
      await c.query("ROLLBACK");
      c.release();
    }
  });
});

// Fija el negocio en una transacción de una piscina propia (para probar la fuga entre consultas).
async function withTenantEn(pool: Pool, tenantId: string) {
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    await c.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
    const dentro = await c.query("SELECT id FROM contacts");
    expect(dentro.rows.length).toBeGreaterThan(0);
    await c.query("COMMIT");
  } finally {
    c.release();
  }
}
