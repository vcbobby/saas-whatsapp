import { Pool, type PoolClient } from "pg";
import { getEnv } from "@/lib/env";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// Una sola piscina de conexiones por proceso, incluso con recarga en desarrollo.
const globalRef = globalThis as unknown as { __pgPool?: Pool };

export function getPool(): Pool {
  if (!globalRef.__pgPool) {
    const env = getEnv();
    const pool = new Pool({
      connectionString: env.DATABASE_URL,
      max: env.DB_POOL_MAX,
      ssl: env.DB_SSL ? { rejectUnauthorized: true } : undefined,
      connectionTimeoutMillis: 5_000,
      idleTimeoutMillis: 30_000,
      statement_timeout: 15_000,
      idle_in_transaction_session_timeout: 15_000,
    });
    pool.on("error", (err) => {
      console.error("[db] error en una conexión inactiva:", err.message);
    });
    globalRef.__pgPool = pool;
  }
  return globalRef.__pgPool;
}

/**
 * ÚNICA forma de consultar datos de un negocio.
 * Abre una transacción, fija el negocio con set_config(..., true) (vale solo
 * dentro de esta transacción, nunca se arrastra a otra petición) y ejecuta fn.
 * El `tenantId` debe salir SIEMPRE de la sesión del servidor, nunca del navegador.
 */
export async function withTenant<T>(
  tenantId: string,
  fn: (db: PoolClient) => Promise<T>,
): Promise<T> {
  if (!UUID_RE.test(tenantId)) throw new Error("tenantId inválido");

  const client = await getPool().connect();
  let roto = false;
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch {
      roto = true; // la conexión quedó inservible: se descarta
    }
    throw err;
  } finally {
    client.release(roto);
  }
}

/**
 * ÚNICA consulta que se hace sin negocio: buscar a quién pertenece un número
 * de WhatsApp (Paso 6). Devuelve solo el id del negocio, nunca secretos.
 */
export async function resolveTenantIdByPhoneNumberId(
  phoneNumberId: string,
): Promise<string | null> {
  const r = await getPool().query<{ tenant_id: string | null }>(
    "SELECT resolve_tenant_by_phone_number_id($1) AS tenant_id",
    [phoneNumberId],
  );
  return r.rows[0]?.tenant_id ?? null;
}
