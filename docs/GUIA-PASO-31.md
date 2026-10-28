# Paso 31 — Plantillas de WhatsApp (escribir pasadas las 24 horas)

## 1. Por qué existen
WhatsApp solo deja escribirle a un cliente con **texto libre** durante las **24 horas** siguientes a su último mensaje. Pasado ese tiempo, el único camino es una **plantilla**: un mensaje con texto fijo y huecos ({{1}}, {{2}}…) que **Meta revisa y aprueba** antes de poder usarlo.

## 2. Qué hay de nuevo
- Pantalla **WhatsApp → Plantillas de mensaje** (`/whatsapp/plantillas`):
  - Guardar el **ID de la cuenta de WhatsApp Business (WABA)**. La app comprueba con Meta que ese ID contenga tu número conectado.
  - **Crear** una plantilla (con 4 ejemplos para empezar: recordatorio de cita, pedido listo, seguimiento, oferta). La app valida las reglas de Meta que se pueden revisar antes (variables en orden, sin empezar/terminar con variable, un ejemplo por variable…) y la envía a revisión.
  - **Actualizar desde Meta**: trae el estado (en revisión, aprobada, rechazada, pausada) y las plantillas que hayas creado directamente en el panel de Meta.
  - **Borrar** (también en Meta).
- **Bandeja**: si pasaron más de 24 h, en lugar de «no se puede» aparece un selector: eliges una plantilla **aprobada**, llenas los datos, ves la vista previa y **Enviar plantilla**. El mensaje queda en la conversación con su texto final. Un doble clic no la envía dos veces.

## 3. Paso a paso en Meta
1. Entra a **developers.facebook.com → tu app → WhatsApp → Configuración de la API**. Junto a tu número aparece **«WhatsApp Business Account ID»** (solo dígitos). Cópialo.
2. En la app: **WhatsApp → Plantillas de mensaje →** pega ese ID → **Guardar**.
3. **El token necesita el permiso `whatsapp_business_management`** además de `whatsapp_business_messaging`. Si al guardar o crear sale un error de permisos, genera un token nuevo con los dos permisos y vuelve a conectar el número.
4. Crea una plantilla (o elige un ejemplo) → **Enviar a revisión**. Meta suele responder en minutos, a veces horas. Pulsa **Actualizar desde Meta**.
5. Cuando diga **Aprobada**, ya aparece en la bandeja.

### Consejos para que Meta la apruebe
- Usa **Utilidad** para citas, pedidos y avisos que el cliente espera; **Marketing** para promociones. Si pones marketing como utilidad, Meta la reclasifica o la rechaza.
- Texto claro, sin pedir datos sensibles, sin enlaces acortados, sin mayúsculas gritando.
- Los ejemplos deben parecer datos reales.
- Una plantilla rechazada no se edita: se borra y se crea otra con el texto corregido (con otro nombre si Meta dice que el anterior sigue «en borrado»).

## 4. Costos
Meta cobra por las conversaciones/mensajes con plantilla a la cuenta de WhatsApp Business del negocio (necesita un método de pago en Meta → Facturación; si falta, el envío falla con un aviso claro). Las tarifas y qué es gratis dentro de la ventana de 24 h **cambian**: confírmalo en la página de precios de Meta.

## 5. Límites de esta versión
- Solo plantillas de **texto** (cuerpo, pie y botones fijos). Las que tienen imagen/encabezado, botones con variables o son de autenticación aparecen con la etiqueta «Solo se envía desde Meta».
- Aún **no** se usan en los avisos automáticos (recordatorios de cita, etc.): hoy, si la ventana está cerrada, se crea una tarea en «Hoy». Conectar plantillas con las automatizaciones es el siguiente paso.

## 6. Qué NO está verificado
Las llamadas reales a Meta (crear, listar, borrar, enviar plantillas) no se pudieron probar porque la red del entorno de desarrollo bloquea internet; se probaron con respuestas simuladas con el formato que documenta Meta. La primera prueba real es la tuya: crea el ejemplo «Seguimiento», espera la aprobación y envíala desde una conversación de más de 24 h a tu propio teléfono.
