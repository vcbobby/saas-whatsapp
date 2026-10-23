-- Paso 22A: consentimiento. Cada persona deja registrado QUÉ versión de los documentos legales aceptó y CUÁNDO.
-- Solo se agregan filas (nadie las edita ni las borra desde la aplicación) y solo se escriben mediante funciones.
CREATE TABLE legal_acceptances (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  version text NOT NULL CHECK (version ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}(-[a-z0-9]{1,20})?$'),
  context text NOT NULL CHECK (context IN ('signup', 'invitation', 'reaccept')),
  accepted_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, version)
);
CREATE INDEX legal_acceptances_user_idx ON legal_acceptances (user_id, accepted_at DESC);
ALTER TABLE legal_acceptances ENABLE ROW LEVEL SECURITY;
ALTER TABLE legal_acceptances FORCE ROW LEVEL SECURITY;
CREATE POLICY legal_acceptances_funciones ON legal_acceptances
  USING (CURRENT_USER = 'app_owner' AND SESSION_USER <> 'app_owner')
  WITH CHECK (CURRENT_USER = 'app_owner' AND SESSION_USER <> 'app_owner');
REVOKE ALL ON legal_acceptances FROM PUBLIC, app_user;

-- Registrar una aceptación (si ya existe esa versión, no pasa nada).
CREATE FUNCTION legal_accept(p_user uuid, p_version text, p_context text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM users WHERE id = p_user) THEN RAISE EXCEPTION 'usuario no encontrado' USING ERRCODE = 'P0002'; END IF;
  INSERT INTO legal_acceptances (user_id, version, context) VALUES (p_user, p_version, p_context) ON CONFLICT (user_id, version) DO NOTHING;
END
$$;

-- Última aceptación de una persona (sin filas si nunca aceptó).
CREATE FUNCTION legal_latest(p_user uuid) RETURNS TABLE (version text, context text, accepted_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT version, context, accepted_at FROM legal_acceptances WHERE user_id = p_user ORDER BY accepted_at DESC, version DESC LIMIT 1
$$;

-- Crear la cuenta y dejar el consentimiento en la MISMA transacción: no puede existir una cuenta nueva sin su registro.
-- Con p_version NULL no se registra nada (solo se permite en pruebas; la aplicación lo exige en staging/producción).
CREATE FUNCTION auth_signup_consent(p_email text, p_password_hash text, p_tenant_name text, p_slug text, p_version text)
RETURNS TABLE (new_user_id uuid, new_tenant_id uuid)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE v_user uuid; v_tenant uuid;
BEGIN
  SELECT s.new_user_id, s.new_tenant_id INTO v_user, v_tenant FROM auth_signup(p_email, p_password_hash, p_tenant_name, p_slug) s;
  IF p_version IS NOT NULL THEN PERFORM legal_accept(v_user, p_version, 'signup'); END IF;
  RETURN QUERY SELECT v_user, v_tenant;
END
$$;

CREATE FUNCTION invite_signup_consent(p_inv_hash bytea, p_password_hash text, p_version text) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE v_user uuid;
BEGIN
  v_user := invite_signup(p_inv_hash, p_password_hash);
  IF p_version IS NOT NULL THEN PERFORM legal_accept(v_user, p_version, 'invitation'); END IF;
  RETURN v_user;
END
$$;

REVOKE ALL ON FUNCTION legal_accept(uuid, text, text), legal_latest(uuid), auth_signup_consent(text, text, text, text, text),
  invite_signup_consent(bytea, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION legal_accept(uuid, text, text), legal_latest(uuid), auth_signup_consent(text, text, text, text, text),
  invite_signup_consent(bytea, text, text) TO app_user;
