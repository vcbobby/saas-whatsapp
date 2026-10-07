-- 0001: tablas base, aislamiento por negocio (RLS) y auditoría.

-- Negocio "actual" de la transacción. Si no está fijado devuelve NULL y
-- ninguna política deja pasar filas (falla cerrado).
CREATE FUNCTION app_current_tenant() RETURNS uuid
LANGUAGE sql STABLE
AS $$ SELECT NULLIF(current_setting('app.tenant_id', true), '')::uuid $$;

-- ---------------------------------------------------------------- negocios
CREATE TABLE tenants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 120),
  slug text NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9][a-z0-9-]{1,48}[a-z0-9]$'),
  status text NOT NULL DEFAULT 'trial'
    CHECK (status IN ('trial', 'active', 'past_due', 'suspended')),
  trial_ends_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE tenants ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenants FORCE ROW LEVEL SECURITY;
CREATE POLICY tenants_aislamiento ON tenants
  USING (id = app_current_tenant())
  WITH CHECK (id = app_current_tenant());

-- ---------------------------------------------------------------- contactos
CREATE TABLE contacts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  wa_id text NOT NULL CHECK (char_length(wa_id) BETWEEN 5 AND 32),
  display_name text CHECK (char_length(display_name) <= 200),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, wa_id),
  UNIQUE (tenant_id, id)
);
ALTER TABLE contacts ENABLE ROW LEVEL SECURITY;
ALTER TABLE contacts FORCE ROW LEVEL SECURITY;
CREATE POLICY contacts_aislamiento ON contacts
  USING (tenant_id = app_current_tenant())
  WITH CHECK (tenant_id = app_current_tenant());

-- ------------------------------------------------------------ conversaciones
-- La clave foránea compuesta (tenant_id, contact_id) impide que una
-- conversación apunte a un contacto de OTRO negocio.
CREATE TABLE conversations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  contact_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'bot' CHECK (status IN ('bot', 'human', 'closed')),
  assigned_to uuid,
  last_message_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, contact_id) REFERENCES contacts (tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX conversations_tenant_estado_idx
  ON conversations (tenant_id, status, last_message_at DESC);
ALTER TABLE conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE conversations FORCE ROW LEVEL SECURITY;
CREATE POLICY conversations_aislamiento ON conversations
  USING (tenant_id = app_current_tenant())
  WITH CHECK (tenant_id = app_current_tenant());

-- ----------------------------------------------------------------- mensajes
-- UNIQUE (tenant_id, wa_message_id) sirve para no procesar dos veces
-- el mismo mensaje cuando Meta reintenta (Paso 6).
CREATE TABLE messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  conversation_id uuid NOT NULL,
  direction text NOT NULL CHECK (direction IN ('in', 'out')),
  wa_message_id text,
  msg_type text NOT NULL DEFAULT 'text',
  body text CHECK (char_length(body) <= 8192),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, wa_message_id),
  FOREIGN KEY (tenant_id, conversation_id)
    REFERENCES conversations (tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX messages_conversacion_idx
  ON messages (tenant_id, conversation_id, created_at DESC);
ALTER TABLE messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE messages FORCE ROW LEVEL SECURITY;
CREATE POLICY messages_aislamiento ON messages
  USING (tenant_id = app_current_tenant())
  WITH CHECK (tenant_id = app_current_tenant());

-- ------------------------------------------------- integraciones (con secretos)
-- secret_enc guarda el token cifrado con AES-256-GCM (ver src/lib/crypto.ts).
-- Esta tabla NO usa FORCE: la función de abajo, que pertenece a app_owner,
-- necesita poder buscar el negocio dueño de un número ANTES de saber cuál es.
-- app_user no es dueño de la tabla, así que a la aplicación siempre le aplica RLS.
CREATE TABLE tenant_integrations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  provider text NOT NULL CHECK (provider IN ('whatsapp')),
  external_id text NOT NULL,
  secret_enc text NOT NULL,
  key_version smallint NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, external_id)
);
ALTER TABLE tenant_integrations ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_integrations_aislamiento ON tenant_integrations
  USING (tenant_id = app_current_tenant())
  WITH CHECK (tenant_id = app_current_tenant());

-- Único camino para encontrar el negocio de un número de WhatsApp sin contexto.
-- Devuelve solo el id del negocio, nunca el secreto.
CREATE FUNCTION resolve_tenant_by_phone_number_id(p_phone_number_id text)
RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT tenant_id FROM tenant_integrations
  WHERE provider = 'whatsapp' AND external_id = p_phone_number_id
$$;
REVOKE ALL ON FUNCTION resolve_tenant_by_phone_number_id(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION resolve_tenant_by_phone_number_id(text) TO app_user;

-- ----------------------------------------------------------------- auditoría
-- Solo inserción. No tiene clave foránea a propósito: los registros deben
-- sobrevivir aunque se borre el negocio.
CREATE TABLE audit_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid,
  actor_id uuid,
  action text NOT NULL CHECK (char_length(action) BETWEEN 1 AND 100),
  target_type text,
  target_id text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_log_tenant_fecha_idx ON audit_log (tenant_id, created_at DESC);
ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_log FORCE ROW LEVEL SECURITY;
CREATE POLICY audit_log_lectura ON audit_log
  FOR SELECT USING (tenant_id = app_current_tenant());
CREATE POLICY audit_log_insercion ON audit_log
  FOR INSERT WITH CHECK (tenant_id = app_current_tenant());
REVOKE UPDATE, DELETE ON audit_log FROM app_user;

CREATE FUNCTION audit_log_inmutable() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'audit_log es de solo inserción'
    USING ERRCODE = 'insufficient_privilege';
END
$$;
CREATE TRIGGER audit_log_sin_cambios
  BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION audit_log_inmutable();
CREATE TRIGGER audit_log_sin_truncate
  BEFORE TRUNCATE ON audit_log
  FOR EACH STATEMENT EXECUTE FUNCTION audit_log_inmutable();
