# Paso 44 — Fotos de clientes y cobro con comprobante

## Qué hace
1. **Ver las fotos que manda el cliente**: en Conversaciones, un mensaje con imagen muestra «Ver imagen». Se descarga de WhatsApp en ese momento (solo JPG, PNG o WebP, máx. 5 MB); **no se guarda en nuestros servidores**. WhatsApp la conserva unos 30 días: después aparece «ya no está disponible».
2. **Comprobante de pago**: si el cliente tiene **exactamente un pedido** por pagar (pendiente o confirmado) y manda una imagen, esa imagen queda como su comprobante, el pedido pasa a «Pago por verificar» y se abre una tarea «Verificar pago del pedido #N» en Hoy.
   - Si tiene **varios pedidos** por pagar: se abre una tarea sin vincular («¿a qué pedido?») y no se cambia ninguno.
   - Si **no tiene pedidos** (o están pagados o cancelados): la imagen es solo un mensaje más.
3. **El asistente** agradece el comprobante («Recibimos tu comprobante, una persona lo verificará…») sin pasar la conversación a una persona. Cualquier otra imagen recibe el aviso de siempre («solo puedo leer texto»).
4. **En Pedidos**: cada pedido muestra su estado de pago. Quien atiende pulsa «Ver comprobante», revisa el monto y elige:
   - **Marcar como pagado** (con la forma de pago: Pago móvil, Transferencia, Efectivo, Zelle, Punto de venta, Otro) — también sirve para cobros sin foto, como efectivo;
   - **No es un pago válido** — vuelve a «Sin pagar» y descarta la tarea;
   - **Marcado por error** — deshace un «Pagado».
   Cada acción queda en el registro de auditoría. Un pedido cancelado no se cobra. **Nada se marca pagado solo.**

## Cómo aplicarlo
1. `bash /ruta/aplicar-paso-44.sh` desde la raíz del proyecto.
2. `npm run db:migrate` (migración 0054).
3. `npm run typecheck && npm run lint && npm test`
4. Reinicia `npm run dev:all`.

## Cómo probarlo a mano (con tu WhatsApp conectado)
1. Crea un pedido para un cliente (desde su conversación o el asistente).
2. Desde el teléfono de ese cliente, manda una foto cualquiera al número del negocio.
3. Mira la tarea en Hoy, el pedido en «Pago por verificar» y pulsa «Ver comprobante».
4. Marca como pagado con una forma de pago.
Sin WhatsApp real no se puede probar la descarga de la foto: el simulador solo envía texto.

## Notas técnicas
- Columnas nuevas: `messages.media_id/media_mime` (el id de Meta, no la imagen) y en `orders`: `payment_state`, `proof_message_id`, `paid_at`, `paid_by`, `payment_method`.
- La descarga solo acepta servidores de Meta (facebook, fbcdn, fbsbx, whatsapp), sin redirecciones, con límite de tamaño y de tiempo. Las respuestas llevan `nosniff` y `sandbox` y no se guardan en caché.
- Aún no hay aviso automático al cliente cuando se confirma su pago: escríbele desde la conversación.
- No se lee el monto de la imagen (no hay lectura automática): la verificación es humana.

## Qué NO está verificado
- La descarga real desde Meta: en el sandbox se probó con respuestas simuladas, siguiendo el formato documentado de la API (primero un `GET /<id>` con la dirección temporal y luego la descarga con el mismo token). Si Meta cambiara su dominio de descarga, la foto no se vería: en ese caso el mensaje de error es «No se pudo descargar la imagen ahora».
- Imágenes que lleguen como «documento» (por ejemplo un PDF de la transferencia): hoy no se reconocen como comprobante.
- El aspecto de las pantallas en un navegador real.
