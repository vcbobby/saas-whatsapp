import { z } from "zod";
import { BUSINESS_TYPES, COUNTRY_CODES, EMOJI_LEVELS, REPLY_LENGTHS, TONES } from "@/lib/agent/style";

export const emailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .pipe(z.email().max(254));

export const passwordSchema = z
  .string()
  .min(10, "La contraseña debe tener al menos 10 caracteres")
  .max(128, "La contraseña es demasiado larga")
  .refine((p) => new Set(p).size > 3, "La contraseña es demasiado repetitiva");

export const signupSchema = z
  .object({
    email: emailSchema,
    password: passwordSchema,
    businessName: z.string().trim().min(2).max(120),
    // «Acepto los términos y la política de privacidad». El servidor decide si es obligatorio (LEGAL_CONSENT).
    acceptTerms: z.literal(true).optional(),
  })
  .refine(
    (d) => {
      const local = d.email.split("@")[0] ?? "";
      return local.length < 4 || !d.password.toLowerCase().includes(local);
    },
    { path: ["password"], message: "La contraseña no puede contener tu correo" },
  );

export const loginSchema = z.object({
  email: emailSchema,
  password: z.string().min(1).max(128),
});

export const impersonationSchema = z.object({
  tenantId: z.uuid(),
  reason: z.string().trim().min(10).max(500),
});

export const tenantStatusSchema = z.object({
  tenantId: z.uuid(),
  status: z.enum(["trial", "active", "past_due", "suspended"]),
});

export const tenantPlanSchema = z.object({ tenantId: z.uuid(), planId: z.uuid() });

export const planUpdateSchema = z.object({
  planId: z.uuid(),
  name: z.string().trim().min(1, "Ponle un nombre").max(60),
  maxRepliesMonth: z.number().int().min(0).max(10_000_000).nullable(),
  maxMembers: z.number().int().min(1).max(1000),
  modules: z.array(z.enum(["agenda", "catalogo", "copiloto", "automatizaciones"])).max(4),
  active: z.boolean(),
});

// "Panadería La Esquina" -> "panaderia-la-esquina-a1b2c3"
export function makeSlug(name: string, randomSuffix: string): string {
  const base = name
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "");
  return `${base || "negocio"}-${randomSuffix}`;
}

// ---------------------------------------------------------------- 2FA y equipo
export const totpCodeSchema = z.string().trim().regex(/^\d{3}\s?\d{3}$/, "El código tiene 6 dígitos");

export const mfaVerifySchema = z.union([
  z.object({ code: totpCodeSchema }),
  z.object({ recoveryCode: z.string().trim().min(15).max(24) }),
]);

export const mfaConfirmSchema = z.object({ code: totpCodeSchema });

export const mfaSensitiveSchema = z.object({
  password: z.string().min(1).max(128),
  code: totpCodeSchema,
});

export const inviteSchema = z.object({
  email: emailSchema,
  role: z.enum(["admin", "agent"]),
});

export const invitationIdSchema = z.object({ invitationId: z.uuid() });

export const roleChangeSchema = z.object({
  userId: z.uuid(),
  role: z.enum(["admin", "agent"]),
});

export const removeMemberSchema = z.object({ userId: z.uuid() });

export const inviteTokenSchema = z.object({ token: z.string().regex(/^[A-Za-z0-9_-]{43}$/) });

export const inviteSignupSchema = z.object({
  token: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  password: passwordSchema,
  acceptTerms: z.literal(true).optional(),
});

// ---------------------------------------------------------------- WhatsApp
export const whatsappConnectSchema = z.object({
  phoneNumberId: z.string().trim().regex(/^\d{5,30}$/, "El ID del número son solo dígitos"),
  accessToken: z
    .string()
    .trim()
    .min(20, "El token es demasiado corto")
    .max(1000)
    .regex(/^\S+$/, "El token no debe llevar espacios"),
});

// ------------------------------------------------------------------ agente
export const agentSettingsSchema = z.object({
  enabled: z.boolean(),
  assistantName: z.string().trim().min(1, "Ponle un nombre al asistente").max(60, "Máximo 60 caracteres"),
  instructions: z.string().max(4000, "Máximo 4000 caracteres"),
  // Estilo (opcional: si no viene, se conserva el que ya tiene el negocio).
  businessType: z.enum(BUSINESS_TYPES).optional(),
  country: z.enum(COUNTRY_CODES).optional(),
  tone: z.enum(TONES).optional(),
  emojiLevel: z.enum(EMOJI_LEVELS).optional(),
  replyLength: z.enum(REPLY_LENGTHS).optional(),
});

// ---- Cobros (Paso 18C)
export const payCreateSchema = z.object({
  planId: z.uuid(),
  months: z.number().int().min(1).max(12),
  method: z.enum(["pago_movil", "paypal", "binance"]),
});
export const paySubmitSchema = z.object({
  paymentId: z.uuid(),
  reference: z.string().trim().min(4, "La referencia es muy corta").max(60),
  bank: z.string().trim().max(60).default(""),
  phone: z.string().trim().max(30).default(""),
  paidOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Fecha inválida"),
  declared: z.string().trim().min(1, "Escribe el monto que pagaste").max(30),
  proof: z.string().min(100, "Falta la imagen del comprobante").max(3_000_000),
});
export const planPriceSchema = z.object({ planId: z.uuid(), priceCents: z.number().int().min(1).max(100_000_000).nullable() });
export const billingSettingsSchema = z.object({
  rate: z.number().positive().max(100_000_000).nullable(),
  pmBank: z.string().trim().max(60), pmPhone: z.string().trim().max(30), pmHolderId: z.string().trim().max(30), pmHolderName: z.string().trim().max(80),
  paypal: z.string().trim().max(120), binance: z.string().trim().max(80), notes: z.string().trim().max(500),
});
export const paymentDecideSchema = z.object({ paymentId: z.uuid(), approve: z.boolean(), reason: z.string().trim().max(300).optional() });
