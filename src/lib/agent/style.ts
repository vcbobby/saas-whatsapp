/**
 * Tipo de negocio y estilo del asistente.
 * Todo son opciones CERRADAS: el texto que llega al prompt sale de este archivo, nunca de lo que escriba un usuario.
 * (Archivo sin dependencias del servidor: lo usan tanto la API como la pantalla.)
 */

export const BUSINESS_TYPES = ["citas", "catalogo", "atencion"] as const;
export type BusinessType = (typeof BUSINESS_TYPES)[number];

export const COUNTRY_CODES = ["VE", "CO", "MX", "AR", "CL", "PE", "EC", "ES", "US", "XX"] as const;
export type CountryCode = (typeof COUNTRY_CODES)[number];

export const TONES = ["cercano", "formal"] as const;
export type Tone = (typeof TONES)[number];

export const EMOJI_LEVELS = ["ninguno", "pocos", "varios"] as const;
export type EmojiLevel = (typeof EMOJI_LEVELS)[number];

export const REPLY_LENGTHS = ["corta", "media"] as const;
export type ReplyLength = (typeof REPLY_LENGTHS)[number];

export interface AgentStyle {
  businessType: BusinessType;
  country: CountryCode;
  tone: Tone;
  emojiLevel: EmojiLevel;
  replyLength: ReplyLength;
}

export const DEFAULT_STYLE: AgentStyle = { businessType: "atencion", country: "VE", tone: "cercano", emojiLevel: "pocos", replyLength: "corta" };

export type Treatment = "tu" | "usted" | "vos";

export const BUSINESS_TYPE_INFO: Record<BusinessType, { label: string; description: string; guidance: string }> = {
  citas: {
    label: "Con citas",
    description: "Consultorios, salones, talleres, estudios, servicios por cita.",
    guidance:
      "Este negocio trabaja con citas. Cuando el cliente quiera agendar, pregúntale qué servicio necesita y qué día y hora le conviene, usando solo los servicios y horarios de la información del negocio. Tú NO confirmas ni agendas citas: cuando tengas esos datos, dile que una persona confirmará la cita y pasa a una persona (regla 5).",
  },
  catalogo: {
    label: "Vende productos",
    description: "Tiendas, comida, emprendimientos con catálogo y pedidos.",
    guidance:
      "Este negocio vende productos. Ayuda al cliente a elegir con el catálogo escrito en la información del negocio. Tú NO confirmas pedidos, totales ni pagos, y no inventas disponibilidad: cuando el cliente quiera comprar, anota qué productos y cantidades pide y pasa a una persona (regla 5) para que lo confirme.",
  },
  atencion: {
    label: "Solo atención",
    description: "Resolver dudas e informar; sin citas ni pedidos.",
    guidance:
      "Este negocio usa WhatsApp para atender dudas e informar. Responde con la información escrita del negocio; si el cliente necesita una gestión que tú no puedes hacer, pasa a una persona (regla 5).",
  },
};

export const COUNTRY_INFO: Record<CountryCode, { label: string; treatment: Treatment; vocab: string }> = {
  VE: { label: "Venezuela", treatment: "tu", vocab: "usa «celular» y «carro»" },
  CO: { label: "Colombia", treatment: "tu", vocab: "usa «celular» y «carro»" },
  MX: { label: "México", treatment: "tu", vocab: "usa «celular» y «coche» o «carro»; no uses «vosotros»" },
  AR: { label: "Argentina", treatment: "vos", vocab: "usa el voseo rioplatense (vos tenés, querés) y «celu» y «auto»" },
  CL: { label: "Chile", treatment: "tu", vocab: "usa «celular» y «auto»" },
  PE: { label: "Perú", treatment: "tu", vocab: "usa «celular» y «auto» o «carro»" },
  EC: { label: "Ecuador", treatment: "tu", vocab: "usa «celular» y «carro»" },
  ES: { label: "España", treatment: "tu", vocab: "usa «móvil» y «coche»" },
  US: { label: "Estados Unidos (hispanohablantes)", treatment: "tu", vocab: "usa un español neutro que entienda cualquier hispanohablante" },
  XX: { label: "Otro país (español neutro)", treatment: "tu", vocab: "usa un español neutro, sin regionalismos" },
};

