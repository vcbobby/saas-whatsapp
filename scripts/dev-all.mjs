// Un solo comando para desarrollo: base de datos + Redis + migraciones + web + worker.
//   npm run dev:all        (SKIP_DOCKER=1 si Postgres y Redis ya están corriendo por otro lado)
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";

if (!existsSync(".env.local")) {
  console.error("✖ Falta .env.local. Genera uno con: bash scripts/gen-local-env.sh");
  process.exit(1);
}

function run(cmd, args, label) {
  const r = spawnSync(cmd, args, { stdio: "inherit" });
  if (r.error || r.status !== 0) {
    console.error(`✖ Falló: ${label}${r.error ? ` (${r.error.message})` : ""}`);
    process.exit(1);
  }
}

if (process.env.SKIP_DOCKER !== "1") {
  console.log("▶ Levantando Postgres y Redis (Docker)…");
  run("docker", ["compose", "--env-file", ".env.local", "up", "-d", "--wait", "db", "redis"], "docker compose (¿está abierto Docker Desktop?)");
}
console.log("▶ Aplicando migraciones…");
run("node", ["--env-file=.env.local", "scripts/migrate.mjs"], "migraciones");

const children = [];
let stopping = false;

function prefixLines(stream, out, tag) {
  let buf = "";
  stream.on("data", (chunk) => {
    buf += chunk.toString();
    const lines = buf.split("\n");
    buf = lines.pop() ?? "";
    for (const l of lines) out.write(`${tag} ${l}\n`);
  });
  stream.on("end", () => { if (buf) out.write(`${tag} ${buf}\n`); });
}

function start(tag, script) {
  // detached: cada uno en su propio grupo de procesos, para poder cerrar también a sus hijos (next, tsx).
  const child = spawn("npm", ["run", script], { stdio: ["ignore", "pipe", "pipe"], detached: true, env: process.env });
  prefixLines(child.stdout, process.stdout, tag);
  prefixLines(child.stderr, process.stderr, tag);
  child.on("exit", (code, sig) => {
    if (!stopping) {
      console.error(`✖ ${tag} terminó (${sig ?? code}). Cerrando todo.`);
      stop(1);
    }
  });
  children.push(child);
}

function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const c of children) {
    try { if (c.pid) process.kill(-c.pid, "SIGTERM"); } catch { /* ya terminó */ }
  }
  const t = setTimeout(() => {
    for (const c of children) { try { if (c.pid) process.kill(-c.pid, "SIGKILL"); } catch { /* ya terminó */ } }
    process.exit(code);
  }, 5000);
  Promise.all(children.map((c) => new Promise((r) => (c.exitCode !== null || c.signalCode ? r() : c.once("exit", r))))).then(() => { clearTimeout(t); process.exit(code); });
}
process.on("SIGINT", () => stop(0));
process.on("SIGTERM", () => stop(0));

console.log("▶ Iniciando web y worker. Para cerrar todo: Ctrl+C\n");
start("[web]   ", "dev");
start("[worker]", "worker");
console.log("   Cuando diga «Ready», abre http://localhost:3000/simulador (inicia sesión primero).\n");
