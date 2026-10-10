import { z } from "zod";
import { LlmError, normalizeTurns, postJsonLimited, statusError, type GenerateInput, type GenerateOutput, type LlmProvider } from "./provider";

type FetchImpl = typeof fetch;

// ------------------------------------------------------------------- mock
/** Sin red y sin costo. Sirve para probar todo el flujo (WhatsApp → cola → respuesta). */
export function createMockProvider(): LlmProvider {
  return {
    name: "mock",
    async generate(input: GenerateInput): Promise<GenerateOutput> {
      const last = [...input.messages].reverse().find((m) => m.role === "user")?.content ?? "";
      const visto = last.replace(/<\/?cliente>/gi, "").trim().slice(0, 80);
      return {
        text: `[Modo de prueba] Hola, soy el asistente. Recibí tu mensaje: «${visto}». Aún no hay un modelo de IA conectado.`,
        inputTokens: 0,
        outputTokens: 0,
        model: "mock",
      };
    },
  };
}

// ----------------------------------------------------------------- gemini
const geminiSchema = z.looseObject({
  candidates: z.array(z.looseObject({ content: z.looseObject({ parts: z.array(z.looseObject({ text: z.string().optional() })).optional() }).optional() })).optional(),
  usageMetadata: z.looseObject({ promptTokenCount: z.number().optional(), candidatesTokenCount: z.number().optional() }).optional(),
});

export function createGeminiProvider(opts: { apiKey: string; model: string }, fetchImpl: FetchImpl = fetch): LlmProvider {
  if (!/^[A-Za-z0-9._-]{1,100}$/.test(opts.model)) throw new Error("Nombre de modelo inválido");
  return {
    name: "gemini",
    async generate(input) {
      const turns = normalizeTurns(input.messages);
      const { status, json } = await postJsonLimited(
        `https://generativelanguage.googleapis.com/v1beta/models/${opts.model}:generateContent`,
        { "x-goog-api-key": opts.apiKey }, // en cabecera, nunca en la URL (las URL acaban en registros)
        {
          systemInstruction: { parts: [{ text: input.system }] },
          contents: turns.map((t) => ({ role: t.role === "user" ? "user" : "model", parts: [{ text: t.content }] })),
          generationConfig: { maxOutputTokens: input.maxTokens, temperature: input.temperature ?? 0.4 },
        },
        fetchImpl,
        input.signal,
      );
      if (status < 200 || status >= 300) throw statusError("Gemini", status);
      const p = geminiSchema.safeParse(json);
      if (!p.success) throw new LlmError("Respuesta de Gemini con formato inesperado", false, status);
      const text = (p.data.candidates?.[0]?.content?.parts ?? []).map((x) => x.text ?? "").join("").trim();
      return { text, inputTokens: p.data.usageMetadata?.promptTokenCount ?? 0, outputTokens: p.data.usageMetadata?.candidatesTokenCount ?? 0, model: opts.model };
    },
  };
}

// -------------------------------------------------------------- anthropic
const anthropicSchema = z.looseObject({
  content: z.array(z.looseObject({ type: z.string(), text: z.string().optional() })).optional(),
  usage: z.looseObject({ input_tokens: z.number().optional(), output_tokens: z.number().optional() }).optional(),
});

export function createAnthropicProvider(opts: { apiKey: string; model: string }, fetchImpl: FetchImpl = fetch): LlmProvider {
  return {
    name: "anthropic",
    async generate(input) {
      const turns = normalizeTurns(input.messages);
      const { status, json } = await postJsonLimited(
        "https://api.anthropic.com/v1/messages",
        { "x-api-key": opts.apiKey, "anthropic-version": "2023-06-01" },
        { model: opts.model, max_tokens: input.maxTokens, temperature: input.temperature ?? 0.4, system: input.system, messages: turns },
        fetchImpl,
        input.signal,
      );
      if (status < 200 || status >= 300) throw statusError("Anthropic", status);
      const p = anthropicSchema.safeParse(json);
      if (!p.success) throw new LlmError("Respuesta de Anthropic con formato inesperado", false, status);
      const text = (p.data.content ?? []).filter((b) => b.type === "text").map((b) => b.text ?? "").join("").trim();
      return { text, inputTokens: p.data.usage?.input_tokens ?? 0, outputTokens: p.data.usage?.output_tokens ?? 0, model: opts.model };
    },
  };
}

// ------------------------------------------------------ openai-compatible
const openaiSchema = z.looseObject({
  choices: z.array(z.looseObject({ message: z.looseObject({ content: z.string().nullable().optional() }).optional() })).optional(),
  usage: z.looseObject({ prompt_tokens: z.number().optional(), completion_tokens: z.number().optional() }).optional(),
});

/** Sirve para OpenRouter, Groq, Mistral, DeepSeek y cualquier API con el formato "chat/completions". */
export function createOpenAiCompatibleProvider(opts: { apiKey: string; model: string; baseUrl: string }, fetchImpl: FetchImpl = fetch): LlmProvider {
  const base = opts.baseUrl.replace(/\/+$/, "");
  return {
    name: "openai",
    async generate(input) {
      const turns = normalizeTurns(input.messages);
      const { status, json } = await postJsonLimited(
        `${base}/chat/completions`,
        { authorization: `Bearer ${opts.apiKey}` },
        {
          model: opts.model,
          max_tokens: input.maxTokens,
          temperature: input.temperature ?? 0.4,
          messages: [{ role: "system", content: input.system }, ...turns],
        },
        fetchImpl,
        input.signal,
      );
      if (status < 200 || status >= 300) throw statusError("El proveedor", status);
      const p = openaiSchema.safeParse(json);
      if (!p.success) throw new LlmError("Respuesta del proveedor con formato inesperado", false, status);
      const text = (p.data.choices?.[0]?.message?.content ?? "").trim();
      return { text, inputTokens: p.data.usage?.prompt_tokens ?? 0, outputTokens: p.data.usage?.completion_tokens ?? 0, model: opts.model };
    },
  };
}