export const TONE_LABEL: Record<Tone, string> = { cercano: "Cercano (de tú o de vos)", formal: "Formal (de usted)" };
export const EMOJI_LABEL: Record<EmojiLevel, string> = { ninguno: "Ninguno", pocos: "Pocos", varios: "Varios" };
export const LENGTH_LABEL: Record<ReplyLength, string> = { corta: "Cortas (1–2 párrafos)", media: "Medias (hasta 3 párrafos)" };

/** Cómo trata el asistente al cliente: formal siempre de usted; cercano según el país. */
export function treatmentOf(s: AgentStyle): Treatment {
  return s.tone === "formal" ? "usted" : COUNTRY_INFO[s.country].treatment;
}

const TREATMENT_LINE: Record<Treatment, string> = {
  tu: "Trata al cliente de «tú», de forma cálida y natural.",
  usted: "Trata al cliente de «usted», con cortesía y calidez (sin sonar frío).",
  vos: "Trata al cliente de «vos» (voseo), de forma cálida y natural.",
};
const EMOJI_LINE: Record<EmojiLevel, string> = {
  ninguno: "No uses emojis.",
  pocos: "Usa como máximo un emoji por mensaje, y solo si encaja.",
  varios: "Puedes usar algunos emojis para sonar cercano, sin exagerar.",
};
const LENGTH_LINE: Record<ReplyLength, string> = {
  corta: "Responde en uno o dos párrafos cortos.",
  media: "Responde en un máximo de tres párrafos cortos.",
};

/** Líneas del prompt que describen el estilo. Solo salen de las tablas de arriba. */
export function styleLines(s: AgentStyle): string[] {
  const c = COUNTRY_INFO[s.country];
  return [
    BUSINESS_TYPE_INFO[s.businessType].guidance,
    `Habla con el español natural de ${c.label}: ${c.vocab}. Entiende los modismos del cliente, pero no uses regionalismos que otro cliente podría no entender.`,
    TREATMENT_LINE[treatmentOf(s)],
    EMOJI_LINE[s.emojiLevel],
    LENGTH_LINE[s.replyLength],
  ];
}

/** Convierte lo que viene de la base de datos en un estilo válido (valores raros → valores por defecto). */
export function styleFromRow(r: Record<string, unknown> | undefined): AgentStyle {
  const pick = <T extends string>(v: unknown, all: readonly T[], d: T): T => (typeof v === "string" && (all as readonly string[]).includes(v) ? (v as T) : d);
  return {
    businessType: pick(r?.business_type, BUSINESS_TYPES, DEFAULT_STYLE.businessType),
    country: pick(r?.country, COUNTRY_CODES, DEFAULT_STYLE.country),
    tone: pick(r?.tone, TONES, DEFAULT_STYLE.tone),
    emojiLevel: pick(r?.emoji_level, EMOJI_LEVELS, DEFAULT_STYLE.emojiLevel),
    replyLength: pick(r?.reply_length, REPLY_LENGTHS, DEFAULT_STYLE.replyLength),
  };
}

export interface FixedTexts { handoff: string; nonText: string; fallback: string; rateLimited: string }

