-- Paso 13C: citas pedidas por el asistente.
-- Guardamos de qué mensaje del cliente salió la cita: si el trabajo se reintenta, no se crea otra cita igual.
ALTER TABLE appointments ADD COLUMN request_message_id uuid;
ALTER TABLE appointments
  ADD FOREIGN KEY (tenant_id, request_message_id) REFERENCES messages (tenant_id, id) ON DELETE SET NULL (request_message_id);
CREATE UNIQUE INDEX appointments_mensaje_unico_idx ON appointments (tenant_id, request_message_id) WHERE request_message_id IS NOT NULL;
-- Solo el asistente pide citas desde un mensaje.
ALTER TABLE appointments ADD CONSTRAINT appointments_mensaje_solo_agente CHECK (request_message_id IS NULL OR source = 'agente');
