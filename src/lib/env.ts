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
export const DEFAULT_AI_GLOBAL_DAILY_TOKEN_LIMIT = 20_000_000;

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
    // Preguntas al copiloto del dueño por negocio y día (UTC). Acota el gasto de IA de esta función.
    COPILOT_DAILY_LIMIT: z.coerce.number().int().min(1).max(10_000).default(40),
    AGENT_HISTORY_MESSAGES: z.coerce.number().int().min(1).max(40).default(12),
    // Protección de costos (paso 21). Todos son topes de seguridad; el presupuesto en dólares se configura en Administración → Costos.
    // Tokens (entrada + salida) por negocio: asistente por día y por mes UTC, copiloto por día.
    AGENT_TENANT_DAILY_TOKEN_LIMIT: z.coerce.number().int().min(1_000).max(1_000_000_000_000).default(1_500_000),
    AGENT_TENANT_MONTHLY_TOKEN_LIMIT: z.coerce.number().int().min(1_000).max(1_000_000_000_000).default(20_000_000),
    COPILOT_TENANT_DAILY_TOKEN_LIMIT: z.coerce.number().int().min(1_000).max(1_000_000_000_000).default(300_000),
    // Corte global por día (todos los negocios juntos) si en Administración no se fijó otro. Siempre activo.
    AI_GLOBAL_DAILY_TOKEN_LIMIT: z.coerce.number().int().min(1_000).max(1_000_000_000_000).default(DEFAULT_AI_GLOBAL_DAILY_TOKEN_LIMIT),
    // Máximo de llamadas a la IA por un mismo mensaje (los reintentos de la cola no pueden gastar sin fin).
    AGENT_MESSAGE_CALL_LIMIT: z.coerce.number().int().min(1).max(5).default(2),
    // Bucles: mensajes entrantes de una misma conversación en 10 minutos (un bot contestándole a otro bot, por ejemplo).
    AGENT_LOOP_INBOUND_LIMIT: z.coerce.number().int().min(3).max(1_000).default(30),
    // Pico: respuestas del asistente por negocio en la última hora.
    AGENT_TENANT_HOURLY_REPLY_LIMIT: z.coerce.number().int().min(1).max(100_000).default(150),
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

// ----------------------------------------------------- consentimiento legal
const legalSchema = z
  .object({
    // "required": para crear una cuenta hay que aceptar los términos (es lo normal). "optional" solo sirve para las pruebas automáticas.
    LEGAL_CONSENT: z.enum(["required", "optional"]).default("required"),
    APP_ENV: z.enum(["local", "test", "staging", "production"]),
  })
  .superRefine((v, ctx) => {
    if (v.LEGAL_CONSENT === "optional" && (v.APP_ENV === "staging" || v.APP_ENV === "production")) {
      ctx.addIssue({ code: "custom", path: ["LEGAL_CONSENT"], message: "El consentimiento opcional no se permite en staging ni producción" });
    }
  });

