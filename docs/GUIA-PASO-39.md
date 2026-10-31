# Paso 39 — Difusiones (promociones por WhatsApp)

Hay **una migración nueva (0049)**: `npm run db:migrate`. Reinicia el worker (`npm run dev:all`): él hace los envíos. Pantalla nueva: **Difusiones** (menú, solo dueño y administrador).

## Cómo se usa
1. **Plantilla.** WhatsApp solo deja escribirle primero a un cliente con una plantilla aprobada por Meta. Crea una en WhatsApp → Plantillas (categoría «Marketing») que **incluya cómo darse de baja**, por ejemplo: `Hola {{1}}, esta semana 20% de descuento. Responde BAJA para no recibir más promociones.` Una plantilla sin la palabra BAJA (o STOP) no se puede usar en una difusión.
2. **Nueva difusión:** nombre (solo para ti), plantilla, qué poner en cada variable (el **nombre del cliente** o un texto fijo) y a quién (todos, una etiqueta, un tipo de contacto). «Ver a cuántas personas llegaría» no envía nada.
3. **Borrador → revisar → iniciar.** En la página de la difusión ves la vista previa, marcas «Confirmo que estas personas aceptaron recibir promociones» y pulsas «Iniciar envío».
4. **Resultados:** enviados, entregados, leídos, respondieron, fallidos, pendientes (se actualiza solo mientras envía).
5. **Reenviar a quienes no la leyeron:** crea un borrador nuevo solo con esas personas (revisas y confirmas igual).

## Quién recibe (y quién no)
Solo las personas que cumplen **todo** esto:
- Tienen **permiso para promociones** registrado en su ficha (paso 37). Sin eso, nunca.
- No pidieron la baja (escribir BAJA / STOP, o «No enviarle avisos» en la ficha).
- No están marcadas como «personal».
- No las está atendiendo una persona en ese momento.
- No recibieron otra difusión en los últimos 3 días.
- Tienen un número válido.
Todo se **vuelve a comprobar en el momento de enviar** a cada una: si alguien pide la baja a mitad del envío, ya no le llega. La vista previa explica cuántas quedan fuera y por qué.

## Protecciones
- **Ritmo:** unos 12 mensajes cada 15 s (≈ uno por segundo) y **máximo 250 por negocio en 24 horas** (el límite que Meta da a un número nuevo). Si hay más, el resto espera y sigue solo cuando se libera cupo. El tope es `DAILY_CAP` en `src/lib/broadcasts/send.ts`; súbelo solo cuando Meta suba el límite de tu número.
- **Pausa automática:** si de los últimos 20 envíos fallan la mitad o más (incluyendo los que WhatsApp reporta como no entregados), la difusión se pausa sola con un aviso. Revisa el número y la plantilla y pulsa «Reanudar».
- **Máximo 2000 personas por difusión** (filtra por etiqueta para enviarlo por partes).
- **Nunca se envía dos veces el mismo mensaje**: si el proceso se cae a mitad de un envío, esa persona queda como «incierto» y NO se reintenta a ciegas. Si no hubo conexión, reintenta 2 veces (1 y 5 min).
- Una difusión que ya empezó **no se puede modificar** (texto, plantilla, variables ni público); se puede pausar, reanudar o cancelar.
- Cada difusión creada, iniciada, pausada, reanudada o cancelada queda en el registro de actividad.
- Cuando alguien responde a una difusión, esa respuesta entra por el flujo normal: el asistente atiende o pasa a una persona.

## Detalles
- Las personas que nunca habían escrito (por ejemplo importadas con permiso) reciben el mensaje y se les crea una conversación para que su respuesta tenga dónde llegar.
- «Leídos» solo cuenta a quienes tienen activados los acuses de lectura en WhatsApp.
- Meta cobra las conversaciones de marketing: revisa tu tarifa antes de enviar a muchas personas. La app no calcula ese costo.
- Meta puede rechazar mensajes por su propia regla de «frecuencia de marketing» aunque cumplas todo lo anterior; aparecerá como fallido con el código de Meta.

## Límites (por ahora)
- Solo plantillas de texto (sin imagen en el encabezado ni botones con variables).
- No se programan para una hora futura: se inician cuando tú lo decides.
- No hay segmentos por compras o citas (solo etiqueta y tipo de contacto) ni «mejor hora de envío».
- No se probó contra WhatsApp real: sin número y sin plantillas aprobadas no se puede verificar desde aquí; las pruebas simulan las respuestas de Meta (enviado, rechazado, sin conexión, incierto).
