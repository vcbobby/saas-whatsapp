// Catálogo de eventos que un negocio puede mandar a otros sistemas (sin dependencias: lo usan servidor y pantallas).
// Debe coincidir con el CHECK de webhook_endpoints.events (migración 0019).
export const WEBHOOK_EVENTS = [
  "order.created",
  "order.status_changed",
  "appointment.created",
  "appointment.status_changed",
  "appointment.rescheduled",
  "conversation.handoff",
] as const;
export type WebhookEvent = (typeof WEBHOOK_EVENTS)[number];

export const WEBHOOK_EVENT_LABEL: Record<WebhookEvent, { title: string; hint: string }> = {
  "order.created": { title: "Pedido nuevo", hint: "Se crea un pedido (por una persona o por el asistente)." },
  "order.status_changed": { title: "Pedido cambia de estado", hint: "Se confirma, se entrega o se cancela." },
  "appointment.created": { title: "Cita nueva", hint: "Se crea una cita (por una persona o por el asistente)." },
  "appointment.status_changed": { title: "Cita cambia de estado", hint: "Se confirma, se cancela, se completa o no asiste." },
  "appointment.rescheduled": { title: "Cita reprogramada", hint: "Cambia la fecha u hora de una cita." },
  "conversation.handoff": { title: "Pasa a una persona", hint: "El asistente pasa una conversación a tu equipo." },
};

/** Evento de prueba: se manda desde el botón «Enviar prueba» y no depende de la suscripción. */
export const TEST_EVENT = "webhook.test";

export const MAX_ENDPOINTS = 10;
