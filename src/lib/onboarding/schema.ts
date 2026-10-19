import { z } from "zod";
import { BUSINESS_TYPES, COUNTRY_CODES, EMOJI_LEVELS, TONES, type BusinessType, type CountryCode } from "@/lib/agent/style";
import { MAX_MINOR, type Currency } from "@/lib/catalog/money";
import { parseHm } from "@/lib/agenda/tz";
import type { PlanModule } from "@/lib/plans/usage";

/** Zona horaria y moneda que se proponen según el país (se pueden cambiar después en Agenda y Catálogo). */
export const COUNTRY_DEFAULTS: Record<CountryCode, { timezone: string; currency: Currency }> = {
  VE: { timezone: "America/Caracas", currency: "USD" },
  CO: { timezone: "America/Bogota", currency: "COP" },
  MX: { timezone: "America/Mexico_City", currency: "MXN" },
  AR: { timezone: "America/Argentina/Buenos_Aires", currency: "USD" },
  CL: { timezone: "America/Santiago", currency: "USD" },
  PE: { timezone: "America/Lima", currency: "PEN" },
  EC: { timezone: "America/Guayaquil", currency: "USD" },
  ES: { timezone: "Europe/Madrid", currency: "EUR" },
  US: { timezone: "America/New_York", currency: "USD" },
  XX: { timezone: "America/Caracas", currency: "USD" },
};

export const MAX_ITEMS = 8;
export const WEEKDAY_LABEL = ["Lun", "Mar", "Mié", "Jue", "Vie", "Sáb", "Dom"] as const; // 1 = lunes … 7 = domingo

const text = (max: number) => z.string().trim().max(max, `Máximo ${max} caracteres`);

export const onboardingSchema = z.object({
  businessType: z.enum(BUSINESS_TYPES),
  country: z.enum(COUNTRY_CODES),
  services: z.array(z.object({
    name: z.string().trim().min(1, "Escribe el nombre del servicio").max(80, "Máximo 80 caracteres"),
    durationMinutes: z.number().int().min(5, "Mínimo 5 minutos").max(480, "Máximo 8 horas"),
    priceText: text(40).optional(),
  })).max(MAX_ITEMS, `Máximo ${MAX_ITEMS} servicios aquí (luego puedes añadir más)`),
  products: z.array(z.object({
    name: z.string().trim().min(1, "Escribe el nombre del producto").max(120, "Máximo 120 caracteres"),
    priceMinor: z.number().int("Precio inválido").min(0, "El precio no puede ser negativo").max(MAX_MINOR, "Precio demasiado grande"),
  })).max(MAX_ITEMS, `Máximo ${MAX_ITEMS} productos aquí (luego puedes añadir más)`),
  /** Días abiertos (1 = lunes … 7 = domingo) y un solo tramo de horas. Solo para negocios con citas. */
  hours: z.object({ days: z.array(z.number().int().min(1).max(7)).max(7), start: z.string(), end: z.string() }).nullable(),
  info: z.object({
    offer: text(600).optional(),
    hours: text(300).optional(),
    address: text(300).optional(),
    payments: text(300).optional(),
    other: text(600).optional(),
  }),
  assistantName: z.string().trim().min(1, "Ponle un nombre al asistente").max(60, "Máximo 60 caracteres"),
  tone: z.enum(TONES),
  emojiLevel: z.enum(EMOJI_LEVELS),
  activate: z.boolean(),
});
export type OnboardingInput = z.infer<typeof onboardingSchema>;

/** Un negocio solo puede elegir «citas» o «catálogo» si su plan incluye ese módulo; si no, queda como «solo atención». */
export function effectiveType(type: BusinessType, modules: readonly PlanModule[]): BusinessType {
  if (type === "citas") return modules.includes("agenda") ? "citas" : "atencion";
  if (type === "catalogo") return modules.includes("catalogo") ? "catalogo" : "atencion";
  return "atencion";
}

/** Devuelve el tramo en minutos o un mensaje de error. */
export function parseHourRange(start: string, end: string): { start: number; end: number } | string {
  const a = parseHm(start);
  const b = parseHm(end, true);
  if (a === null || b === null) return "Usa horas válidas (por ejemplo 09:00 y 18:00).";
  if (a >= b) return "La hora de cierre debe ser después de la de apertura.";
  return { start: a, end: b };
}

const clean = (s: string | undefined) => (s ?? "").replace(/[\u0000-\u0008\u000B-\u001F\u007F<>]|\[\[|\]\]/g, " ").replace(/[ \t]+/g, " ").trim();

/**
 * Texto de «información del negocio» que lee el asistente (misma forma que las plantillas de Mi asistente).
 * No lista servicios ni productos: esos salen de sus propias tablas, así los precios nunca quedan desactualizados.
 */
export function buildInstructions(businessName: string, info: OnboardingInput["info"]): string {
  const name = clean(businessName);
  const offer = clean(info.offer);
  const L = [`Sobre el negocio: ${name}.${offer ? " " + offer : ""}`];
  const add = (label: string, v: string | undefined) => { const c = clean(v); if (c) L.push(`${label}: ${c}`); };
  add("Dirección", info.address);
  add("Horario de atención", info.hours);
  add("Formas de pago", info.payments);
  add("Otros datos", info.other);
  return L.join("\n");
}
