import { brand } from "@/config/brand";

/**
 * Documentos legales (BORRADOR). Los escribió una IA como punto de partida: NO son asesoría legal.
 * Antes de cobrar o de recibir clientes reales, un abogado de tu país debe revisarlos y completar lo que dice [PENDIENTE].
 * Al cambiar cualquier texto, cambia LEGAL_VERSION: así se le pide a cada persona que vuelva a aceptar.
 */
export const LEGAL_VERSION = "2026-10-23";
export const LEGAL_UPDATED_LABEL = "23 de octubre de 2026";

export interface LegalSection {
  id: string;
  heading: string;
  /** Texto: cada elemento es un párrafo, o { list } para una lista con viñetas. */
  body: (string | { list: string[] })[];
}
export interface LegalDoc {
  slug: string;
  title: string;
  summary: string;
  sections: LegalSection[];
}

export interface LegalFacts {
  name: string;
  legalName: string;
  domain: string;
  email: string;
  address: string;
  country: string;
}

const pending = (v: string, label: string) => (v.trim() ? v.trim() : `[PENDIENTE: ${label}]`);

export function brandFacts(): LegalFacts {
  const domain = brand.domain === "localhost" ? "" : brand.domain;
  const email = brand.supportEmail === "soporte@example.com" ? "" : brand.supportEmail;
  return { name: brand.name, legalName: brand.legalName, domain, email, address: brand.legalAddress, country: brand.legalCountry };
}

