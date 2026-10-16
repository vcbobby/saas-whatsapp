import { z } from "zod";
import { WEBHOOK_EVENTS, WEBHOOK_EVENT_LABEL } from "@/lib/webhooks/events";

// Sin dependencias de servidor: lo usan la API y la pantalla. Debe coincidir con los CHECK de automation_rules (migración 0020).
export const MAX_RULES = 20;
export const TRIGGERS = WEBHOOK_EVENTS;
export const TRIGGER_LABEL = WEBHOOK_EVENT_LABEL;

/** Estados válidos para filtrar «cambia de estado». */
export const STATUS_OPTIONS = {
  "order.status_changed": ["confirmado", "entregado", "cancelado"],
  "appointment.status_changed": ["confirmada", "cancelada", "completada", "no_asistio"],
} as const;
export const PLACEHOLDERS = ["{cliente}", "{numero}", "{servicio}", "{total}", "{estado}", "{fecha}"] as const;
export const ACTIONS = ["tarea", "mensaje"] as const;
/** Avisos con un cliente al que se le puede escribir (la conversación de «pasa a una persona» no). */
export const MESSAGE_TRIGGERS = ["order.created", "order.status_changed", "appointment.created", "appointment.status_changed", "appointment.rescheduled"] as const;

export const ruleFields = {
  name: z.string().trim().min(1, "Ponle un nombre a la regla").max(80, "Máximo 80 caracteres"),
  triggerEvent: z.enum(TRIGGERS),
  onlyStatus: z.string().trim().max(30).nullable().optional(),
  taskTitle: z.string().trim().min(1, "Escribe el título de la tarea").max(120, "Máximo 120 caracteres"),
  taskPriority: z.number().int().min(1).max(3).default(2),
  actionType: z.enum(ACTIONS).default("tarea"),
  messageTemplate: z.string().trim().max(600, "Máximo 600 caracteres").nullable().optional(),
  taskDueMinutes: z.number().int().min(1, "El plazo debe ser de al menos 1 minuto").max(43200, "El plazo máximo es 30 días").nullable().optional(),
};

/** Comprueba que el filtro de estado tenga sentido para el aviso elegido. */
export function statusOk(trigger: string, status: string | null | undefined): boolean {
  if (!status) return true;
  const list = (STATUS_OPTIONS as Record<string, readonly string[]>)[trigger];
  return !!list && list.includes(status);
}

/** Reglas que no se pueden expresar en el esquema: el aviso al cliente necesita texto y un aviso que tenga cliente. Devuelve el error o null. */
export function actionError(d: { actionType?: string; triggerEvent: string; messageTemplate?: string | null }): string | null {
  if (d.actionType !== "mensaje") return null;
  if (!d.messageTemplate || !d.messageTemplate.trim()) return "Escribe el mensaje para el cliente.";
  if (!(MESSAGE_TRIGGERS as readonly string[]).includes(d.triggerEvent)) return "Ese aviso no tiene un cliente al que escribirle. Elige pedido o cita.";
  return null;
}
