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
    id: "clientes", title: "Clientes", summary: "La ficha de cada persona que te escribe: su historial, etiquetas y notas.",
    steps: [
      "Cada persona que te escribe por WhatsApp aparece sola en Clientes. Busca por nombre o teléfono, o filtra por etiqueta y tipo de contacto.",
      "Abre una ficha para ver sus conversaciones, pedidos y citas, y cuánto ha comprado.",
      "Las etiquetas (como «mayorista» o «VIP») sirven para agrupar clientes. Puedes poner hasta 10 por persona.",
      "La nota interna es solo para tu equipo: el cliente nunca la ve.",
      "«Permiso para promociones» registra cuándo y cómo aceptó recibirlas. Las difusiones (próximamente) solo irán a quienes lo tengan.",
      "«No enviarle avisos» detiene los recordatorios y mensajes automáticos para esa persona. Si ella escribe «BAJA», se activa sola.",
    ],
    links: [{ href: "/clientes", label: "Ir a Clientes" }],
  },
  {
    id: "difusiones", title: "Difusiones", summary: "Envía una promoción por WhatsApp a tus clientes que aceptaron recibirla.",
    steps: [
      "Necesitas una plantilla de WhatsApp aprobada que diga cómo darse de baja (por ejemplo «Responde BAJA para no recibir más promociones»). Se crea en WhatsApp > Plantillas.",
      "Crea la difusión: elige la plantilla, qué poner en cada variable (el nombre del cliente o un texto fijo) y a quién (todos, una etiqueta o un tipo de contacto).",
      "Solo reciben el mensaje las personas con «permiso para promociones» registrado en su ficha. Se dejan fuera quienes pidieron la baja, los marcados como personales, los que está atendiendo una persona y quienes recibieron otra difusión en los últimos 3 días.",
      "La vista previa te dice a cuántas personas llegaría y por qué se excluye a las demás. Nada se envía hasta que confirmes.",
      "El envío es gradual (unos 250 por día como máximo, el límite de un número nuevo en WhatsApp). Si fallan muchos mensajes, la difusión se pausa sola para proteger tu número.",
      "En los resultados ves cuántos se enviaron, entregaron, leyeron y respondieron. Después puedes reenviar a quienes no la leyeron.",
    ],
    links: [{ href: "/difusiones", label: "Ir a Difusiones" }, { href: "/whatsapp", label: "Plantillas de WhatsApp" }],
  },
  {
    id: "reportes", title: "Reportes", summary: "Mira cómo va tu negocio y recibe un resumen cada lunes.",
    steps: [
      "En Reportes ves los últimos 7 o 30 días completos (hasta ayer) comparados con el período anterior.",
      "Incluye conversaciones, clientes nuevos, cuántas resolvió el asistente solo y cuántas pasaron a una persona, tiempos de primera respuesta, horas de más movimiento, pedidos, ventas y citas.",
      "Cada lunes el dueño y los administradores reciben un resumen por correo (si hubo actividad). Puedes apagarlo o pedirlo en cualquier momento desde la misma página.",
    ],
    links: [{ href: "/reportes", label: "Ir a Reportes" }],
  },
  {
    id: "horario", title: "Horario de atención", summary: "Avisa a tus clientes cuándo los atenderá una persona.",
    steps: [
      "En Horario de atención marca los días y horas en que hay personas atendiendo (puedes poner hasta 3 tramos por día).",
      "El asistente sigue respondiendo a toda hora. El horario solo cambia lo que pasa cuando el cliente pide hablar con una persona fuera de horario.",
      "En ese caso la conversación pasa igual a tu equipo, y al cliente se le dice cuándo lo atenderán (por ejemplo «mañana a las 8:00 a. m.»). Puedes añadir un texto extra, como un teléfono para urgencias.",
      "El asistente también conoce este horario y no inventa otros si el cliente pregunta.",
    ],
    links: [{ href: "/horario", label: "Ir a Horario de atención" }],
  },
  {
    id: "tienda", title: "Catálogo público", summary: "Comparte tus productos por enlace o código QR y recibe pedidos por WhatsApp.",
    steps: [
      "En Catálogo público escribe el WhatsApp al que quieres que te escriban (con código de país y sin el 0 inicial) y marca «Mostrar mi catálogo».",
      "Se publica una página con tus productos activos y sus precios. No se muestra tu inventario: solo «Agotado» cuando no queda.",
      "Tus clientes eligen cantidades y, con un clic, se abre WhatsApp con el pedido escrito. El pedido llega como un mensaje normal a tu bandeja.",
      "Copia el enlace o descarga el código QR para imprimirlo. Si dejas de querer mostrarlo, desmarca la casilla y la página deja de existir al instante.",
    ],
    links: [{ href: "/tienda", label: "Ir a Catálogo público" }, { href: "/catalogo", label: "Mi catálogo" }],
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
      "«Nota privada» guarda un comentario dentro de la conversación (por ejemplo «pidió descuento, consultar al dueño»). Solo lo ve tu equipo y nunca llega al cliente.",
      "Cuando el asistente pasa un chat a una persona, se le asigna según el reparto que configures en Equipo, y le llega un correo. En la lista suena un aviso (puedes apagarlo) y el número en la pestaña indica cuántos esperan.",
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
      "«Reparto de conversaciones» decide a quién se le asigna un chat cuando el asistente lo pasa a una persona: a mano, por turnos o a quien tenga menos. También activa o apaga el aviso por correo.",
    ],
    links: [{ href: "/equipo", label: "Gestionar el equipo" }],
  },
  {
    id: "datos", title: "Importar y exportar", summary: "Sube tus productos desde Excel y descarga tus datos.",
    steps: [
      "Para importar: descarga la plantilla, llénala en Excel (Nombre y Precio son obligatorios) y guárdala como CSV.",
      "Al subirla ves una vista previa con lo que se creará, lo que se actualizará y las filas con error; recién al confirmar se cambia algo.",
      "Un producto que ya existe se actualiza solo con las columnas que llenes: una celda vacía no borra nada, y la importación nunca borra productos.",
      "Para exportar: elige clientes, pedidos, citas o productos. Si en Excel todo queda en una sola columna, descarga el otro formato.",
      "Abajo puedes cargar «datos de ejemplo» (clientes, conversaciones, productos, pedidos y citas marcados «(ejemplo)») para recorrer el panel con movimiento. No reciben avisos y los borras con un botón sin tocar tus datos reales.",
      "¿Algo no funciona o tienes una idea? Usa «Enviar comentario» en el menú de la izquierda: lo leemos todo.",
    ],
    links: [{ href: "/datos", label: "Importar y exportar" }],
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
      "Cambia tu contraseña cuando quieras: pedimos la actual (y el código de tu app si tienes la verificación en dos pasos) y cerramos tu sesión en los otros dispositivos.",
      "Activa la verificación en dos pasos con una app autenticadora y guarda tus códigos de recuperación en un lugar seguro.",
      "Si alguien entra a tu cuenta desde un navegador o dispositivo que no habíamos visto, te llega un correo. Si no fuiste tú, cambia tu contraseña de inmediato.",
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
    "/panel": "inicio", "/whatsapp": "whatsapp", "/agente": "asistente", "/conocimiento": "conocimiento", "/conversaciones": "conversaciones", "/clientes": "clientes", "/difusiones": "difusiones", "/reportes": "reportes", "/horario": "horario", "/tienda": "tienda",
    "/hoy": "hoy", "/agenda": "agenda", "/catalogo": "catalogo", "/pedidos": "pedidos", "/simulador": "probar", "/copiloto": "copiloto",
    "/automatizaciones": "automatizaciones", "/conexiones": "conexiones", "/equipo": "equipo", "/datos": "datos", "/plan": "plan", "/cuenta": "cuenta", "/seguridad": "seguridad", "/admin": "administracion", "/soporte": "soporte",
  };
  const id = map[seg];
  return id ? (HELP_TOPICS.find((t) => t.id === id) ?? null) : null;
}
