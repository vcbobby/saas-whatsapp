# Paso 25 — IA real (Gemini gratis) y WhatsApp de prueba, desde tu computadora

Al terminar tendrás: el asistente respondiendo con IA real a mensajes que envíes desde tu teléfono al **número de prueba de Meta**, todo corriendo en tu PC y conectado a internet con un **túnel gratuito de Cloudflare**.

> **Importante (privacidad):** en el plan **gratuito** de Gemini, Google puede usar lo que envías para mejorar sus productos. Úsalo **solo con datos de prueba**, nunca con mensajes de clientes reales. Para clientes reales se usa una clave con facturación activada (plan de pago), donde eso no ocurre. Cambiar de una clave a otra es solo cambiar `LLM_API_KEY` en `.env.local`.

---

## Parte A — Clave de Gemini (gratis, sin tarjeta)

1. Entra a **https://aistudio.google.com** con tu cuenta de Google.
2. Menú izquierdo → **Get API key** (Obtener clave de API) → **Create API key**. Si te pide proyecto, elige **Create API key in new project**.
3. Copia la clave (empieza con `AIza…`). Trátala como una contraseña: no la pegues en chats, capturas ni GitHub.
4. Abre `.env.local` de tu proyecto y agrega (o cambia) estas líneas:
    ```
    LLM_PROVIDER=gemini
    LLM_MODEL=gemini-3.8-flash
    LLM_API_KEY=PEGA_AQUI_TU_CLAVE
    ```
    (`gemini-3.5-flash-lite` tiene capa gratuita y es muy barato después. Si Google cambia los nombres, mira la lista de modelos gratis en https://ai.google.dev/gemini-api/docs/pricing y cambia `LLM_MODEL`.)
5. Comprueba que funciona:
    ```
    npm run ai:check
    ```
    Debe decir `✔ La IA responde correctamente.` con una frase en español. Si falla, el mensaje te dice qué revisar (clave, nombre del modelo o límite del plan gratis).
6. Reinicia `npm run dev:all`. Prueba el asistente en **/simulador** (solo en tu PC): ahora responde la IA de verdad, no el texto fijo.
7. En la web, como súper admin → **Costos**: de momento deja los precios en 0 (plan gratis). Cuando uses plan de pago, pon los precios por millón de tokens del modelo (para `gemini-3.1-flash-lite`: 0.25 de entrada y 1.50 de salida; verifícalos en la página de precios) y un presupuesto mensual: el sistema se frena solo al llegar.

Límites del plan gratis: tiene un máximo de mensajes por minuto y por día. Si lo alcanzas verás el error 429; espera y reintenta. Para pruebas normales alcanza.

---

## Parte B — WhatsApp de prueba en Meta (gratis)

> Meta cambia sus pantallas de vez en cuando; si algún nombre no coincide, busca el equivalente.

1. Necesitas una cuenta de **Facebook** y entrar a **https://developers.facebook.com** (acepta ser desarrollador si te lo pide).
2. **My Apps → Create App**. Nombre y correo → caso de uso **"Connect with customers through WhatsApp"** (Conectar con clientes a través de WhatsApp) → crea o elige un **portafolio comercial** (Business portfolio) → **Create app**.
3. Te lleva a **WhatsApp → Quickstart / API Setup**. Pulsa **Start using the API**. Crea o elige una cuenta de WhatsApp Business (te da un **número de prueba** gratis).
4. En **API Setup** anota:
    - **Phone number ID** (el "ID del número de teléfono" del número de prueba). **No es el número de teléfono**, es un código largo.
    - **Generate access token** → es un token **temporal** (dura poco, normalmente unas 24 horas; cuando caduque, genera otro y vuelve a conectar el número).
5. En ese mismo panel, en **"To"** agrega **tu teléfono personal** como destinatario de prueba (te llega un código por WhatsApp para verificarlo). Con el número de prueba solo puedes hablar con los números que agregues (hay un máximo pequeño).
6. **Clave secreta de la app (App Secret):** menú **App settings → Basic → App secret → Show**. Pon en `.env.local`:
    ```
    WHATSAPP_APP_SECRET=la_clave_secreta_de_32_caracteres
    WHATSAPP_VERIFY_TOKEN=inventa-un-texto-largo-y-aleatorio-de-mas-de-24-caracteres
    ```
    (`WHATSAPP_VERIFY_TOKEN` lo inventas tú; luego lo pegas igual en Meta. No uses el token de acceso como App Secret: son cosas distintas.)
7. Reinicia `npm run dev:all`.

### Token que no caduca (cuando quieras pruebas de varios días)

**Business Settings** (Configuración del negocio) → **System users** → **Add** → crea uno (rol Admin) → **Assign assets**: tu app (**Manage app**, control total) y tu cuenta de WhatsApp (**Manage WhatsApp Business accounts**, control total) → **Generate token**, elige tu app y marca los permisos `whatsapp_business_messaging`, `whatsapp_business_management` (y `business_management`) → copia el token (no vence). Ese token lo pegas en lugar del temporal.

---

## Parte C — Túnel gratuito de Cloudflare (para que Meta llegue a tu PC)

Meta necesita una dirección **https pública** para avisarte de cada mensaje.

1. Instala `cloudflared`:
    - **Windows (PowerShell):** `winget install --id Cloudflare.cloudflared` (cierra y abre la terminal después)
    - **Ubuntu/WSL:** descarga el paquete `.deb` de https://github.com/cloudflare/cloudflared/releases (el de `amd64`) y `sudo dpkg -i cloudflared-linux-amd64.deb`
2. Con tu app corriendo (`npm run dev:all`, puerto 3000), abre **otra terminal** y ejecuta:
    ```
    cloudflared tunnel --url http://localhost:3000
    ```
    Verás una dirección como `https://palabras-al-azar.trycloudflare.com`. **Déjala abierta**: si cierras esa ventana, el túnel se apaga. Cada vez que lo enciendas la dirección **es otra**.
3. **No cambies `APP_URL`**: sigue en `http://localhost:3000` y tú sigues usando la app en `localhost:3000`. El túnel solo se usa para que Meta entregue mensajes.
4. Prueba el túnel (debe responder algo, no error de conexión): abre `https://TU-DIRECCION.trycloudflare.com/api/health` → `{"status":"ok"}`.

---

## Parte D — Conectar Meta con tu app

1. En Meta: tu app → **WhatsApp → Configuration** (Configuración) → sección **Webhook** → **Edit**:
    - **Callback URL:** `https://TU-DIRECCION.trycloudflare.com/api/webhooks/whatsapp`
    - **Verify token:** el mismo `WHATSAPP_VERIFY_TOKEN` de tu `.env.local`
    - **Verify and save**. Si falla: el túnel está apagado, la URL tiene un error o el token no coincide.
2. En esa misma sección → **Webhook fields → Manage** → suscríbete al campo **`messages`** (Subscribe).
3. En tu app (en `http://localhost:3000`): entra como dueño del negocio → **WhatsApp** → pega el **ID del número de teléfono** y el **token de acceso** → **Conectar**. (Debe decir que conectó y mostrar el número.)
4. Prueba de punta a punta: **desde tu teléfono** (el que agregaste en el paso B5) escribe un mensaje al **número de prueba** de Meta. Debes ver:
    - el chat aparece en **Conversaciones**,
    - y el asistente responde en tu teléfono (el worker debe estar encendido: `npm run dev:all` lo incluye).
5. Antes de probar con tu teléfono, activa el asistente en **Mi asistente**, ponle nombre y unas instrucciones, y sube algún documento en **Conocimiento** si quieres que conteste sobre tu negocio.

### Si algo no funciona

| Síntoma                                     | Qué revisar                                                                                                                                                                                                                 |
| ------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Meta no verifica el webhook                 | ¿El túnel sigue abierto? ¿La URL termina en `/api/webhooks/whatsapp`? ¿El verify token es idéntico?                                                                                                                         |
| Escribo y no aparece nada en Conversaciones | ¿Suscrito a `messages`? ¿El teléfono está en la lista "To"? Prueba `node --env-file=.env.local scripts/probar-webhook.mjs https://TU-DIRECCION.trycloudflare.com`: si esto funciona, el problema está en Meta, no en tu app |
| Aparece el mensaje pero no responde         | ¿Está activado el asistente? ¿`npm run ai:check` da ✔? ¿Corre el worker? Mira la terminal de `dev:all`                                                                                                                      |
| "Meta no aceptó ese token" al conectar      | El token temporal caducó (genera otro) o el ID del número no es el correcto                                                                                                                                                 |
| Dejó de llegar todo de un día para otro     | El túnel cambió de dirección o el token temporal caducó                                                                                                                                                                     |
| Error 429 / límite                          | Se agotó el plan gratis de Gemini por ahora; espera                                                                                                                                                                         |

Recordatorio de WhatsApp: tu negocio solo puede responder **dentro de las 24 horas** siguientes al último mensaje del cliente (fuera de ese plazo hacen falta plantillas aprobadas, que todavía no están hechas).
