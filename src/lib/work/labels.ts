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

/** Por qué el asistente pasó una conversación a una persona. */
export const HANDOFF_REASON_TEXT: Record<string, string> = {
  pedido_de_persona: "El cliente pidió hablar con una persona.",
  limite_diario: "Se alcanzó el tope diario de respuestas.",
  limite_plan: "Se alcanzó el tope mensual de respuestas de tu plan.",
  envio_rechazado: "Meta rechazó el envío del mensaje.",
  envio_incierto: "No se sabe si el mensaje salió; una persona debe revisarlo.",
  limite_contacto: "Este cliente alcanzó el tope de respuestas por hora o por día.",
  intentos_de_manipulacion: "El cliente insistió en manipular al asistente; lo atiende una persona.",
  fuga_de_instrucciones: "El asistente iba a revelar sus instrucciones internas; se bloqueó la respuesta.",
  salida_bloqueada: "La respuesta traía un enlace o correo que el negocio no escribió; se bloqueó.",
  respuesta_vacia: "El asistente no generó una respuesta.",
  agente_fallo: "El asistente no pudo procesar el mensaje.",
  limite_tokens: "El negocio llegó a su tope de consumo de IA.",
  ia_pausada: "La IA está en pausa temporal en toda la plataforma.",
  posible_bucle: "Demasiados mensajes en pocos minutos (¿otro bot?); el asistente se detuvo.",
  reintentos_ia: "El asistente no logró responder tras varios intentos.",
  pico_de_uso: "El asistente respondió demasiado en la última hora; se detuvo por seguridad.",
};
