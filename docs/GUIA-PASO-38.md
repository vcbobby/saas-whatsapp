# Paso 38 — Bandeja mejorada

Hay **una migración nueva (0048)**: `npm run db:migrate`. Reinicia también el worker (`npm run dev:all`): el aviso por correo lo envía él.

## 1. Notas privadas en la conversación
Debajo de la caja de respuesta hay «Nota privada». Se guarda dentro de la conversación (en la línea de tiempo, con un recuadro punteado y el nombre de quien la escribió) y **solo la ve tu equipo: nunca se envía al cliente**. Pueden escribirla el dueño, los administradores y los agentes.
- Hasta 2000 caracteres. No se pueden editar ni borrar desde la aplicación (quedan como constancia).
- Se muestran las últimas 50 de cada conversación.
- Van incluidas en «Descargar mis datos».
- Aparte sigue existiendo la nota de la **ficha de cliente** (paso 37): esa es una sola por persona y dura para siempre; las notas privadas son por conversación.

## 2. Reparto automático (Equipo → «Reparto de conversaciones»)
Cuando el asistente pasa una conversación a una persona (el cliente la pidió, se llegó a un tope, hubo un fallo…), se asigna sola:
- **A mano** (como era hasta ahora): nadie se asigna solo.
- **Por turnos**: a quien hace más tiempo que no le tocó una.
- **A quien tenga menos**: a quien atienda menos conversaciones en ese momento (si empatan, por turnos).
- Se reparte entre los **agentes**; si el negocio no tiene agentes, entre todo el equipo (dueño y administradores).
- La persona asignada ya puede responder desde la bandeja sin pulsar «Tomar». Los demás ven «la atiende fulano». Cualquiera puede tomarla con «Tomar la conversación».
- Si alguien la toma a propósito, no se reasigna. «Devolver al asistente» la libera.
- Sin tener horario ni «disponible/no disponible» por persona todavía: el reparto no sabe si alguien está de vacaciones. Quita a esa persona del equipo o cambia a «A mano» mientras tanto.

## 3. Avisos
- **Por correo**: cuando una conversación pasa a una persona, le llega un correo a quien quedó asignado; si nadie (reparto a mano), al dueño y a los administradores. Se puede apagar en el mismo recuadro. El worker los envía en unos 15 segundos. Máximo un correo por conversación y persona. No se manda si ya la atendieron o la cerraron antes de que el worker la revisara.
- **En la bandeja**: suena un pitido corto cuando aparece una conversación nueva que espera una respuesta, y el título de la pestaña muestra `(n)`. El botón «Sonido» lo apaga (se recuerda en ese navegador). Los navegadores no dejan sonar hasta que hayas hecho clic en la página al menos una vez.
- Necesita que el correo esté de verdad configurado (en tu PC solo aparece en `/dev/correos`).

## Qué NO incluye (todavía)
- **Horario de atención y mensaje automático fuera de horario**: toca el envío de mensajes a clientes; irá aparte.
- Disponibilidad por persona, y avisos por WhatsApp al equipo.
- Etiquetas automáticas en las conversaciones («pidió asesor», «respondió la IA»): hoy esa información sale en el motivo que ves en cada conversación y en «Hoy».
