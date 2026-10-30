import IORedis from "ioredis";
import pg from "pg";
import { loadEnv } from "vite";

// Antes de los tests: borra las claves de Redis que dejaron pruebas anteriores
// (solo las que empiezan por "test"; nunca toca la cola real "saas").
export default async function setup() {
  await cleanTestEmails();
  const url = loadEnv("test", process.cwd(), "").REDIS_URL ?? process.env.REDIS_URL;
  if (!url) return;
  const redis = new IORedis(url, { maxRetriesPerRequest: 1, connectTimeout: 2_000, lazyConnect: true });
  redis.on("error", () => {});
  try {
    await redis.connect();
    let cursor = "0";
    do {
      const [next, keys] = await redis.scan(cursor, "MATCH", "test*", "COUNT", 500);
      cursor = next;
      if (keys.length) await redis.del(...keys);
    } while (cursor !== "0");
  } catch {
    // Sin Redis los tests de cola fallarán por sí solos con un mensaje claro.
  } finally {
    redis.disconnect();
  }
}

// Los correos de las pruebas (todas las direcciones @example.test) se quedan en la bandeja de salida y, acumulados, llegan al tope de
// 5000 pendientes: entonces las pruebas de correo fallan. Se borran antes de cada ejecución (nunca toca direcciones reales).
async function cleanTestEmails() {
  const url = loadEnv("test", process.cwd(), "").MIGRATION_DATABASE_URL ?? process.env.MIGRATION_DATABASE_URL;
  if (!url) return;
  const client = new pg.Client({ connectionString: url });
  try {
    await client.connect();
    await client.query("DELETE FROM email_outbox WHERE to_email LIKE '%@example.test'");
  } catch {
    // Sin base de datos (o sin la tabla todavía) las pruebas fallarán por sí solas con un mensaje claro.
  } finally {
    await client.end().catch(() => {});
  }
}
