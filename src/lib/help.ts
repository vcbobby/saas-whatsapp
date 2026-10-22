/** Centro de ayuda: un tema por pantalla, con pasos cortos y enlaces. Sin dependencias del servidor (lo usan el menú y la página). */

export interface HelpLink { href: string; label: string }
export interface HelpTopic {
  id: string;
  title: string;
  /** Una línea: para qué sirve esta pantalla. */
  summary: string;
  steps: string[];
  links: HelpLink[];
}

export const HELP_TOPICS: HelpTopic[] = [
  {
    id: "inicio", title: "Inicio", summary: "Cómo va tu negocio de un vistazo y qué te falta por configurar.",
    steps: [
      "«Requiere tu atención» muestra lo que espera a una persona: conversaciones, tareas, citas y pedidos por confirmar. Cada cifra es un enlace.",
      "«Primeros pasos» se marca sola a medida que configuras tu cuenta y desaparece cuando todo está listo.",
      "Las cifras comparan los últimos 7 días con los 7 anteriores; los gráficos muestran las últimas 2 semanas.",
    ],
    links: [{ href: "/panel", label: "Ir a Inicio" }],
  },
  {
    id: "whatsapp", title: "Conectar WhatsApp", summary: "Une tu número de WhatsApp Business para que el asistente atienda a tus clientes.",
    steps: [
      "Necesitas una cuenta de WhatsApp Business en Meta con un número registrado en la API oficial.",
      "En el panel de Meta (WhatsApp > Configuración de la API) copia el «ID del número de teléfono» y el «token de acceso».",
      "Pégalos en la pantalla de WhatsApp. El token se guarda cifrado y no vuelve a mostrarse.",
      "Escríbele a tu número desde otro teléfono: la conversación debe aparecer en Conversaciones.",
    ],
    links: [{ href: "/whatsapp", label: "Conectar mi número" }, { href: "/conversaciones", label: "Ver conversaciones" }],
  },
  {
    id: "asistente", title: "Mi asistente", summary: "Cómo se llama, cómo habla y qué sabe de tu negocio.",
    steps: [
      "Elige el nombre, el tono (cercano o formal) y cuántos emojis usa.",
      "En «información del negocio» escribe lo que un cliente suele preguntar: dirección, horario, formas de pago, políticas. El asistente solo responde con lo que tú le cuentes.",
      "El interruptor «activado» decide si responde. Apagado, las conversaciones quedan para tu equipo.",
      "Pruébalo en «Probar» antes de conectar clientes reales.",
    ],
    links: [{ href: "/agente", label: "Configurar el asistente" }, { href: "/simulador", label: "Probar el asistente" }],
  },
  {
    id: "conocimiento", title: "Conocimiento", summary: "Documentos que el asistente consulta para responder con más detalle.",
    steps: [
      "Añade textos cortos y claros: lista de precios, preguntas frecuentes, políticas de cambios, ubicación con puntos de referencia.",
      "Un tema por documento funciona mejor que un documento enorme.",
      "Después de guardar, el documento pasa por «indexando» y luego queda «listo»; recién ahí el asistente lo usa.",
      "Si cambias algo importante, edita el documento: el asistente usa siempre la versión nueva.",
    ],
    links: [{ href: "/conocimiento", label: "Abrir Conocimiento" }],
  },
  {
    id: "conversaciones", title: "Conversaciones", summary: "Todos los chats con tus clientes, en un solo lugar.",
    steps: [
      "Mientras una conversación está en modo asistente, él responde solo.",
      "Pulsa «Tomar la conversación» para que el asistente deje de responder y escribas tú. Al terminar, «Devolver al asistente».",
      "Puedes etiquetar a cada contacto (por ejemplo cliente frecuente o proveedor) para decidir si el asistente le responde.",
      "Los filtros de arriba separan lo activo de lo cerrado.",
    ],
    links: [{ href: "/conversaciones", label: "Ver conversaciones" }],
  },
  {
    id: "hoy", title: "Hoy", summary: "La lista de lo que necesita a una persona, ordenada por urgencia.",
    steps: [
      "El asistente y las automatizaciones crean tareas aquí: confirmar un pedido, atender a quien pidió hablar con una persona, etc.",
      "Marca cada tarea como resuelta al terminarla; las resueltas quedan en el historial.",
      "Se actualiza sola, no necesitas recargar.",
    ],
    links: [{ href: "/hoy", label: "Ver mis tareas" }],
  },
  {
    id: "agenda", title: "Agenda de citas", summary: "Servicios, horarios y citas de tus clientes.",
    steps: [
      "Crea tus servicios con su duración: la duración decide cuánto espacio ocupa cada cita.",
      "Define los días y horas en que atiendes. Lo que no marques queda cerrado.",
      "Las citas pueden crearlas tu equipo o el asistente; no se pueden cruzar dos citas en el mismo horario.",
      "Puedes bloquear días (vacaciones, feriados) para que nadie agende ahí.",
    ],
    links: [{ href: "/agenda", label: "Abrir la agenda" }],
  },
  {
    id: "catalogo", title: "Catálogo", summary: "Los productos que vendes, con precio y, si quieres, stock.",
    steps: [
      "Añade cada producto con su precio. El stock es opcional: déjalo vacío si no lo controlas.",
      "La moneda se elige una vez para todo el catálogo.",
      "Un producto con stock 0 aparece como «Agotado»; los que quedan con poco stock aparecen en tu resumen.",
    ],
    links: [{ href: "/catalogo", label: "Abrir el catálogo" }],
  },
  {
    id: "pedidos", title: "Pedidos", summary: "Lo que piden tus clientes, desde que llega hasta que se entrega.",
    steps: [
      "Los pedidos llegan por el asistente o los creas tú a mano, con productos de tu catálogo.",
      "Cada pedido pasa por pendiente, confirmado y entregado (o cancelado). Confirmarlo descuenta el stock.",
      "Los pedidos pendientes de más de un día se destacan en tu resumen.",
    ],
    links: [{ href: "/pedidos", label: "Ver pedidos" }, { href: "/catalogo", label: "Revisar el catálogo" }],
  },
  {
    id: "probar", title: "Probar", summary: "Chatea con tu asistente como si fueras un cliente, sin gastar mensajes de WhatsApp.",
    steps: [
      "Escribe como lo haría un cliente: pregunta por precios, horarios, pide una cita.",
      "Si responde mal, mejora la información del negocio o los documentos de Conocimiento y prueba de nuevo.",
    ],
    links: [{ href: "/simulador", label: "Abrir el simulador" }, { href: "/agente", label: "Ajustar el asistente" }],
  },
  {
    id: "copiloto", title: "Copiloto", summary: "Pregúntale por tu negocio con lenguaje normal.",
    steps: [
      "Hazle preguntas como «¿cuántas citas tengo mañana?» o «¿qué pedidos están pendientes?».",
      "Responde solo con los datos reales de tu negocio; si no los tiene, te lo dice.",
    ],
    links: [{ href: "/copiloto", label: "Abrir el copiloto" }],
  },
  {
    id: "automatizaciones", title: "Automatizaciones", summary: "Reglas del tipo «cuando pase esto, haz esto».",
    steps: [
      "Elige qué evento las dispara (por ejemplo, un pedido nuevo o una cita por confirmar).",
      "Elige qué pasa: crear una tarea en Hoy o avisar al cliente por WhatsApp.",
      "Cada regla muestra cuántas veces se ha ejecutado; puedes pausarla cuando quieras.",
    ],
    links: [{ href: "/automatizaciones", label: "Ver automatizaciones" }],
  },
  {
    id: "conexiones", title: "Conexiones", summary: "Envía datos de tu negocio a otras aplicaciones.",
    steps: [
      "Una conexión avisa a otra aplicación (por ejemplo tu sistema de facturación) cuando ocurre algo en tu negocio.",
      "Cada conexión tiene una clave secreta para que la otra aplicación verifique que el aviso es tuyo.",
      "Es una función para quien ya usa otras herramientas; si no la necesitas, puedes ignorarla.",
    ],
    links: [{ href: "/conexiones", label: "Ver conexiones" }],
  },
  {
    id: "equipo", title: "Equipo", summary: "Quién puede entrar a tu cuenta y qué puede hacer.",
    steps: [
      "Invita a una persona por correo: le llega un enlace para crear su acceso.",
      "Dueño: todo. Administrador: configura el negocio. Agente: atiende conversaciones, agenda y pedidos.",
      "Cada plan tiene un máximo de personas; las invitaciones pendientes también cuentan.",
    ],
    links: [{ href: "/equipo", label: "Gestionar el equipo" }],
  },
  {
    id: "plan", title: "Plan y pagos", summary: "Tu plan, lo que incluye y cómo pagarlo.",
    steps: [
      "Aquí ves cuánto has usado de tu plan este mes y hasta cuándo está vigente.",
      "Elige el plan y el método de pago, envía tu comprobante y lo revisamos.",
      "Cuando se confirma el pago, tu plan se extiende por los meses pagados.",
    ],
    links: [{ href: "/plan", label: "Ver mi plan" }],
  },
  {
    id: "cuenta", title: "Mi cuenta", summary: "El nombre de tu negocio y tus datos.",
    steps: ["Cambia el nombre del negocio cuando quieras (lo pueden hacer el dueño y los administradores).", "Tu contraseña y la verificación en dos pasos están en Seguridad."],
    links: [{ href: "/cuenta", label: "Abrir Mi cuenta" }, { href: "/seguridad", label: "Ir a Seguridad" }],
  },
  {
    id: "seguridad", title: "Seguridad", summary: "Contraseña y verificación en dos pasos.",
    steps: [
      "Cambia tu contraseña cuando quieras: pedimos la actual y cerramos tu sesión en los otros dispositivos.",
      "Activa la verificación en dos pasos con una app autenticadora y guarda tus códigos de recuperación en un lugar seguro.",
    ],
    links: [{ href: "/seguridad", label: "Abrir Seguridad" }],
  },
  {
    id: "soporte", title: "Soporte", summary: "Escríbenos cuando algo no funcione o tengas una duda que la Ayuda no resuelve.",
    steps: [
      "Pulsa «Nueva consulta», escribe un asunto corto y cuéntanos qué pasó (qué pantalla, qué esperabas, qué ocurrió). No escribas contraseñas.",
      "Te respondemos en la misma consulta: cuando haya respuesta verás «Soporte respondió». Puedes seguir escribiendo ahí.",
      "Cuando se resuelva, pulsa «Ya se resolvió: cerrar». Si escribes de nuevo en una consulta cerrada, se reabre.",
      "Puedes tener hasta 5 consultas abiertas a la vez. Las abre el dueño o un administrador.",
    ],
    links: [{ href: "/soporte", label: "Abrir Soporte" }, { href: "/ayuda", label: "Ver la Ayuda" }],
  },
  {
    id: "administracion", title: "Administración", summary: "Para el súper admin: cómo va la plataforma y sus negocios.",
    steps: [
      "Resumen: registros de la semana, negocios en prueba y con plan activo, y lo que requiere atención (pagos por revisar, planes por vencer).",
      "Negocios: cambia el estado o el plan de un negocio y entra como soporte (pide un motivo, dura 30 minutos y queda en el registro).",
      "Soporte: consultas que te escriben los negocios; respondes ahí mismo (el negocio ve «Soporte», no tu correo) y puedes cerrarlas o reabrirlas.",
      "Uso y salud: módulos que usan los negocios, consumo de IA por negocio y errores de los últimos 7 días. Solo cifras, nunca mensajes de clientes.",
      "Planes: qué incluye cada plan y su precio. Cobros: tasa del dólar, métodos de pago y revisión de comprobantes.",
    ],
    links: [{ href: "/admin", label: "Abrir el resumen" }, { href: "/admin/negocios", label: "Ver negocios" }],
  },
];

