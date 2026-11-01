# Paso 47 — Prueba en navegador del aviso de pago (e2e)

Amplía las pruebas del Paso 45 con un recorrido completo, como lo haría un dueño de negocio:

1. Crea una cuenta y carga los datos de ejemplo.
2. Entra a **Automatizaciones** y activa la receta **«Avisar que recibimos el pago»**.
3. En **Pedidos**, abre «Marcar como pagado» (comprueba que aparece el recordatorio hacia Automatizaciones) y confirma el pago.
4. Vuelve a **Automatizaciones** y comprueba que en «Últimos avisos a clientes» aparece el mensaje con el nombre y el número del pedido.

Con esto, `npm run test:e2e` ya corre **9 recorridos**. No cambia la app: solo agrega la prueba y deja capturas (`15-receta-pago.png`, `16-aviso-de-pago.png`) en `e2e/capturas/`.

Qué prueba y qué no: comprueba que la regla se crea, se dispara al pagar y deja el aviso en la lista (en ejemplo sale como «No se envió · el cliente pidió no recibir avisos», porque los clientes de ejemplo tienen los avisos apagados a propósito). **No** envía nada real por WhatsApp.

## Para aplicarlo
1. Requiere los Pasos 45 y 46.
2. `bash aplicar-paso-47.sh`
3. Con `npm run dev:all` encendido: `npm run test:e2e`
