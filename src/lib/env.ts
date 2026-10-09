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
