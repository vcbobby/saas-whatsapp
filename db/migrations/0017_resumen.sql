-- Paso 15A: el resumen del día cuenta mensajes por rango de fecha; sin este índice recorrería todo el historial del negocio.
CREATE INDEX messages_fecha_idx ON messages (tenant_id, created_at DESC);
