-- Paso 9B: registro de incidentes de seguridad del asistente (sin guardar el texto del cliente).
-- Sirve para (a) no gastar IA con quien insiste en manipular al asistente y (b) revisar qué pasó.
-- Permite la llave foránea compuesta (negocio, mensaje): así un incidente no puede apuntar a un mensaje de otro negocio.
ALTER TABLE messages ADD CONSTRAINT messages_tenant_id_id_key UNIQUE (tenant_id, id);

CREATE TABLE agent_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  conversation_id uuid NOT NULL,
  message_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('inyeccion', 'fuga_prompt', 'salida_bloqueada', 'limite_contacto')),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, conversation_id) REFERENCES conversations (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, message_id) REFERENCES messages (tenant_id, id) ON DELETE CASCADE
);
-- Un incidente de cada tipo por mensaje (los reintentos no lo duplican).
CREATE UNIQUE INDEX agent_events_unico_idx ON agent_events (tenant_id, message_id, kind);
CREATE INDEX agent_events_conv_idx ON agent_events (tenant_id, conversation_id, kind);

ALTER TABLE agent_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_events FORCE ROW LEVEL SECURITY;
CREATE POLICY agent_events_aislamiento ON agent_events
  USING (tenant_id = app_current_tenant())
  WITH CHECK (tenant_id = app_current_tenant());
-- Solo se agregan registros: la aplicación no puede editarlos ni borrarlos.
REVOKE UPDATE, DELETE ON agent_events FROM app_user;
