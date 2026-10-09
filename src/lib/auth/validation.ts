import { z } from "zod";

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
