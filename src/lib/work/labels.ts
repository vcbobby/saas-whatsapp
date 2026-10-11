// Textos y valores compartidos entre el servidor y las pantallas (sin dependencias).

export const WORK_TYPES = ["atencion_humana", "cita", "pedido", "pago_por_verificar", "seguimiento", "tarea"] as const;
export type WorkType = (typeof WORK_TYPES)[number];
/** Tipos que una persona puede crear a mano (la "atención personal" la crea el sistema). */
export const MANUAL_WORK_TYPES = ["tarea", "seguimiento", "cita", "pedido", "pago_por_verificar"] as const;

export const WORK_TYPE_LABEL: Record<WorkType, string> = {
  atencion_humana: "Atención personal",
  cita: "Cita",
  pedido: "Pedido",
  pago_por_verificar: "Pago por verificar",
  seguimiento: "Seguimiento",
  tarea: "Tarea",
};

export const WORK_STATUS_LABEL: Record<string, string> = {
  abierto: "Pendiente",
  en_proceso: "En proceso",
  resuelto: "Resuelta",
  descartado: "Descartada",
};

export const PRIORITY_LABEL: Record<number, string> = { 1: "Alta", 2: "Normal", 3: "Baja" };

export const CONTACT_LABELS = ["sin_clasificar", "cliente", "prospecto", "personal"] as const;
export type ContactLabel = (typeof CONTACT_LABELS)[number];
export const CONTACT_LABEL_TEXT: Record<ContactLabel, string> = {
  sin_clasificar: "Sin clasificar",
  cliente: "Cliente",
  prospecto: "Prospecto",
  personal: "Personal (el asistente no responde)",
};

/** Nombre de cada tipo de mensaje que no es texto. */
export const MEDIA_LABEL: Record<string, string> = {
  image: "Imagen", audio: "Audio", video: "Video", document: "Documento", sticker: "Sticker",
  location: "Ubicación", contacts: "Contacto", reaction: "Reacción", button: "Botón", interactive: "Respuesta",
};

export const CONVERSATION_STATUS_LABEL: Record<string, string> = {
  bot: "Con el asistente",
  human: "Con una persona",
  closed: "Cerrada",
};
