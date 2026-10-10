export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

export interface GenerateInput {
  system: string;
  messages: ChatMessage[];
  maxTokens: number;
  temperature?: number;
  signal?: AbortSignal;
}

export interface GenerateOutput {
  text: string;
  inputTokens: number;
  outputTokens: number;
  model: string;
}

/** Cualquier proveedor de IA se esconde detrás de esto: cambiar de proveedor no toca el agente. */
export interface LlmProvider {
  readonly name: string;
  generate(input: GenerateInput): Promise<GenerateOutput>;
}

/** Error de un proveedor. `retryable` = vale la pena reintentar (límite de uso, caída, tiempo agotado). */
export class LlmError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
    readonly status?: number,
  ) {
    super(message);
    this.name = "LlmError";
  }
}

/**
 * Deja la conversación como alternancia estricta usuario/asistente que todos los
 * proveedores aceptan: junta turnos seguidos del mismo rol y empieza siempre por el usuario.
 */
export function normalizeTurns(messages: ChatMessage[]): ChatMessage[] {
  const out: ChatMessage[] = [];
  for (const m of messages) {
    const text = m.content.trim();
    if (!text) continue;
    const last = out[out.length - 1];
    if (last && last.role === m.role) last.content += "\n" + text;
    else out.push({ role: m.role, content: text });
  }
  while (out.length > 0 && out[0]!.role !== "user") out.shift();
  return out;
}

const MAX_RESPONSE_BYTES = 200_000;
const REQUEST_TIMEOUT_MS = 30_000;

/** POST JSON con tiempo límite, sin seguir redirecciones y con tope de tamaño de respuesta. */
export async function postJsonLimited(
  url: string,
  headers: Record<string, string>,
  body: unknown,
  fetchImpl: typeof fetch,
  signal?: AbortSignal,
): Promise<{ status: number; json: unknown }> {
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetchImpl(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
      redirect: "error",
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
  } catch (err) {
    const name = (err as { name?: string }).name;
    throw new LlmError(name === "TimeoutError" || name === "AbortError" ? "El proveedor de IA tardó demasiado" : "No se pudo contactar al proveedor de IA", true);
  }
  const text = await res.text();
  if (text.length > MAX_RESPONSE_BYTES) throw new LlmError("Respuesta del proveedor demasiado grande", false, res.status);
  let json: unknown = null;
  try {
    json = JSON.parse(text);
  } catch {
    // Se deja null: el adaptador decide si es un error.
  }
  return { status: res.status, json };
}

/** 429 y 5xx se reintentan; el resto de 4xx (clave inválida, petición mal formada) no. */
export function statusError(provider: string, status: number): LlmError {
  const retryable = status === 429 || status >= 500 || status === 408;
  return new LlmError(`${provider} respondió con error ${status}`, retryable, status);
}
