-- 0006: agente de IA (Paso 9A).

-- Configuración del asistente de cada negocio. Apagado por defecto.
CREATE TABLE tenant_agents (
  tenant_id uuid PRIMARY KEY REFERENCES tenants (id) ON DELETE CASCADE,
  enabled boolean NOT NULL DEFAULT false,
  assistant_name text NOT NULL DEFAULT 'Asistente'
    CHECK (char_length(assistant_name) BETWEEN 1 AND 60),
  instructions text NOT NULL DEFAULT ''
    CHECK (char_length(instructions) <= 4000),
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid
);
ALTER TABLE tenant_agents ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_agents FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_agents_aislamiento ON tenant_agents
  USING (tenant_id = app_current_tenant())
  WITH CHECK (tenant_id = app_current_tenant());

-- Respuestas: una sola respuesta por mensaje entrante (índice único) y un estado
-- de envío, para no mandar dos veces lo mismo al cliente si el worker se reintenta.
ALTER TABLE messages
  ADD COLUMN reply_to uuid,
  ADD COLUMN send_state text CHECK (send_state IN ('sending', 'sent', 'failed', 'unknown')),
  ADD COLUMN send_error text CHECK (char_length(send_error) <= 300);

CREATE UNIQUE INDEX messages_una_respuesta_idx
  ON messages (tenant_id, reply_to) WHERE direction = 'out' AND reply_to IS NOT NULL;

-- Orden de llegada según NUESTRO reloj. created_at de los mensajes entrantes viene de Meta
-- (su reloj, en segundos); para decidir "cuál es el último" y armar el historial se usa este.
-- clock_timestamp() es distinto en cada fila, incluso dentro de la misma transacción.
ALTER TABLE messages ADD COLUMN received_at timestamptz NOT NULL DEFAULT clock_timestamp();
UPDATE messages SET received_at = created_at;
CREATE INDEX messages_orden_idx ON messages (tenant_id, conversation_id, received_at DESC, id DESC);

-- Para contar las respuestas del día de cada negocio (tope diario).
CREATE INDEX messages_respuestas_dia_idx
  ON messages (tenant_id, created_at) WHERE direction = 'out' AND reply_to IS NOT NULL;

-- Motivo por el que una conversación pasó a una persona.
ALTER TABLE conversations
  ADD COLUMN handoff_reason text CHECK (char_length(handoff_reason) <= 100);

-- Consumo informativo (tokens) por negocio y día (UTC).
CREATE TABLE agent_usage_daily (
  tenant_id uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  day date NOT NULL,
  replies integer NOT NULL DEFAULT 0,
  input_tokens bigint NOT NULL DEFAULT 0,
  output_tokens bigint NOT NULL DEFAULT 0,
  PRIMARY KEY (tenant_id, day)
);
ALTER TABLE agent_usage_daily ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_usage_daily FORCE ROW LEVEL SECURITY;
CREATE POLICY agent_usage_aislamiento ON agent_usage_daily
  USING (tenant_id = app_current_tenant())
  WITH CHECK (tenant_id = app_current_tenant());