export function buildLegalDocs(f: LegalFacts = brandFacts()): LegalDoc[] {
  const S = pending(f.legalName, "razón social o nombre completo del titular");
  const N = f.name;
  const MAIL = pending(f.email, "correo de contacto");
  const SITE = pending(f.domain, "dirección del sitio web");
  const ADDR = pending(f.address, "dirección del titular");
  const LAW = pending(f.country, "país cuyas leyes aplican y ciudad de los tribunales");

  const terminos: LegalDoc = {
    slug: "terminos",
    title: "Términos y condiciones de uso",
    summary: "Las reglas del servicio: qué es, qué puedes hacer, qué no, pagos y responsabilidades.",
    sections: [
      { id: "quienes", heading: "1. Quiénes somos y qué es el servicio", body: [
        `${N} es un servicio en línea, operado por ${S} («nosotros»), que permite a un negocio («tú» o el «Negocio») atender a sus clientes por WhatsApp con un asistente de inteligencia artificial: responder mensajes, agendar citas, tomar pedidos, llevar el registro de clientes y pasar la conversación a una persona cuando hace falta. Incluye además herramientas de gestión (agenda, catálogo, pedidos, base de conocimiento, copiloto, automatizaciones y soporte).`,
        `Estos términos son un contrato entre tú y nosotros. Al crear una cuenta o usar el servicio declaras que los leíste y que los aceptas. Si usas el servicio en nombre de una empresa, declaras que tienes facultad para obligarla.`,
        `Contacto: ${MAIL}. Titular: ${S}. Domicilio: ${ADDR}. Sitio: ${SITE}.`,
      ] },
      { id: "cuenta", heading: "2. Tu cuenta", body: [
        "Debes ser mayor de edad y tener capacidad legal para contratar. Los datos que nos des deben ser verdaderos y los mantendrás actualizados.",
        "Eres responsable de la actividad de tu cuenta y de las personas a las que invites a tu equipo (con el rol que les des). Guarda tu contraseña y tus códigos de recuperación; avísanos de inmediato si sospechas un acceso no autorizado.",
        "Podemos pedirte pasos adicionales de seguridad (como la verificación en dos pasos) para ciertas acciones.",
      ] },
      { id: "prueba-planes", heading: "3. Prueba gratuita, planes y pagos", body: [
        "Las cuentas nuevas tienen un periodo de prueba de 7 días sin costo y sin tarjeta. Al terminar, para seguir usando el servicio debes contratar un plan.",
        "Cada plan indica su precio, sus módulos y sus límites (por ejemplo, respuestas del asistente por mes y personas del equipo). Los precios pueden estar expresados en dólares y cobrarse en bolívares a la tasa que se muestre en la pantalla de pago; el monto a pagar es el que ves antes de enviar tu comprobante.",
        "Los pagos se verifican manualmente con el comprobante que subes. Tu plan se activa o renueva cuando confirmamos el pago. Si el pago no se confirma a tiempo, el estado de tu cuenta puede pasar a «pago pendiente» y, después, a «suspendida».",
        "Cambiaremos precios, planes o límites avisándote con anticipación razonable; los cambios no afectan el periodo ya pagado.",
        "Las condiciones de cancelación y reembolso están en la Política de cancelación y reembolsos.",
      ] },
      { id: "tus-datos", heading: "4. Tus datos y los de tus clientes", body: [
        "Todo lo que cargas o que llega a tu cuenta (mensajes, contactos, citas, pedidos, productos, documentos de la base de conocimiento) sigue siendo tuyo o de tus clientes. Nos autorizas a tratarlo solo para prestarte el servicio, como explica la Política de privacidad y el Acuerdo de tratamiento de datos.",
        "Tú eres responsable de contar con una base legal para tratar los datos de tus clientes (por ejemplo, su autorización para escribirles por WhatsApp) y de informarles cómo usas sus datos, incluido que los atiende un asistente automatizado.",
        "Puedes pedir una copia de tus datos o la eliminación de tu cuenta en cualquier momento, escribiéndonos a " + MAIL + " o con las opciones de tu cuenta cuando estén disponibles.",
      ] },
      { id: "whatsapp", heading: "5. WhatsApp y Meta", body: [
        `${N} funciona sobre la API oficial de WhatsApp Business Platform de Meta. No somos Meta ni WhatsApp, y ellos no respaldan este servicio.`,
        "Para usarlo debes cumplir los términos y políticas de WhatsApp Business y de Meta (incluida la política de mensajería comercial y la de comercio). Meta puede limitar, bloquear o cobrar por tu número o tu cuenta, o cambiar sus reglas y precios; eso está fuera de nuestro control y no garantizamos que el servicio de Meta esté disponible o que tu número no sea restringido.",
        "Los costos que Meta cobre por las conversaciones los pagas tú directamente a Meta, salvo que te indiquemos otra cosa por escrito.",
      ] },
      { id: "ia", heading: "6. Asistente de inteligencia artificial", body: [
        "El asistente genera respuestas con modelos de inteligencia artificial de terceros. Aunque tiene reglas de seguridad y límites, puede equivocarse, y sus respuestas no son asesoría profesional (médica, legal, financiera ni de otra clase).",
        "Tú defines las instrucciones, los servicios, los precios y los horarios que el asistente usa, y eres responsable de que sean correctos y de revisar las citas, pedidos y conversaciones que genere. Las condiciones detalladas están en el Aviso sobre el uso de inteligencia artificial.",
      ] },
      { id: "uso", heading: "7. Uso aceptable", body: [
        "Debes cumplir la Política de uso aceptable. Podemos limitar o suspender el servicio si la incumples, si pones en riesgo a otras personas o a la plataforma, o si lo exige una autoridad.",
      ] },
      { id: "disponibilidad", heading: "8. Disponibilidad y cambios del servicio", body: [
        "Hacemos lo razonable para mantener el servicio disponible, pero se entrega «tal cual», sin garantía de funcionamiento ininterrumpido o libre de errores. Puede haber mantenimientos, fallas propias o de proveedores (internet, hosting, Meta, proveedores de IA).",
        "Podemos mejorar, cambiar o retirar funciones. Si retiramos algo esencial de tu plan pagado, te lo avisaremos y buscaremos una solución razonable.",
      ] },
      { id: "propiedad", heading: "9. Propiedad intelectual", body: [
        `El software, el diseño y la marca ${N} son nuestros o de nuestros licenciantes. Te damos una licencia limitada, revocable, no exclusiva e intransferible para usar el servicio mientras tengas cuenta. No puedes copiarlo, revenderlo ni intentar extraer su código.`,
        "Tu contenido es tuyo. Nos das permiso para almacenarlo y procesarlo solo para operar el servicio para ti.",
      ] },
      { id: "responsabilidad", heading: "10. Límite de responsabilidad", body: [
        "En la medida que la ley lo permita, no seremos responsables por daños indirectos, pérdida de ganancias, de clientes o de datos derivados del uso o la imposibilidad de usar el servicio, ni por lo que hagan Meta, los proveedores de IA u otros terceros.",
        "Nuestra responsabilidad total frente a ti por cualquier reclamo relacionado con el servicio se limita al monto que pagaste en los 3 meses anteriores al hecho [PENDIENTE: confirmar este límite con tu abogado].",
        "Nada de esto limita responsabilidades que la ley no permita limitar.",
      ] },
      { id: "terminacion", heading: "11. Terminación", body: [
        "Puedes dejar de usar el servicio y cerrar tu cuenta cuando quieras. Podemos suspender o cerrar tu cuenta si incumples estos términos, si no se paga el plan, o por seguridad o requerimiento legal; cuando sea posible te avisaremos antes y te daremos oportunidad de corregir.",
        "Al cerrar la cuenta tus datos se tratan según la Política de privacidad (conservación y eliminación).",
      ] },
      { id: "cambios", heading: "12. Cambios a estos términos", body: [
        "Podemos actualizar estos términos y los demás documentos legales. Cuando el cambio sea importante te pediremos que los aceptes de nuevo dentro del servicio. Si no estás de acuerdo, puedes cerrar tu cuenta.",
      ] },
      { id: "ley", heading: "13. Ley aplicable y contacto", body: [
        `Estos términos se rigen por las leyes de: ${LAW}.`,
        `Para cualquier duda o reclamo escribe a ${MAIL}.`,
      ] },
    ],
  };

  const privacidad: LegalDoc = {
    slug: "privacidad",
    title: "Política de privacidad",
    summary: "Qué datos tratamos, para qué, con quién los compartimos, cuánto los guardamos y qué derechos tienes.",
    sections: [
      { id: "roles", heading: "1. Quién es responsable de qué", body: [
        `Esta política explica cómo ${S} («nosotros») trata datos personales en ${N}. Hay dos situaciones:`,
        { list: [
          "Datos de tu cuenta y de tu equipo (correo, contraseña protegida, nombre del negocio, uso del servicio, pagos): nosotros somos el responsable.",
          "Datos de tus clientes que llegan por WhatsApp o que cargas (nombre, número de teléfono, mensajes, citas, pedidos): tú eres el responsable y nosotros actuamos por tu encargo, como encargado del tratamiento. Esa relación se rige por el Acuerdo de tratamiento de datos.",
        ] },
      ] },
      { id: "datos", heading: "2. Qué datos tratamos", body: [
        { list: [
          "Cuenta: correo electrónico, contraseña (guardada solo como huella protegida, nunca en claro), nombre del negocio, roles del equipo, ajustes de seguridad (verificación en dos pasos).",
          "Sesiones y seguridad: cookie de sesión, tipo de navegador, fechas de acceso y un registro de acciones importantes (auditoría). La dirección IP se usa de forma temporal para limitar abusos y no se guarda en tu perfil.",
          "Contenido de tu negocio: configuración del asistente, servicios, horarios, productos, documentos de la base de conocimiento, citas, pedidos y tareas.",
          "Datos de tus clientes: nombre que muestra WhatsApp, número de teléfono, mensajes de texto (y el tipo de otros mensajes), y lo que se derive (citas, pedidos, notas, etiquetas).",
          "Conexión con WhatsApp: identificador del número y la credencial de acceso, que se guarda cifrada.",
          "Pagos: monto, referencia, fecha e imagen del comprobante que subes.",
          "Soporte: los mensajes que nos escribes.",
          "Uso: contadores (respuestas, tokens de IA, errores). Esas cifras no incluyen el texto de los mensajes.",
        ] },
      ] },
      { id: "para-que", heading: "3. Para qué los usamos", body: [
        { list: [
          "Prestarte el servicio: que el asistente responda, agendar citas, mostrar tus conversaciones y pedidos.",
          "Seguridad: prevenir fraudes, abusos y accesos no autorizados; mantener registros de auditoría.",
          "Cobros y administración de tu plan.",
          "Soporte y comunicaciones del servicio (avisos importantes, cambios de términos).",
          "Mejorar y mantener la plataforma con cifras agregadas (sin leer el contenido de tus conversaciones).",
          "Cumplir obligaciones legales.",
        ] },
        "No vendemos datos personales. No usamos el contenido de tus conversaciones para publicidad.",
      ] },
      { id: "terceros", heading: "4. Con quién los compartimos", body: [
        "Usamos proveedores que tratan datos por nuestra cuenta, solo para lo necesario:",
        { list: [
          "Meta (WhatsApp Business Platform): entrega y recibe los mensajes de WhatsApp. Meta trata los datos según sus propios términos y política de privacidad.",
          `Proveedor de inteligencia artificial: recibe el texto necesario para generar cada respuesta (instrucciones, historial reciente de la conversación y datos de tu negocio). Proveedor: ${pending("", "nombre del proveedor de IA y país")}.`,
          `Proveedor de alojamiento (servidores y base de datos): ${pending("", "nombre del proveedor de hosting y país")}.`,
          `Proveedor de correo electrónico (cuando se active el envío de correos): ${pending("", "nombre del proveedor de correo, o «no aplica»")}.`,
        ] },
        "También podemos revelar datos si una ley o una autoridad competente lo exige, o para proteger derechos y seguridad.",
        "Algunos de estos proveedores pueden estar en otros países, por lo que tus datos pueden transferirse fuera de tu país. Procuramos que cuenten con medidas de seguridad adecuadas.",
      ] },
      { id: "seguridad", heading: "5. Cómo los protegemos", body: [
        { list: [
          "Cada negocio solo puede ver sus propios datos: el aislamiento está aplicado en la base de datos, no solo en la aplicación.",
          "Las contraseñas se guardan con un algoritmo de protección de contraseñas (Argon2) y las credenciales de WhatsApp se cifran en reposo (AES-256-GCM).",
          "La sesión usa una cookie protegida (no accesible por scripts) y existe verificación en dos pasos; es obligatoria para los administradores de la plataforma.",
          "Hay límites de intentos, registros de auditoría y controles contra el abuso de la IA.",
        ] },
        "Ningún sistema es 100 % seguro. Si ocurre un incidente que afecte tus datos, te avisaremos sin demora indebida.",
      ] },
      { id: "conservacion", heading: "6. Cuánto tiempo los conservamos", body: [
        `Conservamos los datos mientras tu cuenta esté activa. Si la cierras o nos pides eliminarla, borramos los datos del negocio y de sus clientes en un plazo de ${pending("", "plazo, por ejemplo 30 días")}, salvo lo que debamos conservar por ley (por ejemplo, registros de pagos) o por seguridad (registros de auditoría), y copias de respaldo que se sobrescriben en su ciclo normal.`,
      ] },
      { id: "derechos", heading: "7. Tus derechos", body: [
        "Puedes pedirnos acceder a tus datos, corregirlos, recibir una copia, oponerte a ciertos usos o solicitar su eliminación, en la medida que las leyes que te apliquen lo permitan. Escribe a " + MAIL + ". Responderemos en un plazo razonable y podemos pedirte confirmar tu identidad.",
        "Si eres cliente final de un negocio que usa " + N + " (escribiste por WhatsApp a ese negocio), tu solicitud sobre tus mensajes debe dirigirse primero a ese negocio, que es el responsable. Podemos ayudarlo a atenderla.",
      ] },
      { id: "menores", heading: "8. Menores de edad", body: [
        "El servicio es para negocios y personas adultas. No dirigimos el servicio a menores de edad y no recopilamos sus datos a propósito.",
      ] },
      { id: "cambios", heading: "9. Cambios y contacto", body: [
        `Podemos actualizar esta política; si el cambio es importante te lo avisaremos en el servicio. Contacto: ${MAIL}.`,
      ] },
    ],
  };

  const cookies: LegalDoc = {
    slug: "cookies",
    title: "Política de cookies",
    summary: "Qué cookies usa el sitio: solo la de sesión, necesaria para entrar.",
    sections: [
      { id: "que-usamos", heading: "1. Qué cookies usamos", body: [
        `${N} usa una sola cookie: la de sesión (se llama «sid» o «__Host-sid»). Sirve para reconocerte después de iniciar sesión y mantener tu cuenta segura. Es estrictamente necesaria: sin ella no podrías entrar.`,
        "Es una cookie propia, protegida (HttpOnly, solo por HTTPS en producción, sin acceso desde scripts) y caduca al cerrar sesión o pasado un tiempo.",
      ] },
      { id: "que-no", heading: "2. Qué no usamos", body: [
        "No usamos cookies de publicidad, de seguimiento entre sitios ni herramientas de análisis de terceros. Por eso no mostramos un aviso para aceptar cookies: las estrictamente necesarias no lo requieren.",
        "Si algún día añadimos analítica u otras cookies no esenciales, actualizaremos esta política y te pediremos tu permiso antes de usarlas.",
      ] },
      { id: "control", heading: "3. Cómo controlarlas", body: [
        "Puedes borrar las cookies desde tu navegador; si borras la de sesión, tendrás que volver a iniciar sesión. Cerrar sesión desde el servicio también la elimina.",
      ] },
    ],
  };

  const uso: LegalDoc = {
    slug: "uso-aceptable",
    title: "Política de uso aceptable",
    summary: "Lo que no se permite hacer con el servicio, incluidas las reglas de WhatsApp Business.",
    sections: [
      { id: "principio", heading: "1. Principio general", body: [
        `Usa ${N} para atender a personas que quieren que les escribas. Esta política protege a tus clientes, a otros negocios, a tu número de WhatsApp y a la plataforma. Su incumplimiento puede llevar a limitar o suspender tu cuenta.`,
      ] },
      { id: "whatsapp", heading: "2. Reglas de WhatsApp Business", body: [
        "Debes cumplir en todo momento los términos de WhatsApp Business, la política de mensajería comercial y la política de comercio de Meta. En especial:",
        { list: [
          "Escribe solo a personas que te dieron su número y aceptaron recibir mensajes tuyos (consentimiento previo). Respeta de inmediato a quien pida no recibir más mensajes.",
          "No envíes mensajes masivos no solicitados («spam»), cadenas, ni mensajes engañosos.",
          "Respeta la ventana de 24 horas: fuera de ella solo se pueden enviar plantillas aprobadas por Meta.",
          "No vendas ni promociones lo que Meta prohíbe (por ejemplo, armas, drogas, contenido para adultos, servicios ilegales, productos falsificados, juegos de azar no autorizados, esquemas piramidales).",
          "Mantén datos reales y actualizados del negocio y no te hagas pasar por otra persona o marca.",
        ] },
      ] },
      { id: "prohibido", heading: "3. Está prohibido", body: [
        { list: [
          "Usar el servicio para actividades ilegales, fraude, estafas, acoso, amenazas, discriminación o contenido que explote a menores.",
          "Pedir a los clientes contraseñas, claves, códigos de verificación o datos de pago por el chat.",
          "Cargar o enviar virus, o intentar acceder sin permiso a cuentas, datos o sistemas de otras personas.",
          "Probar vulnerabilidades, saturar el servicio, hacer ingeniería inversa, extraer datos en masa o saltarse límites y controles de seguridad.",
          "Manipular al asistente para que ignore sus reglas, revele sus instrucciones internas o genere contenido prohibido; o usarlo para que dos asistentes automáticos se respondan entre sí en bucle.",
          "Revender el servicio o compartir tu cuenta con personas ajenas a tu negocio.",
          "Usar la IA del servicio para fines distintos a atender a tu negocio y a tus clientes.",
        ] },
      ] },
      { id: "uso-justo", heading: "4. Uso justo y límites", body: [
        "Los planes tienen límites (respuestas por mes, personas del equipo) y existen topes de seguridad por día, por cliente y por consumo de IA. Podemos pausar el asistente cuando se alcanzan, para proteger la plataforma y tus costos.",
      ] },
      { id: "medidas", heading: "5. Qué podemos hacer", body: [
        "Si detectamos un incumplimiento podemos advertirte, limitar funciones, suspender o cerrar la cuenta, y colaborar con las autoridades cuando corresponda. Cuando sea posible te avisaremos antes.",
        "Para reportar un abuso escribe a " + MAIL + ".",
      ] },
    ],
  };

  const ia: LegalDoc = {
    slug: "inteligencia-artificial",
    title: "Aviso sobre el uso de inteligencia artificial",
    summary: "Cómo funciona el asistente, sus límites y lo que debes informar a tus clientes.",
    sections: [
      { id: "como", heading: "1. Cómo funciona", body: [
        "El asistente responde mensajes de WhatsApp usando modelos de inteligencia artificial de un proveedor externo. Para cada respuesta se envía al proveedor el texto necesario: las instrucciones de tu negocio, el historial reciente de la conversación, y los datos que tú cargaste (servicios, horarios, productos, documentos).",
        `Proveedor y modelo actuales: ${pending("", "proveedor de IA y modelo")}. ${pending("", "confirmar con el proveedor que los datos enviados por API no se usan para entrenar sus modelos")}.`,
        "El copiloto del dueño usa el mismo tipo de modelos para responder preguntas sobre tu negocio con cifras calculadas por el sistema; es de solo lectura.",
      ] },
      { id: "limites", heading: "2. Límites que debes conocer", body: [
        { list: [
          "La IA puede dar respuestas incorrectas, incompletas o inventadas, aunque tenga reglas para evitarlo. Revisa regularmente las conversaciones, citas y pedidos.",
          "El asistente solo debe apoyarse en lo que tú le configuraste. Mantén tus instrucciones, precios y horarios al día.",
          "No está pensado para dar consejo médico, legal, financiero ni para decidir cosas con efectos legales sobre una persona. Configúralo para que pase esos casos a una persona.",
          "Tiene controles de seguridad (por ejemplo, contra intentos de manipulación y enlaces no permitidos), pero ninguno es perfecto.",
        ] },
      ] },
      { id: "humano", heading: "3. Intervención humana", body: [
        "Una persona de tu equipo puede tomar cualquier conversación cuando quiera. El asistente también pasa la conversación a una persona cuando el cliente la pide, cuando hay un problema o cuando se alcanza un límite. Mientras una persona atiende, el asistente no responde.",
      ] },
      { id: "transparencia", heading: "4. Lo que debes decirle a tus clientes", body: [
        "Es tu responsabilidad informar a tus clientes que están hablando con un asistente automatizado y cómo se usan sus datos, en la forma que exijan las leyes que te apliquen y las reglas de WhatsApp. Te recomendamos dejarlo claro en el mensaje de bienvenida y en tu perfil de WhatsApp Business.",
      ] },
      { id: "datos", heading: "5. Datos y entrenamiento", body: [
        "No usamos el contenido de tus conversaciones para entrenar modelos propios. Para el tratamiento por parte del proveedor de IA, ver la sección 1 y la Política de privacidad.",
      ] },
    ],
  };

  const reembolsos: LegalDoc = {
    slug: "reembolsos",
    title: "Política de cancelación y reembolsos",
    summary: "Cómo cancelar tu plan y en qué casos se devuelve un pago.",
    sections: [
      { id: "prueba", heading: "1. Prueba gratuita", body: [
        "La prueba de 7 días no tiene costo ni requiere tarjeta; no hay nada que reembolsar. Si no contratas un plan, tu cuenta queda con acceso limitado y puedes descargar o pedir la eliminación de tus datos.",
      ] },
      { id: "cancelar", heading: "2. Cancelar", body: [
        "Puedes dejar de renovar cuando quieras: no hay permanencia mínima. Mantienes el acceso hasta el final del periodo ya pagado. Para cerrar tu cuenta y eliminar tus datos, escribe a " + MAIL + ".",
      ] },
      { id: "reembolsos", heading: "3. Reembolsos", body: [
        `Los pagos de periodos ya iniciados no son reembolsables, salvo: (a) cobros duplicados o por un monto incorrecto, (b) fallas graves del servicio que nos sean imputables y no resolvamos en un plazo razonable, o (c) lo que la ley aplicable exija. Debes pedirlo dentro de ${pending("", "plazo, por ejemplo 7 días desde el pago")} escribiendo a ${MAIL} con tu comprobante.`,
        "Si corresponde, devolvemos el monto por el mismo medio de pago o, si no es posible, por otro medio acordado, o lo acreditamos al siguiente periodo si así lo prefieres.",
        "[PENDIENTE: confirma estas condiciones de reembolso con tu criterio de negocio y tu abogado]",
      ] },
      { id: "tasa", heading: "4. Pagos en bolívares", body: [
        "Cuando el precio está en dólares y se paga en bolívares, el monto se calcula con la tasa mostrada al momento del pago. Una diferencia posterior de la tasa no genera reembolso ni cobro adicional por sí sola.",
      ] },
    ],
  };

  const dpa: LegalDoc = {
    slug: "tratamiento-de-datos",
    title: "Acuerdo de tratamiento de datos",
    summary: "Qué hacemos con los datos de tus clientes por tu encargo y cómo los protegemos.",
    sections: [
      { id: "objeto", heading: "1. Objeto y partes", body: [
        `Este acuerdo forma parte de los Términos y condiciones entre tú (el Negocio, «responsable») y ${S} («encargado»). Aplica a los datos personales de tus clientes y contactos que tratamos por tu encargo al prestarte ${N}.`,
      ] },
      { id: "detalle", heading: "2. Detalle del tratamiento", body: [
        { list: [
          "Finalidad: prestar el servicio de atención por WhatsApp, agenda, pedidos y gestión de clientes.",
          "Tipos de datos: nombre, número de teléfono, contenido de los mensajes, citas, pedidos, etiquetas y notas.",
          "Personas afectadas: tus clientes y contactos.",
          "Duración: mientras tu cuenta esté activa y hasta su eliminación según este acuerdo.",
        ] },
      ] },
      { id: "obligaciones", heading: "3. Nuestras obligaciones como encargado", body: [
        { list: [
          "Tratar los datos solo siguiendo tus instrucciones documentadas (este acuerdo, los términos y lo que configures en el servicio), salvo que una ley nos obligue a otra cosa.",
          "Mantener la confidencialidad: solo accede personal autorizado y comprometido a reservar la información. El acceso de soporte a tu cuenta es limitado en el tiempo, requiere un motivo y queda registrado.",
          "Aplicar medidas de seguridad técnicas y organizativas adecuadas (ver la Política de privacidad, sección 5).",
          "No contratar otros encargados sin las garantías de este acuerdo. Los actuales son los de la Política de privacidad, sección 4; te avisaremos de cambios importantes y podrás oponerte.",
          "Ayudarte, en lo razonable, a atender las solicitudes de tus clientes (acceso, corrección, eliminación) y a cumplir tus obligaciones de seguridad y notificación.",
          "Avisarte sin demora indebida si tenemos conocimiento de una violación de seguridad que afecte los datos de tus clientes.",
          "Al terminar el servicio, devolverte o eliminar los datos según la Política de privacidad, salvo lo que la ley nos obligue a conservar.",
          "Ponernos a tu disposición la información razonable para demostrar el cumplimiento de este acuerdo.",
        ] },
      ] },
      { id: "tus-obligaciones", heading: "4. Tus obligaciones como responsable", body: [
        { list: [
          "Tener una base legal para tratar los datos de tus clientes y para escribirles por WhatsApp (consentimiento previo cuando corresponda).",
          "Informarles de forma clara cómo usas sus datos y que los atiende un asistente automatizado.",
          "Darnos instrucciones lícitas y configurar el servicio de acuerdo con la ley que te aplique.",
        ] },
      ] },
      { id: "transferencias", heading: "5. Transferencias internacionales", body: [
        "Tus datos pueden tratarse en otros países por los proveedores de la Política de privacidad. Procuramos que ofrezcan garantías adecuadas. [PENDIENTE: tu abogado debe confirmar qué exige la ley de tu país para transferencias internacionales]",
      ] },
    ],
  };

  return [terminos, privacidad, cookies, uso, ia, reembolsos, dpa];
}

export const LEGAL_SLUGS = ["terminos", "privacidad", "cookies", "uso-aceptable", "inteligencia-artificial", "reembolsos", "tratamiento-de-datos"] as const;

/** Textos «[PENDIENTE: …]» que todavía hay que completar o confirmar con un abogado. */
export function pendingItems(docs: LegalDoc[] = buildLegalDocs()): { slug: string; item: string }[] {
  const out: { slug: string; item: string }[] = [];
  const scan = (slug: string, t: string) => { for (const m of t.matchAll(/\[PENDIENTE:[^\]]*\]/g)) out.push({ slug, item: m[0] }); };
  for (const d of docs) for (const s of d.sections) for (const b of s.body) { if (typeof b === "string") scan(d.slug, b); else b.list.forEach((l) => scan(d.slug, l)); }
  return out;
}
