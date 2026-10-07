import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const url = process.env.MIGRATION_DATABASE_URL;
if (!url) {
  console.error("✖ Falta MIGRATION_DATABASE_URL (usuario app_owner).");
  process.exit(1);
}

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "db", "migrations");
const client = new pg.Client({ connectionString: url });

try {
  await client.connect();
  // Evita que dos ejecuciones migren a la vez.
  await client.query("SELECT pg_advisory_lock(727274)");

  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )`);
  // La aplicación no tiene por qué ver esta tabla.
  await client.query("REVOKE ALL ON schema_migrations FROM PUBLIC, app_user");

  const files = (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort();
  const done = new Set(
    (await client.query("SELECT version FROM schema_migrations")).rows.map((r) => r.version),
  );

  let applied = 0;
  for (const file of files) {
    if (done.has(file)) continue;
    const sql = await readFile(path.join(dir, file), "utf8");
    console.log(`→ Aplicando ${file}`);
    try {
      await client.query("BEGIN");
      await client.query(sql);
      await client.query("INSERT INTO schema_migrations (version) VALUES ($1)", [file]);
      await client.query("COMMIT");
      applied++;
    } catch (err) {
      await client.query("ROLLBACK");
      throw new Error(`Falló ${file}: ${err.message}`);
    }
  }

  console.log(applied ? `✔ ${applied} migración(es) aplicada(s).` : "✔ Base de datos al día.");
} catch (err) {
  console.error("✖", err.message);
  process.exitCode = 1;
} finally {
  await client.end();
}