const FIXED_BY_TREATMENT: Record<Treatment, FixedTexts> = {
  tu: {
    handoff: "Claro, te comunico con una persona de nuestro equipo. En cuanto pueda te responde por aquí.",
    nonText: "Por ahora solo puedo leer mensajes de texto. ¿Me cuentas por escrito en qué te puedo ayudar?",
    fallback: "Disculpa, no pude procesar tu mensaje. Una persona de nuestro equipo te escribirá pronto.",
    rateLimited: "Estás escribiendo muy seguido y por ahora no puedo seguir atendiéndote por aquí. Una persona de nuestro equipo te responderá en cuanto pueda.",
  },
  usted: {
    handoff: "Claro, le comunico con una persona de nuestro equipo. En cuanto pueda le responde por aquí.",
    nonText: "Por ahora solo puedo leer mensajes de texto. ¿Me cuenta por escrito en qué le puedo ayudar?",
    fallback: "Disculpe, no pude procesar su mensaje. Una persona de nuestro equipo le escribirá pronto.",
    rateLimited: "Está escribiendo muy seguido y por ahora no puedo continuar la atención por aquí. Una persona de nuestro equipo le responderá en cuanto pueda.",
  },
  vos: {
    handoff: "Claro, te comunico con una persona de nuestro equipo. En cuanto pueda te responde por acá.",
    nonText: "Por ahora solo puedo leer mensajes de texto. ¿Me contás por escrito en qué te puedo ayudar?",
    fallback: "Disculpá, no pude procesar tu mensaje. Una persona de nuestro equipo te va a escribir pronto.",
    rateLimited: "Estás escribiendo muy seguido y por ahora no puedo seguir atendiéndote por acá. Una persona de nuestro equipo te va a responder en cuanto pueda.",
  },
};

/** Mensajes fijos (sin IA) con el mismo trato que el resto de la conversación. */
export function fixedTexts(s: AgentStyle): FixedTexts {
  return FIXED_BY_TREATMENT[treatmentOf(s)];
}

/** Ejemplo corto de cómo sonará el asistente (para mostrar en la pantalla). */
export function sampleGreeting(s: AgentStyle, assistantName: string): string {
  const name = assistantName.trim() || "Asistente";
  const t = treatmentOf(s);
  const emoji = s.emojiLevel === "ninguno" ? "" : s.emojiLevel === "pocos" ? " 😊" : " 😊👋";
  const body = { tu: "¿En qué te puedo ayudar hoy?", usted: "¿En qué le puedo ayudar hoy?", vos: "¿En qué te puedo ayudar hoy?" }[t];
  const hi = t === "usted" ? "Buenas, le saluda" : "¡Hola! Soy";
  return `${hi} ${name}, el asistente virtual. ${body}${emoji}`;
}

/** Texto inicial para «Información de tu negocio», según el tipo. Los campos entre [corchetes] se completan. */
export const TEMPLATES: Record<BusinessType, string> = {
  citas: `Sobre el negocio: [qué hace tu negocio y en qué zona está]
Dirección: [dirección y puntos de referencia]
Horario de atención: [días y horas]

Servicios y precios:
- [Servicio 1]: [precio] · [duración]
- [Servicio 2]: [precio] · [duración]

Cómo se agenda una cita: [qué datos necesitas: nombre, servicio, día y hora]
Formas de pago: [efectivo, Pago Móvil, transferencia, etc.]
Políticas (cancelaciones y retrasos): [tu política]

Preguntas frecuentes:
- [Pregunta]: [respuesta]
`,
  catalogo: `Sobre el negocio: [qué vendes y desde dónde]
Horario de atención: [días y horas]

Productos y precios:
- [Producto 1]: [precio] · [presentación o tamaño]
- [Producto 2]: [precio] · [presentación o tamaño]

Entregas: [zonas, costo y tiempo de entrega, o retiro en tienda]
Formas de pago: [efectivo, Pago Móvil, transferencia, etc.]
Cambios y devoluciones: [tu política]

Preguntas frecuentes:
- [Pregunta]: [respuesta]
`,
  atencion: `Sobre el negocio: [qué hace tu negocio]
Horario de atención: [días y horas]
Contacto y ubicación: [dirección, teléfono, redes]

Preguntas frecuentes:
- [Pregunta]: [respuesta]
- [Pregunta]: [respuesta]

Cuándo pasar a una persona: [casos en los que prefieres atender tú: reclamos, cotizaciones grandes, etc.]
`,
};

/** ¿Quedan campos [entre corchetes] sin completar? (Solo para avisar en la pantalla.) */
export function hasPlaceholders(text: string): boolean {
  return /\[[^\]\n]{2,80}\]/.test(text);
}
