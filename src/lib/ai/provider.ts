import dns from "node:dns";
import https from "node:https";

// En WSL2 (y algunas redes) IPv6 se cuelga hasta agotar el tiempo: se prefiere IPv4.
try {
  dns.setDefaultResultOrder("ipv4first");
} catch {
  // Node antiguo: no pasa nada.
}

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

/**
 * `fetch` que SIEMPRE conecta por IPv4 (solo https, solo POST con texto). Es el valor por defecto de los adaptadores;
 * las pruebas inyectan su propio `fetch` y nunca llegan aquí. No sigue redirecciones y corta respuestas gigantes.
 */
export const ipv4Fetch: typeof fetch = (input, init) =>
  new Promise<Response>((resolve, reject) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url);
    if (url.protocol !== "https:") return reject(new TypeError("Solo https"));
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => { headers[k] = v; });
    const body = typeof init?.body === "string" ? init.body : "";
    headers["content-length"] = String(Buffer.byteLength(body));
    const signal = init?.signal ?? undefined;
    if (signal?.aborted) return reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
    const req = https.request(
      { hostname: url.hostname, port: url.port || 443, path: url.pathname + url.search, method: init?.method ?? "POST", family: 4, headers },
      (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on("data", (c: Buffer) => {
          size += c.length;
          if (size > MAX_RESPONSE_BYTES + 1) { req.destroy(); return reject(new LlmError("Respuesta del proveedor demasiado grande", false, res.statusCode)); }
          chunks.push(c);
        });
        res.on("end", () => resolve(new Response(Buffer.concat(chunks), { status: res.statusCode || 500 })));
        res.on("error", reject);
      },
    );
    req.on("error", reject);
    signal?.addEventListener("abort", () => { req.destroy(); reject(signal.reason ?? new DOMException("Aborted", "AbortError")); }, { once: true });
    req.write(body);
    req.end();
  });

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
    if (err instanceof LlmError) throw err;
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
