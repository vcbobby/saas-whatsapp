import { createInterface } from "node:readline";
import { hash } from "@node-rs/argon2";
import pg from "pg";

const url = process.env.MIGRATION_DATABASE_URL;
if (!url) {
  console.error("✖ Falta MIGRATION_DATABASE_URL.");
  process.exit(1);
}
// Pregunta sin mostrar lo que se escribe.
function ask(question, { hidden = false } = {}) {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    if (hidden) {
      rl._writeToOutput = (s) => {
        if (s.includes(question)) rl.output.write(s);
      };
    }
    rl.question(question, (answer) => {
      rl.close();
      if (hidden) process.stdout.write("\n");
      resolve(answer);
    });
  });
}

const email = (process.env.SUPERADMIN_EMAIL ?? (await ask("Correo del súper admin: "))).trim().toLowerCase();
const password = process.env.SUPERADMIN_PASSWORD ?? (await ask("Contraseña (mín. 16 caracteres): ", { hidden: true }));

if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
  console.error("✖ Correo inválido.");
  process.exit(1);
}
if (password.length < 16) {
  console.error("✖ La contraseña del súper admin debe tener al menos 16 caracteres.");
  process.exit(1);
}

const passwordHash = await hash(password.normalize("NFKC"), {
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
});

const client = new pg.Client({ connectionString: url });
try {
  await client.connect();
  await client.query(
    "INSERT INTO users (email, password_hash, is_super_admin) VALUES ($1, $2, true)",
    [email, passwordHash],
  );
  console.log(`✔ Súper admin creado: ${email}`);
  console.log("  Entra en la web y activa el 2FA en /seguridad: hasta entonces no tendrás poderes de súper admin.");
} catch (err) {
  if (err.code === "23505") console.error("✖ Ya existe un usuario con ese correo.");
  else console.error("✖", err.message);
  process.exitCode = 1;
} finally {
  await client.end();
}
