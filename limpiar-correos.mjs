// Borra los correos PENDIENTES de prueba (los de direcciones @example.test). Uso: node limpiar-correos.mjs  (desde la carpeta del proyecto)
import { readFileSync } from "node:fs";
import pg from "pg";
const env = Object.fromEntries(readFileSync(".env.local", "utf8").split("\n").filter((l) => l.includes("=") && !l.startsWith("#")).map((l) => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim().replace(/^["']|["']$/g, "")]));
const c = new pg.Client({ connectionString: env.MIGRATION_DATABASE_URL });
await c.connect();
console.log("Antes:", (await c.query("SELECT status, count(*)::int FROM email_outbox GROUP BY 1")).rows);
const r = await c.query("DELETE FROM email_outbox WHERE status = 'pendiente' AND to_email LIKE '%@example.test'");
console.log("Borrados:", r.rowCount);
console.log("Después:", (await c.query("SELECT status, count(*)::int FROM email_outbox GROUP BY 1")).rows);
await c.end();
