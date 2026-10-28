import { z } from "zod";
import { WEBHOOK_EVENTS, WEBHOOK_EVENT_LABEL } from "@/lib/webhooks/events";

// Sin dependencias de servidor: lo usan la API y la pantalla. Debe coincidir con los CHECK de automation_rules (migración 0020).
export const MAX_RULES = 20;
/** Avisos por TIEMPO: no nacen de un cambio sino de que pase un plazo (necesitan «offsetMinutes»). */
export const TIME_TRIGGERS = ["appointment.upcoming", "order.pending_stale"] as const;
export const TRIGGERS = [...WEBHOOK_EVENTS, ...TIME_TRIGGERS] as const;
export const TRIGGER_LABEL: Record<(typeof TRIGGERS)[number], { title: string; hint: string }> = {
  ...WEBHOOK_EVENT_LABEL,
  "appointment.upcoming": { title: "Falta un tiempo para una cita", hint: "Recordatorio: se activa cuando falta el tiempo que elijas para una cita pendiente o confirmada." },
  "order.pending_stale": { title: "Un pedido lleva sin confirmar un tiempo", hint: "Se activa cuando un pedido sigue pendiente pasado el tiempo que elijas." },
};
export const OFFSET_LABEL: Record<(typeof TIME_TRIGGERS)[number], string> = {
  "appointment.upcoming": "Minutos antes de la cita (ej.: 1440 = 24 h antes)",
  "order.pending_stale": "Minutos sin confirmar (ej.: 120 = 2 h)",
};

/** Estados válidos para filtrar «cambia de estado». */
export const STATUS_OPTIONS = {
  "order.status_changed": ["confirmado", "entregado", "cancelado"],
  "appointment.status_changed": ["confirmada", "cancelada", "completada", "no_asistio"],
} as const;
export const PLACEHOLDERS = ["{cliente}", "{numero}", "{servicio}", "{total}", "{estado}", "{fecha}", "{producto}", "{stock}"] as const;
export const ACTIONS = ["tarea", "mensaje", "app"] as const;
/** Avisos con un cliente al que se le puede escribir (la conversación de «pasa a una persona» no). */
export const MESSAGE_TRIGGERS = ["order.created", "order.status_changed", "appointment.created", "appointment.status_changed", "appointment.rescheduled", "appointment.upcoming", "order.pending_stale"] as const;

export const ruleFields = {
  name: z.string().trim().min(1, "Ponle un nombre a la regla").max(80, "Máximo 80 caracteres"),
  triggerEvent: z.enum(TRIGGERS),
  onlyStatus: z.string().trim().max(30).nullable().optional(),
  taskTitle: z.string().trim().max(120, "Máximo 120 caracteres").default(""),
  targetEndpointId: z.uuid().nullable().optional(),
  taskPriority: z.number().int().min(1).max(3).default(2),
  offsetMinutes: z.number().int().min(1, "Mínimo 1 minuto").max(43200, "Máximo 30 días").nullable().optional(),
  actionType: z.enum(ACTIONS).default("tarea"),
  messageTemplate: z.string().trim().max(600, "Máximo 600 caracteres").nullable().optional(),
  templateId: z.uuid().nullable().optional(),
  templateParams: z.array(z.string().trim().max(100)).max(10).default([]),
  taskDueMinutes: z.number().int().min(1, "El plazo debe ser de al menos 1 minuto").max(43200, "El plazo máximo es 30 días").nullable().optional(),
};

/** Comprueba que el filtro de estado tenga sentido para el aviso elegido. */
export function statusOk(trigger: string, status: string | null | undefined): boolean {
  if (!status) return true;
  const list = (STATUS_OPTIONS as Record<string, readonly string[]>)[trigger];
  return !!list && list.includes(status);
}

/** Reglas que no se pueden expresar en el esquema: el aviso al cliente necesita texto y un aviso que tenga cliente. Devuelve el error o null. */
export function isTimeTrigger(t: string): boolean {
  return (TIME_TRIGGERS as readonly string[]).includes(t);
}
/** Los avisos por tiempo necesitan «cuánto tiempo»; los demás no lo usan (se ignora). */
export function offsetFor(d: { triggerEvent: string; offsetMinutes?: number | null }): number | null {
  return isTimeTrigger(d.triggerEvent) ? (d.offsetMinutes ?? null) : null;
}
export function actionError(d: { actionType?: string; triggerEvent: string; messageTemplate?: string | null; offsetMinutes?: number | null; taskTitle?: string; targetEndpointId?: string | null }): string | null {
  if (isTimeTrigger(d.triggerEvent) && !d.offsetMinutes) return "Indica cuántos minutos (por ejemplo 1440 para 24 horas).";
  if (d.actionType === "app") {
    if (!d.targetEndpointId) return "Elige a qué app conectada se enviará el aviso.";
    if (!d.messageTemplate || !d.messageTemplate.trim()) return "Escribe el mensaje que se enviará.";
    return null;
  }
  if (d.taskTitle !== undefined && !d.taskTitle.trim()) return "Escribe el título de la tarea.";
  if (d.actionType !== "mensaje") return null;
  if (!d.messageTemplate || !d.messageTemplate.trim()) return "Escribe el mensaje para el cliente.";
  if (!(MESSAGE_TRIGGERS as readonly string[]).includes(d.triggerEvent)) return "Ese aviso no tiene un cliente al que escribirle. Elige pedido o cita.";
  return null;
}

/** Comprueba la plantilla de respaldo de una regla de «mensaje»: aprobada, enviable y con un dato (no vacío) por cada variable. Devuelve el error o null. */
export function templateRuleError(tpl: { status: string; sendable: boolean; body: string } | undefined, params: string[]): string | null {
  if (!tpl) return "Esa plantilla ya no existe. Elige otra.";
  if (tpl.status !== "APPROVED") return "Esa plantilla todavía no está aprobada por Meta.";
  if (!tpl.sendable) return "Esa plantilla tiene encabezado, imágenes o botones con variables; por ahora solo se envían plantillas de texto.";
  const n = new Set([...tpl.body.matchAll(/\{\{\s*(\d{1,2})\s*\}\}/g)].map((m) => m[1])).size;
  if (params.length !== n) return n === 1 ? "Indica el dato de la plantilla." : `Indica los ${n} datos de la plantilla.`;
  if (params.some((x) => !x.trim())) return "Ningún dato de la plantilla puede quedar vacío.";
  return null;
}
