import { UnrecoverableError } from "bullmq";
import { runAgent, type AgentDeps } from "@/lib/agent/run";
import { LlmError } from "@/lib/ai/provider";
import { markInboundFailed, type InboundHandler } from "@/lib/queue/process";

/**
 * Atiende cada mensaje con el agente. Se registran solo ids y el resultado, nunca el texto
 * del mensaje ni teléfonos. Un error permanente del proveedor de IA (clave inválida, petición
 * mal formada) no se reintenta: falla ya y la conversación pasa a una persona.
 */
export function createInboundHandler(deps: Partial<AgentDeps> = {}): InboundHandler {
  return async (job) => {
    try {
      const outcome = await runAgent(job, deps);
      console.log(`[agente] mensaje ${job.messageId} (negocio ${job.tenantId.slice(0, 8)}…) → ${outcome}`);
    } catch (err) {
      if (err instanceof LlmError && !err.retryable) throw new UnrecoverableError(err.message);
      throw err;
    }
  };
}

/** Cuando un trabajo falla: si ya no habrá más intentos, se deja de insistir y una persona lo ve. */
export async function onJobFailed(
  job: { id?: string; data: unknown; attemptsMade: number; opts: { attempts?: number } } | undefined,
  err: Error,
): Promise<void> {
  if (!job) return;
  const total = job.opts.attempts ?? 1;
  const ultimo = err instanceof UnrecoverableError || job.attemptsMade >= total;
  console.error(`[worker] trabajo ${job.id} falló (intento ${job.attemptsMade}/${total}): ${err.message}`);
  if (ultimo) {
    await markInboundFailed(job.data).catch((e) => console.error("[worker] no se pudo marcar como fallido:", e instanceof Error ? e.message : e));
  }
}
