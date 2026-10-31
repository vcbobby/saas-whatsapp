-- Paso 41: horario de atención (cuándo hay personas atendiendo) y aviso fuera de horario.
-- Es distinto del horario de la agenda (cuándo se dan citas). La zona horaria se comparte con la agenda (agenda_settings).
CREATE TABLE business_hours (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  weekday smallint NOT NULL CHECK (weekday BETWEEN 1 AND 7),
  start_min smallint NOT NULL CHECK (start_min BETWEEN 0 AND 1439),
  end_min smallint NOT NULL CHECK (end_min BETWEEN 1 AND 1440),
  CHECK (start_min < end_min),
  EXCLUDE USING gist (tenant_id WITH =, weekday WITH =, int4range(start_min::int, end_min::int) WITH &&)
);
ALTER TABLE business_hours ENABLE ROW LEVEL SECURITY;
ALTER TABLE business_hours FORCE ROW LEVEL SECURITY;
CREATE POLICY business_hours_aislamiento ON business_hours
  USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());

CREATE TABLE business_hours_settings (
  tenant_id uuid PRIMARY KEY REFERENCES tenants (id) ON DELETE CASCADE,
  enabled boolean NOT NULL DEFAULT false,
  -- Texto extra opcional que se añade al aviso (por ejemplo «Para urgencias llama al 0412-…»).
  closed_note text CHECK (closed_note IS NULL OR char_length(closed_note) <= 300),
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE business_hours_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE business_hours_settings FORCE ROW LEVEL SECURITY;
CREATE POLICY business_hours_settings_aislamiento ON business_hours_settings
  USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());
