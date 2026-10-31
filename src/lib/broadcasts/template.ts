import { z } from "zod";
import { variablesOf } from "@/lib/whatsapp/templates";

export const paramSchema = z.union([
  z.object({ kind: z.literal("nombre") }).strict(),
  z.object({ kind: z.literal("texto"), value: z.string().trim().min(1, "Escribe el valor").max(100) }).strict(),
]);
export type Param = z.infer<typeof paramSchema>;

/** Meta exige que una promoción diga cómo darse de baja; aquí «BAJA» es la palabra que el sistema entiende. */
export const OPT_OUT_HINT = "Responde BAJA para no recibir más";
export const hasOptOut = (text: string) => /\b(baja|stop)\b/i.test(text);

/** ¿Sirve esta plantilla para una difusión con estos valores? Devuelve el motivo si no. */
export function templateProblem(t: { status: string; sendable: boolean; body: string } | undefined, params: unknown[]): string | null {
  if (!t) return "Elige una plantilla.";
  if (t.status !== "APPROVED") return "Esa plantilla todavía no está aprobada por Meta.";
  if (!t.sendable) return "Esa plantilla trae imágenes o botones con variables y la app todavía no puede enviarla.";
  if (!hasOptOut(t.body)) return `La plantilla debe decir cómo darse de baja, por ejemplo: «${OPT_OUT_HINT} promociones». Crea otra plantilla con esa frase.`;
  if (variablesOf(t.body).length !== params.length) return `La plantilla tiene ${variablesOf(t.body).length} variable(s) y configuraste ${params.length}.`;
  return null;
}
