# Paso 33 — Aviso «un cliente lleva esperando a una persona»

## 1. Para qué sirve
Cuando el asistente pasa un chat a una persona («quiero hablar con alguien»), el cliente queda esperando. Si nadie contesta, el cliente se enfría. Esta regla te avisa **antes** de que eso pase.

## 2. Cuándo se activa
Una conversación **en manos de una persona**, cuyo **último mensaje es del cliente**, sin **ninguna respuesta** (ni de la persona ni del asistente) desde hace los minutos que elijas.
- No se activa si la lleva el asistente (él contesta solo), si está cerrada, o si alguien ya respondió.
- No es retroactivo: solo cuenta mensajes posteriores a la creación de la regla y de los últimos 7 días.
- Si el cliente vuelve a escribir y otra vez nadie contesta, avisa **de nuevo** (otro mensaje, otro aviso). Nunca dos veces por el mismo mensaje.
- El reloj del worker revisa cada ~30 s, así que el aviso puede tardar hasta medio minuto más de lo elegido.

## 3. Qué puede hacer
- **Crear una tarea** en «Hoy» (con prioridad y plazo), por ejemplo «Responder a {cliente}: lleva esperando».
- **Avisar a una app conectada** (Telegram, Slack, Discord, Zapier…): te llega al celular aunque no tengas el panel abierto.
- No admite «avisar al cliente por WhatsApp»: lo que falta es que una persona conteste.

## 4. Cómo crearla
Automatizaciones → **Recetas rápidas → «Cliente esperando a una persona (30 min)»** (tarea urgente con plazo de 15 min). Para recibirla en Telegram: crea otra regla con el mismo aviso, acción **«Avisar a una app»** y elige tu conexión.

## 5. Qué NO está verificado
Se probó la lógica completa en la base de datos (tiempos, respuesta previa, estados, repetición, aislamiento entre negocios). No requiere Meta, así que no hay parte sin probar, salvo el aviso real a Telegram/Slack, que sigue la misma ruta del paso 28 (no se puede probar sin internet desde el entorno de desarrollo).
