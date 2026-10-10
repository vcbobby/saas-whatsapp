import { z } from "zod";

const schema = z.object({
  APP_ENV: z.enum(["local", "test", "staging", "production"]),
  APP_URL: z.string().min(1),
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().min(1),
  DB_POOL_MAX: z.coerce.number().int().min(1).max(50).default(10),
  DB_SSL: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),
  ENCRYPTION_KEY_1: z.string().min(40),
  ENCRYPTION_CURRENT_VERSION: z.coerce.number().int().min(1).default(1),
});

type Env = z.infer<typeof schema>;

let cache: Env | undefined;

// Usar solo en código de servidor. Nunca importar desde componentes de cliente.
export function getEnv(): Env {
  if (!cache) {
    const result = schema.safeParse(process.env);
    if (!result.success) {
      const campos = result.error.issues.map((i) => i.path.join(".")).join(", ");
      throw new Error(`Variables de entorno inválidas o faltantes: ${campos}`);
    }
    cache = result.data;
  }
  return cache;
}

// ---------------------------------------------------------------- WhatsApp
// Aparte de getEnv() para que solo las rutas de WhatsApp exijan estas variables.
const whatsappSchema = z.object({
  // "App secret" de la app de Meta (Configuración > Básica). Firma cada webhook.
  WHATSAPP_APP_SECRET: z.string().min(16),
  // Texto que tú inventas y pegas en Meta al registrar el webhook.
  WHATSAPP_VERIFY_TOKEN: z.string().min(24),
  WHATSAPP_GRAPH_VERSION: z
    .string()
    .regex(/^v\d{2}\.\d$/)
    .default("v25.0"),
});

export function getWhatsAppEnv() {
  const result = whatsappSchema.safeParse(process.env);
  if (!result.success) {
    const campos = result.error.issues.map((i) => i.path.join(".")).join(", ");
    throw new Error(`Variables de WhatsApp inválidas o faltantes: ${campos}`);
  }
  return result.data;
}

// ---------------------------------------------------------------------- IA
// Aparte para que solo el worker y la página del agente exijan estas variables.
const llmSchema = z
  .object({
    // "mock" no llama a ningún servicio: responde un texto fijo (solo para desarrollo).
    LLM_PROVIDER: z.enum(["mock", "gemini", "anthropic", "openai"]).default("mock"),
    LLM_MODEL: z.string().trim().max(100).optional(),
    LLM_API_KEY: z.string().trim().min(10).max(500).optional(),
    // Solo para "openai" (OpenRouter, Groq, etc.): URL base de la API compatible.
    LLM_BASE_URL: z.string().trim().max(200).optional(),
    AGENT_DAILY_REPLY_LIMIT: z.coerce.number().int().min(1).max(100_000).default(300),
    // Tope de respuestas del asistente a UN mismo cliente (contacto): evita que una persona gaste tu IA.
    AGENT_CONTACT_HOURLY_LIMIT: z.coerce.number().int().min(1).max(10_000).default(20),
    AGENT_CONTACT_DAILY_LIMIT: z.coerce.number().int().min(1).max(100_000).default(60),
    AGENT_HISTORY_MESSAGES: z.coerce.number().int().min(1).max(40).default(12),
    APP_ENV: z.enum(["local", "test", "staging", "production"]),
  })
  .superRefine((v, ctx) => {
    if (v.LLM_PROVIDER === "mock") {
      if (v.APP_ENV === "production" || v.APP_ENV === "staging") {
        ctx.addIssue({ code: "custom", path: ["LLM_PROVIDER"], message: "El modo de prueba (mock) no se permite en staging ni producción" });
      }
      return;
    }
    if (!v.LLM_MODEL) ctx.addIssue({ code: "custom", path: ["LLM_MODEL"], message: "Falta LLM_MODEL" });
    if (!v.LLM_API_KEY) ctx.addIssue({ code: "custom", path: ["LLM_API_KEY"], message: "Falta LLM_API_KEY" });
    if (v.LLM_PROVIDER === "openai") {
      let ok = false;
      try {
        const u = new URL(v.LLM_BASE_URL ?? "");
        ok = u.protocol === "https:" && !u.username && !u.password && !u.search && !u.hash;
      } catch {}
      if (!ok) ctx.addIssue({ code: "custom", path: ["LLM_BASE_URL"], message: "LLM_BASE_URL debe ser una URL https sin credenciales" });
    }
  });

export type LlmEnv = z.infer<typeof llmSchema>;

export function getLlmEnv(): LlmEnv {
  const result = llmSchema.safeParse(process.env);
  if (!result.success) {
    const campos = result.error.issues.map((i) => `${i.path.join(".")} (${i.message})`).join(", ");
    throw new Error(`Variables de IA inválidas o faltantes: ${campos}`);
  }
  return result.data;
}

// ----------------------------------------------------- modo de envío (simulador)
const sendModeSchema = z
  .object({
    // "meta": se envía de verdad por WhatsApp. "simulate": NO se envía nada; sirve para probar en tu computadora.
    WHATSAPP_SEND_MODE: z.enum(["meta", "simulate"]).default("meta"),
    APP_ENV: z.enum(["local", "test", "staging", "production"]),
  })
  .superRefine((v, ctx) => {
    if (v.WHATSAPP_SEND_MODE === "simulate" && (v.APP_ENV === "staging" || v.APP_ENV === "production")) {
      ctx.addIssue({ code: "custom", path: ["WHATSAPP_SEND_MODE"], message: "El modo simulate no se permite en staging ni producción" });
    }
  });

/** Aparte de getWhatsAppEnv(): para simular no hacen falta los secretos de Meta. */
export function getSendMode(): "meta" | "simulate" {
  const result = sendModeSchema.safeParse(process.env);
  if (!result.success) {
    const campos = result.error.issues.map((i) => `${i.path.join(".")} (${i.message})`).join(", ");
    throw new Error(`Modo de envío inválido: ${campos}`);
  }
  return result.data.WHATSAPP_SEND_MODE;
}

/** Herramientas de desarrollo (simulador). Solo en computadoras de desarrollo, nunca en servidores. */
export function devToolsEnabled(): boolean {
  const env = process.env.APP_ENV;
  return env === "local" || env === "test";
}
