# Paso 43 — Catálogo público con enlace y código QR

## Qué hace
- Página **/tienda** («Catálogo público», dueño y administradores, si tu plan incluye catálogo): escribes el WhatsApp al que quieres que te escriban (con código de país, sin el 0 inicial), una presentación opcional y marcas «Mostrar mi catálogo en una página pública».
- Se publica **/c/<tu-negocio>**: tus productos activos con precio, descripción y «Agotado» cuando no queda. **No se muestra tu inventario** (cantidades) ni productos inactivos.
- El cliente elige cantidades y pulsa «Pedir por WhatsApp»: se abre WhatsApp con el pedido ya escrito (productos, cantidades y total aproximado) hacia tu número. Llega como un mensaje normal a tu bandeja; el asistente o tu equipo lo toma desde ahí.
- Enlace para copiar y **código QR** (SVG, descargable) para imprimir.
- Apagar la casilla quita la página al instante (404). Un negocio suspendido, con la prueba vencida o con la eliminación pedida tampoco se muestra.
- La dirección usa `APP_URL` del servidor: cuando tengas dominio, los enlaces y el QR salen con él (hay que volver a descargar el QR si cambias de dominio).

## Cómo aplicarlo
1. `bash /ruta/aplicar-paso-43.sh` desde la raíz del proyecto.
2. `npm run db:migrate` (migración 0053).
3. `npm run typecheck && npm run lint && npm test`
4. Reinicia `npm run dev:all`.

## Cómo probarlo a mano
1. Con unos productos en el catálogo (o los datos de ejemplo), entra a /tienda, pon tu número y publica.
2. Abre el enlace en otra ventana (sin sesión): elige productos y mira el mensaje que arma WhatsApp.
3. Escanea el QR con tu teléfono (en local solo funcionará si tu teléfono ve tu computadora; con dominio real, sí).

## Notas técnicas
- Tabla `public_catalog` (activado, teléfono, presentación) con aislamiento por negocio. La página pública busca el negocio con la función `public_catalog_lookup(slug)`, que solo devuelve datos si está publicado y al día; la aplicación no puede leer esa tabla de otra forma.
- El proxy responde 404 real (no «200 con aviso») a catálogos inexistentes o apagados.
- Todo texto de tus productos se escapa al mostrarse (no se interpreta HTML).
- El pedido NO se guarda en el sistema hasta que el cliente escriba por WhatsApp: es un atajo para que el mensaje llegue completo.

## Qué NO está verificado
- Abrir WhatsApp real desde el enlace (en el sandbox solo se comprobó el texto y la dirección `wa.me`).
- Escanear el QR con un teléfono (se comprobó que se genera un SVG válido para el enlace).
- Aspecto en un celular real; el diseño es sencillo y de una columna en pantallas pequeñas pero no se vio en un navegador.
- Posicionamiento en buscadores (no hay mapa del sitio ni datos estructurados todavía).
