# Paso 32 — Plantillas en los avisos automáticos

## 1. Qué hay de nuevo
Una regla de **«avisar al cliente por WhatsApp»** (confirmar pedido, recordar cita…) ahora puede tener una **plantilla de respaldo**:

- **Dentro de las 24 h** del último mensaje del cliente: se envía tu mensaje normal (como siempre).
- **Pasadas las 24 h** (o si el cliente nunca escribió): en lugar de crear una tarea para avisar a mano, se envía la **plantilla aprobada** con los datos del pedido o la cita.
- **Sin plantilla** en la regla: todo sigue igual (queda una tarea en «Hoy»).

Esto es lo que hace que un **recordatorio de cita 24 horas antes** llegue aunque el cliente no haya escrito ese día.

## 2. Cómo se configura
1. Ten una plantilla **aprobada** (paso 31). Ejemplo: `Hola {{1}}, te recordamos tu cita de {{2}} el {{3}}. Si no puedes asistir, responde a este mensaje.`
2. En **Automatizaciones**, crea o edita una regla de «Avisar al cliente».
3. En **«Si pasaron más de 24 horas»** elige la plantilla y llena cada hueco con un dato: `{cliente}`, `{servicio}`, `{fecha}`, `{numero}`, `{total}`, `{estado}`… o un texto fijo.
   Ejemplo: `{{1}}` = `{cliente}`, `{{2}}` = `{servicio}`, `{{3}}` = `{fecha}`.
4. Guarda. La app comprueba que la plantilla esté aprobada, sea de texto y que no falte ningún dato.

## 3. Reglas de seguridad y de costo
- Al crearse el aviso se guarda una **copia de la plantilla ya llena**. Si después la borras o la cambias, ese aviso igual sale como se creó.
- Si un dato queda **vacío** (por ejemplo usas `{fecha}` en un pedido, que no tiene fecha), **no se usa la plantilla** y el aviso queda como siempre (tarea si pasaron 24 h).
- El límite de **5 avisos por cliente cada 24 h** y la **baja** (el cliente escribe BAJA) se respetan igual.
- Si Meta rechaza la plantilla (pausada, deshabilitada…), el aviso falla con el motivo y **se crea la tarea** para avisar a mano.
- Meta puede **cobrar cada plantilla enviada** a tu cuenta de WhatsApp Business (necesitas un método de pago en Meta). Revisa las tarifas vigentes.
- Si borras la plantilla en la app, las reglas que la usaban **vuelven al comportamiento anterior** (tarea si pasaron 24 h).

## 4. Qué NO está verificado
El envío real a Meta sigue sin poder probarse desde el entorno de desarrollo (sin internet). Se probó la lógica completa con envíos simulados: elegir plantilla o texto según la ventana, reintentos, rechazos, borrado de la plantilla, datos vacíos y aislamiento entre negocios. Prueba real sugerida: crea una cita para dentro de unos minutos con una regla «Recordatorio» y plantilla, con tu propio teléfono, sin haber escrito al número en las últimas 24 h.
