# Paso 48 — Se ve siempre quién responde: «🤖 Asistente / 🧑 Persona»

## Qué cambia en Conversaciones
- **En la lista**, cada chat muestra una etiqueta: **🤖 Asistente**, **🧑 Persona** o **Cerrada**. Antes solo se veía cuando estaba con una persona.
- **Arriba de cada chat** hay un interruptor de dos botones:
  - **🤖 Asistente**: el asistente le responde solo al cliente.
  - **🧑 Persona**: el asistente se pausa y escribes tú (aparece el cuadro para responder).
  Pulsa el otro botón para cambiar; es lo mismo que antes hacían «Tomar la conversación» y «Devolver al asistente», pero en un solo lugar y con el estado a la vista.
- Debajo del interruptor, una línea explica qué está pasando («El asistente está en pausa: contestas tú…»).
- Si la conversación la atiende **otra persona de tu equipo**, el interruptor muestra «Persona» y aparece el botón **«Tomar la conversación»** para quitársela.
- No cambia nada del funcionamiento interno: el asistente sigue pasando solo a «Persona» cuando el cliente lo pide, y se devuelve igual que siempre.

## Prueba en navegador
Se agregó un recorrido (`npm run test:e2e` ya corre 10) que abre un chat de ejemplo, pulsa «Persona», comprueba que el asistente queda en pausa, y lo devuelve con «Asistente». Deja la captura `17-interruptor-persona.png`.

## Para aplicarlo
1. `bash aplicar-paso-48.sh` (no necesita migración).
2. `npm run typecheck && npm run lint && npm test`
3. Con la app encendida: `npm run test:e2e`
