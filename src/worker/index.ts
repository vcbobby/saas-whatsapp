import { Worker } from "bullmq";
import { getPool } from "@/lib/db";
import { getEmailEnv, getEmbeddingsEnv, getLlmEnv, getSendMode } from "@/lib/env";
import { QUEUE_NAME, createWorkerConnection, queuePrefix } from "@/lib/queue/connection";
import { closeLockClient } from "@/lib/queue/lock";
import { closeProducer } from "@/lib/queue/producer";
import { processInbound } from "@/lib/queue/process";
import { sweepPending } from "@/lib/queue/sweeper";
import { createInboundHandler, onJobFailed } from "./handler";
import { indexPending } from "./kb";
import { deliverDue } from "@/lib/webhooks/deliver";
import { sendDue } from "@/lib/notifications/send";
import { tickAutomations } from "@/lib/automations/tick";
import { notifyHandoffs } from "@/lib/notifications/handoff";
import { purgeDueTenants } from "@/lib/privacy/deletion";
import { refreshRate } from "@/lib/billing/rate-refresh";
import { queuePlanNotices, sendDueEmails } from "@/lib/email/outbox";
import { HEARTBEAT_EVERY_MS, writeHeartbeat } from "@/lib/queue/heartbeat";

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

// Indexado de documentos de la base de conocimiento (cada pocos segundos; la cola vive en Postgres).
const KB_EVERY_MS = 5_000;
let indexing = false;
async function indexKb() {
  if (indexing || closing) return;
  indexing = true;
  try {
    await indexPending();
  } catch (err) {
    console.error("[worker] indexado de conocimiento falló:", err instanceof Error ? err.message : err);
  } finally {
    indexing = false;
  }
}
const kbTimer = setInterval(() => void indexKb(), KB_EVERY_MS);

// Avisos (webhooks) a otros sistemas: la cola vive en Postgres; se revisa cada pocos segundos.
const WEBHOOK_EVERY_MS = 3_000;
let delivering = false;
async function deliverWebhooks() {
  if (delivering || closing) return;
  delivering = true;
  try {
    // Mientras haya entregas vencidas se sigue sin esperar al siguiente turno (hasta un tope por vuelta).
    for (let i = 0; i < 10 && !closing; i++) {
      const c = await deliverDue(5);
      if (c.delivered + c.retry + c.failed + c.skipped === 0) break;
    }
  } catch (err) {
    console.error("[worker] avisos (webhooks) falló:", err instanceof Error ? err.message : err);
  } finally {
    delivering = false;
  }
}
const webhookTimer = setInterval(() => void deliverWebhooks(), WEBHOOK_EVERY_MS);

// Avisos automáticos a clientes por WhatsApp (los crean las reglas de «Automatizaciones»).
const NOTIFY_EVERY_MS = 3_000;
let notifying = false;
async function sendNotifications() {
  if (notifying || closing) return;
  notifying = true;
  try {
    for (let i = 0; i < 10 && !closing; i++) {
      const c = await sendDue(5);
      if (c.sent + c.retry + c.omitted + c.failed + c.skipped === 0) break;
    }
  } catch (err) {
    console.error("[worker] avisos a clientes falló:", err instanceof Error ? err.message : err);
  } finally {
    notifying = false;
  }
}
const notifyTimer = setInterval(() => void sendNotifications(), NOTIFY_EVERY_MS);

// Reglas por tiempo («24 h antes de una cita», «pedido sin confirmar»): se revisan cada 30 s solo los negocios que las usan.
let ticking = false;
async function tickTime() {
  if (ticking || closing) return;
  ticking = true;
  try {
    await tickAutomations();
    await notifyHandoffs();
  } catch (err) {
    console.error("[worker] reglas por tiempo falló:", err instanceof Error ? err.message : err);
  } finally {
    ticking = false;
  }
}
const tickTimer = setInterval(() => void tickTime(), 15_000);

// Suscripciones: quien no renovó pasa a «pago pendiente» (no responde a clientes hasta que pague). Cada 10 min.
let expiring = false;
async function expireSubs() {
  if (expiring || closing) return;
  expiring = true;
  try {
    const r = await getPool().query("SELECT expire_subscriptions() AS n");
    if (Number(r.rows[0].n) > 0) console.log(`[worker] ${r.rows[0].n} suscripción(es) vencida(s)`);
  } catch (err) {
    console.error("[worker] vencimientos falló:", err instanceof Error ? err.message : err);
  } finally {
    expiring = false;
  }
}
const expireTimer = setInterval(() => void expireSubs(), 600_000);
setTimeout(() => void expireSubs(), 5_000);

// Eliminación de negocios: cuando pasan los 7 días de espera se borra todo de forma definitiva. Cada 10 min.
let purging = false;
async function purgeTenants() {
  if (purging || closing) return;
  purging = true;
  try {
    const n = await purgeDueTenants();
    if (n > 0) console.log(`[worker] ${n} negocio(s) eliminado(s) definitivamente`);
  } catch (err) {
    console.error("[worker] eliminación de negocios falló:", err instanceof Error ? err.message : err);
  } finally {
    purging = false;
  }
}
const purgeTimer = setInterval(() => void purgeTenants(), 600_000);
setTimeout(() => void purgeTenants(), 8_000);

