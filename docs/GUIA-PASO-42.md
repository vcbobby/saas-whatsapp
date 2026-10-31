# Paso 42 — Datos de ejemplo y botón de comentarios

## Datos de ejemplo (modo demo)
En **Importar y exportar** (`/datos`, dueño y administradores) hay una tarjeta «Datos de ejemplo»:
- **Cargar**: crea 4 clientes con conversaciones (una pasada a una persona), 3 productos, 1 servicio, 3 pedidos (pendiente, confirmado, entregado) y 2 citas (una por venir, una ya atendida). Todo se llama «… (ejemplo)». Así el panel, las conversaciones, los reportes y la agenda se ven con movimiento.
- Los clientes de ejemplo tienen números inventados (empiezan con 58000…), **no reciben avisos** (`notifications_off`) y no tienen permiso de promociones, así que ninguna difusión ni recordatorio les llega.
- **Borrar**: quita solo lo marcado como ejemplo (pedidos, productos, clientes con sus conversaciones/citas/tareas, y el servicio). Tus datos reales no se tocan. Se puede volver a cargar.
- Si ya hay ejemplos, cargar de nuevo da un aviso (409).
- Aviso honesto: si tienes **webhooks salientes** configurados, los eventos de los datos de ejemplo (cliente nuevo, pedido creado…) sí se envían a tu endpoint. Úsalo antes de configurar webhooks o bórralos después.

## Botón «Enviar comentario»
- Aparece en el menú lateral para cualquier persona del equipo (dueño, administrador, agente). Elige: idea / algo no funciona / otra cosa, escribe y envía. Se guarda de quién es y desde qué pantalla.
- El **súper admin** los lee en **/admin/comentarios** (lo más reciente primero, hasta 200). La aplicación solo puede agregar comentarios: no los edita ni los borra. Límite: 20 envíos cada 10 minutos.
- Los comentarios se incluyen en la descarga de datos del negocio.
- El soporte que está «dentro» de un negocio (suplantación) no puede enviar comentarios en nombre de él.

## Cómo aplicarlo
1. `bash /ruta/aplicar-paso-42.sh` desde la raíz del proyecto.
2. `npm run db:migrate` (migración 0052).
3. `npm run typecheck && npm run lint && npm test`
4. Reinicia `npm run dev:all`.

## Cómo probarlo a mano
1. Entra a /datos, pulsa «Cargar datos de ejemplo» y recorre Conversaciones, Clientes, Pedidos, Agenda, Inicio y Reportes.
2. Vuelve a /datos y pulsa «Borrar datos de ejemplo» (pide confirmación).
3. Pulsa «Enviar comentario» en el menú, envía uno y léelo con tu usuario súper admin en /admin/comentarios.

## Qué NO está verificado
- El aspecto de las pantallas con los datos de ejemplo en un navegador (solo se probó la carga, el borrado, los totales y los reportes por código).
- El diálogo de comentarios en un navegador real (se usa el elemento nativo `<dialog>`).
- Que los eventos de webhooks salientes se comporten como se describe con un endpoint real.
