import { LlmError, type LlmProvider } from "./provider";

export interface AiCheckResult {
  ok: boolean;
  /** Mensaje listo para mostrar a la persona (en español, sin secretos). */
  message: string;
  text?: string;
  inputTokens?: number;
  outputTokens?: number;
  model?: string;
  ms?: number;
}

/** Explica un fallo del proveedor en palabras sencillas (qué pasó y qué revisar). Nunca incluye la clave. */
export function explainAiError(e: unknown): string {
  if (e instanceof LlmError) {
    if (e.status === 400) return "El proveedor rechazó la petición (400). Suele ser un nombre de modelo (LLM_MODEL) que no existe o que tu clave no puede usar.";
    if (e.status === 401 || e.status === 403) return `El proveedor no aceptó la clave (${e.status}). Revisa LLM_API_KEY: que esté completa, sin espacios ni comillas, y que sea de este proveedor.`;
    if (e.status === 404) return "El proveedor no encontró ese modelo (404). Revisa el nombre en LLM_MODEL.";
    if (e.status === 429) return "Llegaste al límite de uso del plan gratuito (429). Espera un minuto e inténtalo de nuevo; si se repite, se agotó la cuota del día.";
    if (e.status !== undefined && e.status >= 500) return `El proveedor tiene un problema temporal (${e.status}). Inténtalo en unos minutos.`;
    return e.message;
  }
  return e instanceof Error ? e.message : "Error desconocido";
}

/** Hace UNA pregunta corta al modelo y verifica que responde en español. Sirve para comprobar clave, modelo y conexión. */
export async function runAiCheck(provider: LlmProvider): Promise<AiCheckResult> {
  const t0 = Date.now();
  try {
    const out = await provider.generate({
      system: "Eres un asistente de pruebas. Responde siempre en español, en una sola frase corta.",
      messages: [{ role: "user", content: "Di «Conexión correcta» y el nombre de un color." }],
      maxTokens: 60,
      temperature: 0,
    });
    const ms = Date.now() - t0;
    if (!out.text.trim()) return { ok: false, message: "El modelo respondió, pero sin texto. Prueba con otro modelo (LLM_MODEL).", ms };
    return { ok: true, message: "La IA responde correctamente.", text: out.text.trim(), inputTokens: out.inputTokens, outputTokens: out.outputTokens, model: out.model, ms };
  } catch (e) {
    return { ok: false, message: explainAiError(e), ms: Date.now() - t0 };
  }
}
