# Paso 45 — Pruebas en un navegador de verdad (Playwright)

Hasta ahora las pruebas revisaban el código y la base de datos, pero nadie había **abierto la app en un navegador**. Este paso agrega recorridos automáticos que abren Chromium, se registran, hacen clic y toman capturas de pantalla.

## Qué recorren (8 pruebas)
1. Registro → bienvenida → «Lo haré después» → panel con su menú.
2. Cerrar sesión y volver a entrar.
3. Cargar datos de ejemplo y verlos en Conversaciones, Clientes, ficha, Pedidos, Reportes y Hoy.
4. Cobro: marcar un pedido como pagado con forma de pago y deshacerlo.
5. Horario de atención: guardar y comprobar que se recuerda.
6. Botón «Enviar comentario».
7. Catálogo público: publicar, armar un pedido sin sesión desde un celular, ver el enlace de WhatsApp y despublicar (404).
8. Celular: que el panel y las conversaciones no se desborden.

Cada prueba crea su propio negocio, así que se pueden repetir sin limpiar nada. También fallan si el navegador escribe errores en la consola.

## Fallos reales que encontraron (ya corregidos en este paso)
- «Lo haré después» te devolvía a la bienvenida (ahora carga /panel completo).
- El botón «Enviar comentario» del menú tenía texto oscuro sobre fondo oscuro.
- En el catálogo público del celular los botones − y + eran invisibles, y «Cerrar» en el cuadro de comentarios también; el cuadro además salía pegado a una esquina.

## Cómo correrlas en tu computadora
1. `bash aplicar-paso-45.sh` y luego `npm install` (instala `playwright`).
2. Una sola vez: `npx playwright install chromium` (descarga el navegador, ~150 MB; en WSL puede pedir `npx playwright install-deps chromium`).
3. Enciende la app con base de datos, Redis y migraciones: `npm run dev:all` en una terminal.
4. En otra terminal: `npm run test:e2e`.
   - Otra dirección: `E2E_BASE_URL=http://localhost:3000 npm run test:e2e`.
5. Las capturas quedan en `e2e/capturas/` (no se suben a git). Ábrelas: son la forma más rápida de ver la app «con ojos de usuario».

## Notas
- Con `npm run dev` el navegador a veces recarga la página en bucle al primer arranque; si te pasa, espera a que termine de compilar o prueba contra `npm run build && npm start`.
- No usa WhatsApp, Resend ni Gemini reales: el registro no necesita correo y los mensajes son datos de ejemplo.
- Estas pruebas no están dentro de `npm test` a propósito (son lentas y necesitan la app encendida).
