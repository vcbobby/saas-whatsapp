import { Worker } from "bullmq";
import { getPool } from "@/lib/db";
import { getLlmEnv, getSendMode } from "@/lib/env";
import { QUEUE_NAME, createWorkerConnection, queuePrefix } from "@/lib/queue/connection";
import { closeLockClient } from "@/lib/queue/lock";
import { closeProducer } from "@/lib/queue/producer";
import { processInbound } from "@/lib/queue/process";
import { sweepPending } from "@/lib/queue/sweeper";
import { createInboundHandler, onJobFailed } from "./handler";

const handler = createInboundHandler();

const CONCURRENCY = 5;
const SWEEP_EVERY_MS = 30_000;

const connection = createWorkerConnection();
const worker = new Worker(QUEUE_NAME, (job) => processInbound(job.data, handler), {
  connection,
  prefix: queuePrefix(),
  concurrency: CONCURRENCY,
});

worker.on("completed", (job, result) => {
  console.log(`[worker] trabajo ${job.id} → ${String(result)}`);
});
worker.on("failed", (job, err) => void onJobFailed(job, err));
worker.on("error", (err) => console.error("[worker] error:", err.message));

let sweeping = false;
async function sweep() {
  if (sweeping) return;
  sweeping = true;
  try {
    const n = await sweepPending();
    if (n > 0) console.log(`[worker] barrendero: ${n} mensajes pendientes reencolados`);
  } catch (err) {
    console.error("[worker] barrendero falló:", err instanceof Error ? err.message : err);
  } finally {
    sweeping = false;
  }
}
void sweep();
const timer = setInterval(sweep, SWEEP_EVERY_MS);

let closing = false;
async function shutdown(signal: string) {
  if (closing) return;
  closing = true;
  console.log(`[worker] ${signal}: cerrando con calma…`);
  clearInterval(timer);
  try {
    await worker.close();
    await closeProducer();
    await closeLockClient();
    connection.disconnect();
    await getPool().end();
  } finally {
    process.exit(0);
  }
}
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

const sendMode = getSendMode();
const llmProvider = getLlmEnv().LLM_PROVIDER;
if (sendMode === "simulate") console.warn("[worker] ⚠ MODO SIMULACIÓN: las respuestas NO se envían a WhatsApp (solo se ven en /simulador).");
if (llmProvider === "mock") console.warn("[worker] ⚠ IA en modo de prueba (mock): se responde con un texto fijo, no hay modelo conectado.");
console.log(`[worker] listo: escuchando la cola "${QUEUE_NAME}" (concurrencia ${CONCURRENCY})`);
