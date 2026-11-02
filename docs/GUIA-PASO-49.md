# Paso 49 — ¿De dónde llegó cada cliente? (anuncios de «Click to WhatsApp»)

## Qué hace
Cuando alguien te escribe por primera vez tocando un **anuncio de Facebook/Instagram con botón de WhatsApp** (o una publicación), Meta avisa de dónde vino. Ahora la plataforma lo guarda en la ficha del cliente y te lo muestra:

- **En la ficha del cliente**: «📣 Llegó desde un anuncio: «Gorras 2x1»» con un enlace «Ver» al anuncio.
- **En Conversaciones**: la misma línea, debajo del teléfono del chat.
- **En Reportes**: una sección **«¿De dónde llegaron tus clientes nuevos?»** con cuántos llegaron de cada anuncio o publicación (los 5 que más trajeron), y el resto escribió directo. El resumen semanal por correo también lo menciona.

## Reglas
- Se guarda el **primer** origen y no se cambia después. Si alguien ya te había escrito «directo» y luego te escribe desde un anuncio, se le anota ese anuncio.
- Solo funciona con anuncios que **abren WhatsApp** («Click to WhatsApp») o publicaciones con botón de WhatsApp. Un enlace normal o un código QR **no** trae origen: esos clientes aparecen como «escribió directo».
- Lo que manda Meta se limpia antes de guardarlo: el enlace solo se acepta si empieza por https y los textos se recortan.
- Los **datos de ejemplo** incluyen tres clientes con origen (dos de un anuncio de ejemplo y uno de una publicación), para que veas cómo luce el reporte.
- Es una migración nueva (0056); no cambia nada de lo que ya tenías.

## Arreglo de paso: botones que se veían como texto
Al revisar las capturas de Reportes vi que «Enviarme este resumen ahora» y «Últimos 30 días» parecían texto suelto: usaban un estilo de botón (`btn-secondary`) que **nunca se definió**. Pasaba en 8 botones: Reportes, «Copiar enlace» y «Descargar QR» del catálogo público, «Borrar datos de ejemplo» y «Editar/Borrar/Cancelar» de la base de conocimiento. Ahora el estilo existe (borde y texto del mismo color que el fondo donde esté, sirve en oscuro y en claro) y las pruebas en navegador revisan que ningún botón quede sin borde ni fondo.
(El instalador agrega el estilo al final de `src/app/globals.css` sin reemplazar el archivo.)

## Qué NO verifiqué (importante)
Nunca vi un «referral» real de Meta: las pruebas usan el formato que dice la documentación de Meta. Cuando tengas WhatsApp conectado, haz una prueba real: crea un anuncio «Click to WhatsApp» de poco presupuesto (o usa uno existente), tócalo desde otro teléfono, escribe, y mira la ficha del cliente. Si Meta manda otros campos o nombres, avísame y lo ajusto.

## Para aplicarlo
1. `bash aplicar-paso-49.sh`
2. `npm run db:migrate` (migración 0056)
3. `npm run typecheck && npm run lint && npm test`
4. Reinicia `npm run dev:all`.