// Tasa BCV automática: solo actúa si el súper admin puso el modo «automático». Cada 30 min.
let refreshingRate = false;
async function refreshRateJob() {
  if (refreshingRate || closing) return;
  refreshingRate = true;
  try {
    const r = await refreshRate();
    if (r.status === "ok") console.log(`[worker] tasa BCV ${r.rate} (${r.source})`);
    else if (r.status === "rejected") console.error(`[worker] tasa BCV ${r.rate} rechazada por cambio brusco (${r.source}); el súper admin debe revisarla`);
    else if (r.status === "failed") console.error("[worker] tasa BCV: ninguna fuente respondió bien:", r.error);
  } catch (err) {
    console.error("[worker] tasa BCV falló:", err instanceof Error ? err.message : err);
  } finally {
    refreshingRate = false;
  }
}
const rateTimer = setInterval(() => void refreshRateJob(), 1_800_000);
setTimeout(() => void refreshRateJob(), 12_000);

// Latido: lo lee /api/health (con token) y deploy/estado.sh para saber que el worker está vivo.
const beat = () => void writeHeartbeat(connection).catch((err) => console.error("[worker] latido falló:", err instanceof Error ? err.message : err));
beat();
const beatTimer = setInterval(beat, HEARTBEAT_EVERY_MS);

let closing = false;
async function shutdown(signal: string) {
  if (closing) return;
  closing = true;
  console.log(`[worker] ${signal}: cerrando con calma…`);
  clearInterval(timer);
  clearInterval(kbTimer);
  clearInterval(webhookTimer);
  clearInterval(notifyTimer);
  clearInterval(tickTimer);
  clearInterval(expireTimer);
  clearInterval(purgeTimer);
  clearInterval(rateTimer);
  clearInterval(mailTimer);
  clearInterval(noticeTimer);
  clearInterval(beatTimer);
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
// Sin IA configurada (por ejemplo, un servidor recién montado) el worker NO se cae: sigue con lo demás (documentos, webhooks,
// vencimientos, tasa, eliminaciones) y el asistente simplemente no responde hasta que se configure LLM_* (falla cerrado).
let llmProvider: string = "sin-configurar";
try {
  llmProvider = getLlmEnv().LLM_PROVIDER;
} catch (err) {
  console.error("[worker] ⚠ IA NO CONFIGURADA: el asistente no responderá hasta que se configure. Detalle:", err instanceof Error ? err.message : err);
}
if (sendMode === "simulate") console.warn("[worker] ⚠ MODO SIMULACIÓN: las respuestas NO se envían a WhatsApp (solo se ven en /simulador).");
if (getEmbeddingsEnv().EMBEDDINGS_PROVIDER === "fake") console.warn("[worker] ⚠ Embeddings de prueba (fake): la búsqueda en documentos solo coincide por palabras, no por significado.");
if (llmProvider === "mock") console.warn("[worker] ⚠ IA en modo de prueba (mock): se responde con un texto fijo, no hay modelo conectado.");
try {
  const em = getEmailEnv();
  if (em.EMAIL_PROVIDER === "dev" && (process.env.APP_ENV === "staging")) console.warn("[worker] ⚠ CORREO EN MODO «dev» en un servidor: nadie recibirá verificaciones, recuperaciones de contraseña ni invitaciones. Configura EMAIL_PROVIDER=resend.");
} catch (err) {
  console.error("[worker] ⚠ Configuración de correo inválida:", err instanceof Error ? err.message : err);
}
console.log(`[worker] listo: escuchando la cola "${QUEUE_NAME}" (concurrencia ${CONCURRENCY})`);

// Correos: envía los pendientes cada 5 s (con reintentos) y cada 10 min prepara avisos de plan/prueba y borra cuerpos viejos.
let mailing = false;
async function mailJob() {
  if (mailing || closing) return;
  mailing = true;
  try {
    const n = await sendDueEmails(20);
    if (n.sent + n.failed + n.retry > 0) console.log(`[worker] correos: ${n.sent} enviado(s), ${n.retry} a reintentar, ${n.failed} fallido(s)`);
  } catch (err) {
    console.error("[worker] correos falló:", err instanceof Error ? err.message : err);
  } finally {
    mailing = false;
  }
}
const mailTimer = setInterval(() => void mailJob(), 5_000);
let noticing = false;
async function noticeJob() {
  if (noticing || closing) return;
  noticing = true;
  try {
    const q = await queuePlanNotices();
    if (q > 0) console.log(`[worker] ${q} aviso(s) por correo en cola`);
    await getPool().query("SELECT email_purge()");
  } catch (err) {
    console.error("[worker] avisos por correo fallaron:", err instanceof Error ? err.message : err);
  } finally {
    noticing = false;
  }
}
const noticeTimer = setInterval(() => void noticeJob(), 600_000);
setTimeout(() => void noticeJob(), 20_000);
