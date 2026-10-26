# Paso 29 — Conectar WhatsApp fácil (asistente) y «con un clic» (Embedded Signup)

## 1. Qué hay de nuevo (ya funciona hoy)
En **WhatsApp**:
- Un **asistente de 4 pasos** para conectar el número a mano (dónde está cada dato en Meta).
- La app **limpia lo que pegas** (comillas, «Bearer», espacios) y **te dice qué pasó** si algo falla: «pegaste el teléfono en vez del ID», «el token venció (dura ~24 h)», «falta el permiso whatsapp_business_messaging», etc.
- Botón **Comprobar conexión**: confirma que Meta sigue aceptando el token, muestra la calidad del número y avisa si el token vence pronto (necesita `META_APP_ID` en `.env.local`; es el «App ID» de Meta → Configuración → Básica).
- Botón **Enviar prueba**: manda un mensaje a tu teléfono (si no hay conversación abierta usa la plantilla `hello_world`). Máx. 5 pruebas por hora.

> **Importante:** conectar «a mano» solo funciona con **tu propia app de Meta** (la que tiene tu `WHATSAPP_APP_SECRET`). Sirve para ti y para pruebas. Para que **tus clientes** se conecten sin tocar tokens, hace falta la conexión con un clic (sección 2), que requiere aprobación de Meta.

## 2. Conexión «con un clic» (Embedded Signup) — código listo, APAGADO
El cliente pulsa **Conectar con Facebook**, elige o crea su cuenta de WhatsApp Business y listo: tú recibes el número y un token permanente sin que el cliente copie nada. El código ya está en la app (botón, SDK de Facebook, intercambio del código, registro del número y suscripción a mensajes). **No se muestra hasta que lo enciendas** porque Meta primero debe aprobarte como **Tech Provider**.

### 2.1. Qué exige Meta (verifícalo en su pantalla: cambian a menudo)
Fuente: documentación de Meta «Get started for Tech Providers».
1. **App de Meta** con el caso de uso WhatsApp y un **portafolio comercial** (business portfolio).
2. **Verificación del negocio** (Business Verification): nombre legal, dirección, teléfono, correo, sitio web y, si no te encuentran, documentos. **Debe estar aprobada antes de pedir la revisión.**
3. En Configuración básica de la app: **ícono, política de privacidad (URL pública) y categoría**.
4. **Dominio propio** con tu app en línea y una página de privacidad (por eso este paso espera a que elijas nombre y dominio).
5. **Revisión de la app (App Review)** con **acceso avanzado** a:
   - `whatsapp_business_messaging`
   - `whatsapp_business_management`
6. **Dos videos** para la revisión: (a) un mensaje creado y enviado desde tu app y recibido en WhatsApp; (b) tu app creando una **plantilla de mensaje**. (Meta acepta como alternativa grabaciones del cURL de «API Setup» y de WhatsApp Manager creando una plantilla.) ➜ La app crea plantillas en el paso siguiente del plan; hasta entonces graba con WhatsApp Manager.
7. **Facturación:** cada cliente que conectes debe agregar una **tarjeta** a su cuenta de WhatsApp Business (Meta le cobra a él las conversaciones).
8. Mientras tu negocio no esté verificado, Meta limita cuántos clientes puedes incorporar (del orden de 10 por semana; con verificación sube a cientos). Confirma las cifras actuales en el panel.

### 2.2. Paso a paso cuando ya tengas dominio y la app en línea
1. developers.facebook.com → tu app → **Configuración de la app → Básica**: ícono, URL de política de privacidad, categoría, dominios de la app (tu dominio).
2. **Business Settings → Seguridad → Centro de seguridad → Verificación de la empresa** → completa y espera la aprobación.
3. **Webhooks** (WhatsApp → Configuración): callback `https://TU-DOMINIO/api/webhooks/whatsapp`, verify token = tu `WHATSAPP_VERIFY_TOKEN`, suscribe el campo **messages**.
4. **Inicio de sesión de Facebook para empresas** (Facebook Login for Business) → **Configuraciones → Crear** a partir de la plantilla **«WhatsApp Embedded Signup»** (usa la versión más reciente: **v4**; las v2/v3 se retiran el 15-oct-2026). Copia el **Configuration ID**.
5. En esa configuración/en «Ajustes del cliente de OAuth» agrega tu dominio como **dominio permitido** y activa **«Inicio de sesión con el SDK de JavaScript»**.
6. **Revisión de la app** → pide acceso avanzado a los dos permisos → sube los 2 videos y la descripción de uso → **Begin App Review**. Tarda de días a semanas; si te rechazan, el mensaje dice qué falta.
7. Aprobado → en tu `.env.production` agrega:
   ```
   EMBEDDED_SIGNUP_ENABLED=true
   META_APP_ID=tu_app_id
   META_ES_CONFIG_ID=tu_configuration_id
   ```
   (`WHATSAPP_APP_SECRET` y `WHATSAPP_VERIFY_TOKEN` ya los tienes.) Reinicia la app: en **WhatsApp** aparece el botón **Conectar con Facebook**.
8. Prueba con tu propio número nuevo antes de ofrecerlo a clientes.

### 2.3. Qué hace el servidor al terminar (para tu información)
Cambia el código de un solo uso por el token del cliente (el secreto de la app viaja por POST, nunca en la dirección) → comprueba que ese token controla el número → suscribe tu app a los mensajes de su cuenta → registra el número en la API de la nube → guarda el token **cifrado** junto con el ID de su cuenta (WABA). Si algo falla, no se guarda nada.
Al encender la bandera, la política de seguridad de la página permite **solo** `connect.facebook.net`, `facebook.com` y `graph.facebook.com`, y las ventanas emergentes (necesarias para la ventana de Facebook). Apagada, todo sigue cerrado.

## 3. Cómo probar el asistente manual hoy
1. WhatsApp → sigue los 4 pasos del asistente con tu número de prueba (guía del paso 25, parte B).
2. Pega **mal a propósito** el teléfono en vez del ID, y luego un token viejo: verás los mensajes de ayuda.
3. Conecta bien → **Comprobar conexión** → pon tu teléfono → **Enviar prueba**.

## 4. Pendiente de este tema
- **Plantillas de WhatsApp** (mensajes fuera de las 24 h): sigue en el plan; también las pide Meta para la revisión.
- La **renovación automática** de tokens temporales no existe (Meta no la ofrece): por eso la app avisa cuándo vencen y la conexión con un clic entrega tokens permanentes.