export const HELP_FAQ: { q: string; a: string }[] = [
  { q: "El asistente no responde. ¿Qué reviso?", a: "Que el asistente esté activado (Mi asistente), que tu WhatsApp esté conectado, que la conversación no esté tomada por una persona, y que no hayas llegado al tope mensual de respuestas de tu plan (lo ves en Inicio)." },
  { q: "¿Puedo escribirle yo a un cliente?", a: "Sí. En Conversaciones pulsa «Tomar la conversación»: el asistente se pausa y escribes tú. Cuando termines, «Devolver al asistente»." },
  { q: "¿El asistente puede inventar precios o datos?", a: "Está limitado a lo que tú le escribes (información del negocio, Conocimiento, servicios y catálogo). Si no tiene el dato, debe decirlo y ofrecer pasar con una persona. Aun así, pruébalo en «Probar» y revisa las primeras conversaciones reales." },
  { q: "¿Qué pasa si mi plan vence?", a: "Tu cuenta puede quedar suspendida y el asistente dejaría de responder hasta que renueves. En Plan y pagos ves la fecha de vencimiento para renovar a tiempo." },
  { q: "¿Cómo cambio el nombre de mi negocio o mi contraseña?", a: "El nombre está en Mi cuenta; la contraseña, en Seguridad." },
  { q: "¿Cómo invito a alguien de mi equipo?", a: "En Equipo, escribe su correo y elige su rol. Le llegará un enlace para crear su acceso." },
];

/** Qué tema de ayuda corresponde a una ruta (null si la pantalla no tiene). */
export function topicForPath(pathname: string): HelpTopic | null {
  const seg = "/" + (pathname.split("/")[1] ?? "");
  const map: Record<string, string> = {
    "/panel": "inicio", "/whatsapp": "whatsapp", "/agente": "asistente", "/conocimiento": "conocimiento", "/conversaciones": "conversaciones",
    "/hoy": "hoy", "/agenda": "agenda", "/catalogo": "catalogo", "/pedidos": "pedidos", "/simulador": "probar", "/copiloto": "copiloto",
    "/automatizaciones": "automatizaciones", "/conexiones": "conexiones", "/equipo": "equipo", "/plan": "plan", "/cuenta": "cuenta", "/seguridad": "seguridad", "/admin": "administracion", "/soporte": "soporte",
  };
  const id = map[seg];
  return id ? (HELP_TOPICS.find((t) => t.id === id) ?? null) : null;
}
