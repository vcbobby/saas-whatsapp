-- Paso 13A: agenda (servicios, horario semanal, bloqueos) y tabla de citas.
-- btree_gist permite la regla "no se cruzan dos citas del mismo negocio" directamente en la base de datos.
-- (Es una extensión de confianza: la puede crear el dueño de la base, app_owner.)
CREATE EXTENSION IF NOT EXISTS btree_gist;

-- ------------------------------------------------------------ ajustes
CREATE TABLE agenda_settings (
  tenant_id uuid PRIMARY KEY REFERENCES tenants (id) ON DELETE CASCADE,
  timezone text NOT NULL DEFAULT 'America/Caracas' CHECK (char_length(timezone) BETWEEN 3 AND 64),
  min_notice_minutes integer NOT NULL DEFAULT 120 CHECK (min_notice_minutes BETWEEN 0 AND 10080),
  max_days_ahead integer NOT NULL DEFAULT 30 CHECK (max_days_ahead BETWEEN 1 AND 365),
  slot_step_minutes integer NOT NULL DEFAULT 30 CHECK (slot_step_minutes IN (5, 10, 15, 20, 30, 45, 60)),
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid
);
ALTER TABLE agenda_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE agenda_settings FORCE ROW LEVEL SECURITY;
CREATE POLICY agenda_settings_aislamiento ON agenda_settings
  USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());

-- ------------------------------------------------------------ servicios
-- No se borran: se desactivan (las citas viejas siguen apuntando a ellos).
CREATE TABLE agenda_services (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 80),
  duration_minutes integer NOT NULL CHECK (duration_minutes BETWEEN 5 AND 480),
  price_text text CHECK (char_length(price_text) <= 40),
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id)
);
CREATE UNIQUE INDEX agenda_services_nombre_idx ON agenda_services (tenant_id, lower(name)) WHERE active;
ALTER TABLE agenda_services ENABLE ROW LEVEL SECURITY;
ALTER TABLE agenda_services FORCE ROW LEVEL SECURITY;
CREATE POLICY agenda_services_aislamiento ON agenda_services
  USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());

-- ------------------------------------------------------------ horario semanal
-- weekday: 1 = lunes … 7 = domingo. Minutos desde la medianoche, en la zona horaria del negocio.
-- La regla EXCLUDE impide dos tramos que se pisen el mismo día.
CREATE TABLE agenda_hours (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  weekday smallint NOT NULL CHECK (weekday BETWEEN 1 AND 7),
  start_min smallint NOT NULL CHECK (start_min BETWEEN 0 AND 1439),
  end_min smallint NOT NULL CHECK (end_min BETWEEN 1 AND 1440),
  CHECK (start_min < end_min),
  EXCLUDE USING gist (tenant_id WITH =, weekday WITH =, int4range(start_min::int, end_min::int) WITH &&)
);
ALTER TABLE agenda_hours ENABLE ROW LEVEL SECURITY;
ALTER TABLE agenda_hours FORCE ROW LEVEL SECURITY;
CREATE POLICY agenda_hours_aislamiento ON agenda_hours
  USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());

-- ------------------------------------------------------------ bloqueos (vacaciones, feriados…)
CREATE TABLE agenda_time_off (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  reason text CHECK (char_length(reason) <= 200),
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (starts_at < ends_at),
  CHECK (ends_at - starts_at <= interval '400 days')
);
CREATE INDEX agenda_time_off_idx ON agenda_time_off (tenant_id, ends_at);
ALTER TABLE agenda_time_off ENABLE ROW LEVEL SECURITY;
ALTER TABLE agenda_time_off FORCE ROW LEVEL SECURITY;
CREATE POLICY agenda_time_off_aislamiento ON agenda_time_off
  USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());

-- ------------------------------------------------------------ citas
-- Un solo calendario por negocio: dos citas activas (pendiente/confirmada) no pueden cruzarse.
-- La regla vive en la base de datos, así que ningún error de código puede dejar una cita doble.
CREATE TABLE appointments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  service_id uuid NOT NULL,
  contact_id uuid,
  conversation_id uuid,
  customer_name text NOT NULL CHECK (char_length(customer_name) BETWEEN 1 AND 120),
  customer_phone text CHECK (char_length(customer_phone) <= 32),
  notes text CHECK (char_length(notes) <= 1000),
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'pendiente' CHECK (status IN ('pendiente', 'confirmada', 'cancelada', 'completada', 'no_asistio')),
  source text NOT NULL CHECK (source IN ('manual', 'agente')),
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (starts_at < ends_at),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, service_id) REFERENCES agenda_services (tenant_id, id),
  FOREIGN KEY (tenant_id, contact_id) REFERENCES contacts (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, conversation_id) REFERENCES conversations (tenant_id, id) ON DELETE CASCADE,
  EXCLUDE USING gist (tenant_id WITH =, tstzrange(starts_at, ends_at) WITH &&) WHERE (status IN ('pendiente', 'confirmada'))
);
CREATE INDEX appointments_agenda_idx ON appointments (tenant_id, starts_at);
ALTER TABLE appointments ENABLE ROW LEVEL SECURITY;
ALTER TABLE appointments FORCE ROW LEVEL SECURITY;
CREATE POLICY appointments_aislamiento ON appointments
  USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());