export function getConsentMode(): "required" | "optional" {
  const result = legalSchema.safeParse(process.env);
  if (!result.success) {
    const campos = result.error.issues.map((i) => `${i.path.join(".")} (${i.message})`).join(", ");
    throw new Error(`Variables de consentimiento inválidas: ${campos}`);
  }
  return result.data.LEGAL_CONSENT;
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

// ------------------------------------------------- embeddings de la base de conocimiento (Paso 9C)
const embeddingsSchema = z
  .object({
    // "local": modelo multilingüe que corre en tu propio servidor (gratis, sin enviar datos a nadie).
    // "fake": vectores de prueba por palabras (solo desarrollo; la búsqueda no entiende sinónimos).
    EMBEDDINGS_PROVIDER: z.enum(["fake", "local"]).default("fake"),
    // "1" permite descargar el modelo desde Hugging Face. Por defecto solo en tu computadora.
    EMBEDDINGS_ALLOW_DOWNLOAD: z.enum(["0", "1"]).optional(),
    KB_MODEL_DIR: z.string().trim().min(1).max(300).optional(),
    APP_ENV: z.enum(["local", "test", "staging", "production"]),
  })
  .superRefine((v, ctx) => {
    if (v.EMBEDDINGS_PROVIDER === "fake" && (v.APP_ENV === "staging" || v.APP_ENV === "production")) {
      ctx.addIssue({ code: "custom", path: ["EMBEDDINGS_PROVIDER"], message: "Los vectores de prueba (fake) no se permiten en staging ni producción" });
    }
  });

export interface EmbeddingsEnv {
  EMBEDDINGS_PROVIDER: "fake" | "local";
  allowDownload: boolean;
  modelDir: string;
}

export function getEmbeddingsEnv(): EmbeddingsEnv {
  const result = embeddingsSchema.safeParse(process.env);
  if (!result.success) {
    const campos = result.error.issues.map((i) => `${i.path.join(".")} (${i.message})`).join(", ");
    throw new Error(`Variables de embeddings inválidas: ${campos}`);
  }
  const v = result.data;
  return {
    EMBEDDINGS_PROVIDER: v.EMBEDDINGS_PROVIDER,
    allowDownload: v.EMBEDDINGS_ALLOW_DOWNLOAD ? v.EMBEDDINGS_ALLOW_DOWNLOAD === "1" : v.APP_ENV === "local",
    modelDir: v.KB_MODEL_DIR ?? ".cache/models",
  };
}

// ------------------------------------------------------------ seguridad web (Paso 10)
const securitySchema = z
  .object({
    // Quién está delante de la aplicación (de él depende poder fiarse de la IP del visitante):
    // "none" (nadie), "cloudflare" (túnel/proxy de Cloudflare) o "proxy" (un nginx/Caddy tuyo).
    TRUSTED_PROXY: z.enum(["none", "cloudflare", "proxy"]).optional(),
    // "1" apaga los límites por IP. Solo para pruebas automáticas.
    RATE_LIMIT_DISABLED: z.enum(["0", "1"]).default("0"),
    APP_ENV: z.enum(["local", "test", "staging", "production"]),
  })
  .superRefine((v, ctx) => {
    const hosted = v.APP_ENV === "staging" || v.APP_ENV === "production";
    if (hosted && !v.TRUSTED_PROXY) {
      ctx.addIssue({ code: "custom", path: ["TRUSTED_PROXY"], message: "Debes definirlo en staging y producción: none, cloudflare o proxy" });
    }
    if (hosted && v.RATE_LIMIT_DISABLED === "1") {
      ctx.addIssue({ code: "custom", path: ["RATE_LIMIT_DISABLED"], message: "No se permite apagar los límites en staging ni producción" });
    }
  });

export interface SecurityEnv {
  trustedProxy: "none" | "cloudflare" | "proxy";
  rateLimitDisabled: boolean;
}

export function getSecurityEnv(): SecurityEnv {
  const result = securitySchema.safeParse(process.env);
  if (!result.success) {
    const campos = result.error.issues.map((i) => `${i.path.join(".")} (${i.message})`).join(", ");
    throw new Error(`Configuración de seguridad inválida: ${campos}`);
  }
  return { trustedProxy: result.data.TRUSTED_PROXY ?? "none", rateLimitDisabled: result.data.RATE_LIMIT_DISABLED === "1" };
}

// ------------------------------------------------------- tasa BCV automática (Paso 23)
export const RATE_SOURCE_NAMES = ["dolarapi", "bcv"] as const;
export type RateSourceName = (typeof RATE_SOURCE_NAMES)[number];

/** Fuentes de la tasa, en orden de prioridad (la siguiente se usa solo si la anterior falla). Ej.: RATE_SOURCES=dolarapi,bcv */
export function getRateSources(): RateSourceName[] {
  const raw = (process.env.RATE_SOURCES ?? "dolarapi,bcv").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  const bad = raw.filter((s) => !(RATE_SOURCE_NAMES as readonly string[]).includes(s));
  if (bad.length > 0 || raw.length === 0) throw new Error(`RATE_SOURCES inválido (${bad.join(", ") || "vacío"}). Opciones: ${RATE_SOURCE_NAMES.join(", ")}`);
  return [...new Set(raw)] as RateSourceName[];
}
