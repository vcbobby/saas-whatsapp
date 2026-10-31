# Paso 40 — Reportes y resumen semanal

## Qué hace
- **/reportes** (dueño y administradores): últimos 7 o 30 días completos (hasta ayer, en la hora del negocio) comparados con el período anterior: conversaciones, mensajes, clientes nuevos, respuestas del asistente vs. del equipo, conversaciones resueltas solo por el asistente, traspasos a una persona, tiempo típico (mediana) de primera respuesta, horas de más movimiento, pedidos, ventas (solo confirmados/entregados), lo más pedido y citas por estado.
- **Correo semanal**: cada lunes (desde las 12:00 UTC, 8:00 a. m. en Caracas) el worker manda el resumen al dueño y administradores. No se manda si no hubo actividad, si el negocio tiene menos de 7 días o si lo apagaron.
- En la página: interruptor del correo semanal y botón «Enviarme este resumen ahora» (máx. 1 por hora).

## Cómo aplicarlo
1. `bash /ruta/aplicar-paso-40.sh` desde la raíz del proyecto.
2. `npm run db:migrate` (migración 0050).
3. `npm run typecheck && npm run lint && npm test`
4. Reinicia `npm run dev:all` (el worker revisa los reportes cada 15 s).

## Cómo probarlo a mano
- Entra a /reportes con un negocio que ya tenga conversaciones.
- Pulsa «Enviarme este resumen ahora» y abre `/dev/correos` (en desarrollo no sale correo real).
- El envío del lunes solo se puede ver esperando al lunes o, en desarrollo, borrando la fila de la semana en `report_state` con el usuario dueño de la base.

## Notas técnicas
- `report_claim()` reparte cada semana una sola vez por negocio (tabla `report_state`, sin acceso directo para la app).
- Las métricas se calculan en vivo con consultas por negocio (aislamiento RLS); no hay tablas de resumen.
- «Resuelta solo por el asistente» = hubo mensaje del cliente, respondió el asistente, ninguna persona escribió y no se pidió atención humana en el período.

## Qué NO está verificado
- El envío real de correo (Resend) y el aspecto del correo en clientes de correo.
- El aspecto de la página con datos reales en un navegador (solo se probó que compila y que la API responde).
- Rendimiento con negocios muy grandes (cientos de miles de mensajes): las consultas usan los índices existentes, pero no se midió.
