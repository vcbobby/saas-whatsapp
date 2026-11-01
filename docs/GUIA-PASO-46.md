# Paso 46 — Avisar al cliente cuando se recibe su pago

## Qué cambia
Ya podías avisar al cliente por WhatsApp cuando confirmabas o entregabas un pedido (Automatizaciones). Ahora también puedes avisarle cuando:

- **Recibes su pago** (marcas el pedido como pagado): «Hola Ana, recibimos tu pago del pedido #12. ¡Gracias!»
- **Rechazas su comprobante**: «No pudimos verificar el comprobante del pedido #12, ¿puedes enviarlo de nuevo?»

Son dos eventos nuevos (`order.paid` y `order.payment_rejected`). Funcionan igual que los demás: avisos al cliente, tarea en «Hoy», y avisos a tu Telegram/Discord/Slack o a Zapier/Make/n8n (el aviso incluye la forma de pago).

## Cómo activarlos (1 minuto)
1. Entra a **Automatizaciones** (en el menú; depende de que tu plan lo incluya).
2. En las recetas, pulsa **«Avisar que recibimos el pago»** y guarda. Haz lo mismo con **«Pedir otro comprobante si se rechaza»** si quieres.
3. Prueba con los **datos de ejemplo** (Datos → Cargar datos de ejemplo): en Pedidos marca uno como pagado y mira el aviso en la lista de avisos de la regla.

Al abrir «Marcar como pagado» en un pedido verás un recordatorio con el enlace a Automatizaciones.

## Reglas que conviene saber
- **«Marcado por error»** (reabrir un pago) **no avisa a nadie**: es una corrección interna. Pero si luego vuelves a marcarlo pagado, el cliente recibirá otro aviso de pago.
- Valen las reglas de siempre de WhatsApp: si pasaron más de 24 h desde el último mensaje del cliente solo sale con una plantilla aprobada; si no, queda una tarea en «Hoy» para avisarle a mano. Normalmente el cliente acaba de enviar su comprobante, así que la ventana está abierta.
- Máximo 5 avisos automáticos por cliente en 24 h, y se respeta si pidió «baja».
- Los datos de ejemplo no mandan avisos reales (esos clientes tienen los avisos apagados).

## Para aplicarlo
1. `bash aplicar-paso-46.sh`
2. `npm run db:migrate` (migración 0055).
3. `npm run typecheck && npm run lint && npm test`
4. Reinicia `npm run dev:all`.
