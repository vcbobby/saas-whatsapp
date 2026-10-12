-- Paso 11B: respuestas escritas por una persona desde la bandeja.
--  * sent_by:    quién escribió el mensaje (vacío = lo envió el asistente).
--  * client_key: clave que genera el navegador por cada intento de envío. Si el mismo
--                intento llega dos veces (doble clic, reintento de red), la base lo rechaza
--                y NO se manda otro mensaje a WhatsApp.
ALTER TABLE messages
  ADD COLUMN sent_by uuid,
  ADD COLUMN client_key uuid,
  ADD CONSTRAINT messages_sent_by_solo_salida CHECK (sent_by IS NULL OR direction = 'out'),
  ADD CONSTRAINT messages_client_key_solo_salida CHECK (client_key IS NULL OR direction = 'out');

CREATE UNIQUE INDEX messages_client_key_idx
  ON messages (tenant_id, client_key) WHERE client_key IS NOT NULL;

-- Para averiguar rápido cuándo escribió el cliente por última vez (ventana de 24 horas).
CREATE INDEX messages_ultimo_entrante_idx
  ON messages (tenant_id, conversation_id, created_at DESC) WHERE direction = 'in';
