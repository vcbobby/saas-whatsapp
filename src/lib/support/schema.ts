import { z } from "zod";

/** Quita caracteres de control y de cambio de dirección del texto (la base de datos lo repite: defensa en profundidad). */
export function cleanSupportText(s: string): string {
  return s.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u202A-\u202E\u2066-\u2069]/g, "").trim();
}

const text = (min: number, max: number, minMsg: string, maxMsg: string) =>
  z.string().transform(cleanSupportText).pipe(z.string().min(min, minMsg).max(max, maxMsg));

export const SUBJECT_MAX = 120;
export const BODY_MAX = 4000;

const subject = z.string().transform((s) => cleanSupportText(s).replace(/\s+/g, " ")).pipe(z.string().min(3, "Escribe un asunto de al menos 3 caracteres").max(SUBJECT_MAX, `Máximo ${SUBJECT_MAX} caracteres`));
const body = text(1, BODY_MAX, "Escribe tu mensaje", `Máximo ${BODY_MAX} caracteres`);

export const createTicketSchema = z.object({ subject, body });
export const replySchema = z.object({ id: z.uuid(), body });
export const closeSchema = z.object({ id: z.uuid() });
export const idQuerySchema = z.uuid();
export const adminStatusSchema = z.object({ id: z.uuid(), status: z.enum(["open", "closed"]) });
export const adminListStatusSchema = z.enum(["open", "answered", "closed"]);

export type TicketStatus = "open" | "answered" | "closed";

/** Cómo ve el negocio el estado de su ticket. */
export const CUSTOMER_STATUS_LABEL: Record<TicketStatus, string> = {
  open: "Esperando respuesta de soporte",
  answered: "Soporte respondió",
  closed: "Cerrado",
};
/** Cómo ve el súper admin el estado. */
export const ADMIN_STATUS_LABEL: Record<TicketStatus, string> = {
  open: "Por responder",
  answered: "Respondido",
  closed: "Cerrado",
};

/** Errores de la base de datos que el usuario debe entender (el resto se trata como error interno). */
export function supportDbError(e: unknown): { status: number; code: string; message: string } | null {
  const code = (e as { code?: string })?.code;
  const msg = (e as { message?: string })?.message ?? "";
  if (code === "53400" && msg.includes("tickets abiertos")) return { status: 409, code: "demasiados_tickets", message: "Ya tienes 5 consultas abiertas. Cierra alguna o espera la respuesta antes de abrir otra." };
  if (code === "53400") return { status: 409, code: "conversacion_larga", message: "Esta conversación ya es muy larga. Abre una consulta nueva." };
  return null;
}
