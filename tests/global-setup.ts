import IORedis from "ioredis";
import { loadEnv } from "vite";

// Antes de los tests: borra las claves de Redis que dejaron pruebas anteriores
// (solo las que empiezan por "test"; nunca toca la cola real "saas").
export default async function setup() {
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
