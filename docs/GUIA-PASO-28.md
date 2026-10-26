# Paso 28 — Conexiones por app y recetas de automatización

## Qué hay de nuevo
- **Conexiones → «Conectar una app»**: asistente de pocos pasos para Telegram, Discord, Slack, Zapier, Make, n8n y (para programadores) el webhook firmado de siempre.
- Al conectar, el sistema **manda solo un mensaje de prueba**. También puedes pulsar «Enviar prueba» cuando quieras.
- Los enlaces y tokens de Telegram/Discord/Slack se guardan **cifrados** y nunca se vuelven a mostrar.
- **Automatizaciones**: 8 recetas listas para usar, dos avisos nuevos (**cliente nuevo** y **producto con poco stock/agotado**) y una acción nueva: **avisarme en una app conectada**.

## Cómo probarlo (todo gratis)
1. **Telegram** (el más fácil): en Telegram busca `@BotFather` → `/newbot` → copia el token. En la app: Conexiones → Conectar una app → Telegram → pega el token → escríbele «hola» a tu bot → **Buscar mi chat** → elige → **Conectar y enviar prueba**. Debe llegarte «✅ ¡Conexión lista!».
2. **Discord**: canal → ⚙ → Integraciones → Webhooks → Nuevo → copiar URL → pegar en la app.
3. **Receta**: Automatizaciones → «Avisarme en mi app cuando entre un pedido» → elige tu app → Crear regla. Crea un pedido de prueba (Catálogo → Pedidos) y te llega el aviso.
4. **Stock**: en Catálogo → Inventario deja un producto con stock 12 y mínimo 10; réstale 3 → llega «⚠️ Poco stock». Si llega a 0 → «❌ agotado». No se repite mientras siga bajo.

## Límites y notas
- Máximo 10 conexiones por negocio. Una conexión que falla 10 veces seguidas se desactiva sola y deja una tarea en «Hoy».
- Si borras una app que usa una regla, la regla queda «sin destino» (la ves al editarla); no se rompe nada.
- Telegram: si el bot ya está conectado a otro programa (webhook activo), crea un bot nuevo para esta conexión.
- Slack y Discord: el nombre del cliente nunca puede mencionar a todo el canal (se neutraliza `@everyone` / `<!channel>`).
- Zapier/Make/n8n reciben el aviso en JSON completo (con firma `X-Webhook-Signature`, que pueden ignorar).
- No incluido todavía: «conversación sin respuesta» (aviso por tiempo) y Google Sheets/Calendar con un clic (necesitan dominio propio y verificación de Google); mientras tanto Zapier/Make conectan con Google Sheets sin programar.
