-- Paso 15B: consumo diario del copiloto del dueño (solo contadores: NO se guardan las preguntas ni las respuestas).
CREATE TABLE copilot_usage_daily (
  tenant_id uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  day date NOT NULL,
  questions integer NOT NULL DEFAULT 0 CHECK (questions >= 0),
  input_tokens bigint NOT NULL DEFAULT 0,
  output_tokens bigint NOT NULL DEFAULT 0,
  PRIMARY KEY (tenant_id, day)
);
ALTER TABLE copilot_usage_daily ENABLE ROW LEVEL SECURITY;
ALTER TABLE copilot_usage_daily FORCE ROW LEVEL SECURITY;
CREATE POLICY copilot_usage_aislamiento ON copilot_usage_daily
  USING (tenant_id = app_current_tenant())
  WITH CHECK (tenant_id = app_current_tenant());
