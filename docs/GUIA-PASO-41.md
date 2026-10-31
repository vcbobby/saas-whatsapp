# Paso 41 — Horario de atención y aviso fuera de horario

## Qué hace
- Página **/horario** (dueño y administradores): defines qué días y horas hay personas atendiendo (hasta 3 tramos por día), la zona horaria y un texto extra opcional (por ejemplo un teléfono para urgencias).
- **El asistente sigue respondiendo a toda hora.** El horario solo cambia lo que pasa cuando el cliente **pide una persona** (o el asistente decide pasarlo a una): la conversación pasa igual a tu equipo, y al mensaje se le añade, por ejemplo: «Ahora estamos fuera de horario; una persona te atenderá mañana a las 8:00 a. m. Urgencias: 0412-…».
- El asistente conoce el horario (y si ahora hay o no personas atendiendo), así que no inventa otro si el cliente pregunta.
- Es independiente del horario de la **agenda** (cuándo se dan citas). Comparten solo la zona horaria: cambiarla aquí la cambia en la agenda.

## Cómo aplicarlo
1. `bash /ruta/aplicar-paso-41.sh` desde la raíz del proyecto.
2. `npm run db:migrate` (migración 0051).
3. `npm run typecheck && npm run lint && npm test`
4. Reinicia `npm run dev:all`.

## Cómo probarlo a mano
1. En /horario abre solo un tramo que NO incluya la hora actual, marca la casilla y guarda (abajo verás cómo sonaría el aviso).
2. En /simulador escribe «quiero hablar con una persona»: debe responder y añadir el aviso de fuera de horario.
3. Cambia el tramo para que incluya la hora actual: ya no debe añadir el aviso.

## Notas técnicas
- Tablas `business_hours` (tramos, sin cruces por regla de la base) y `business_hours_settings` (activado, texto extra); ambas con aislamiento por negocio y se incluyen en la descarga de datos.
- El aviso se añade en `src/lib/agent/run.ts` justo antes de reservar el mensaje saliente, solo si hay traspaso; si leer el horario falla, el mensaje sale igual sin aviso.
- Los tramos son por día de la semana (no cruzan la medianoche: para atender de noche usa 18:00–24:00 y 00:00–02:00 del día siguiente).
- No hay feriados todavía: para un día especial, desmarca la casilla o cambia el tramo ese día.

## Qué NO está verificado
- El comportamiento con WhatsApp real (en el sandbox el envío está simulado).
- El aspecto de la página con datos reales en un navegador.
- Cómo responde el modelo real (Gemini) a la nueva sección del horario en su instrucción; solo se comprobó que la sección se incluye.
