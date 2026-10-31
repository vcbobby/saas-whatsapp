# Paso 37 — Ficha de cliente

Una pantalla **Clientes** (en el menú, debajo de Conversaciones) con la ficha de cada persona que te escribe. Hay **una migración nueva (0047)**: `npm run db:migrate`.

## Qué trae
- **Lista de clientes**: los que escribieron más recientemente primero, de 30 en 30. Busca por nombre o teléfono; filtra por etiqueta, tipo de contacto, «pidieron no recibir avisos» y permiso para promociones.
- **Ficha** (`/clientes/<id>`; también desde una conversación con «Ver ficha»): conversaciones, pedidos y citas de la persona, y cuánto ha comprado (pedidos confirmados o entregados, por moneda).
- **Etiquetas libres** («mayorista», «VIP»…): hasta 10 por cliente, 30 caracteres cada una, sin comas, comillas ni repetidas (no distingue mayúsculas).
- **Nota interna** (hasta 2000 caracteres) que solo ve tu equipo.
- **Tipo de contacto** (cliente, prospecto, personal…): es el mismo que ya existía en Conversaciones.
- **Avisos automáticos**: botón para dejar de enviarle recordatorios y mensajes automáticos (es el mismo interruptor que se activa solo cuando el cliente escribe BAJA).
- **Permiso para promociones**: se registra cuándo y cómo lo aceptó (WhatsApp, tienda, formulario, lista importada, otro) y se puede retirar. Todavía no se envía nada con esto: lo usará el paso de difusiones, que solo irá a quienes tengan permiso y no hayan pedido la baja.
- La descarga de **clientes** (Importar y exportar) ahora incluye tipo, etiquetas, nota, baja y permiso.

## Quién puede qué
- Ver la lista y las fichas, y editar etiquetas, notas, tipo, baja y permiso: **dueño, administrador y agente**.
- Descargar el archivo de clientes: solo dueño y administrador (como antes).

## Detalles que conviene saber
- Un pedido o una cita hechos a mano sin vincular a un cliente se reconocen por el **teléfono**, así que aparecen igual en su ficha y en los conteos de la lista.
- Los pedidos cancelados salen en la ficha pero no cuentan en el total comprado ni en el número de pedidos de la lista.
- El registro de actividad guarda qué cambió (etiquetas, baja, tipo, permiso) y quién; de la nota solo guarda que cambió, no su texto.
- Un negocio nunca ve ni toca los clientes de otro (probado).

## Límites
- No se pueden editar el nombre ni el teléfono (el nombre lo manda WhatsApp).
- No hay todavía acciones masivas (poner una etiqueta a varios a la vez) ni «unir clientes duplicados».
- La nota es una sola por cliente; las notas privadas dentro de la conversación vienen en el paso 38.
