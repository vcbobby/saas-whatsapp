-- 0002: cuentas, membresías, sesiones y súper admin.
--
-- Idea central: la aplicación (app_user) NO puede leer las tablas users ni
-- sessions. Solo puede llamar a las funciones de abajo, que validan todo
-- dentro de la base de datos. Así, aunque alguien lograra ejecutar SQL
-- arbitrario con app_user, no podría listar usuarios ni robar sesiones.

-- ------------------------------------------------------------------ usuarios
CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL CHECK (email = lower(email) AND char_length(email) BETWEEN 3 AND 254),
  password_hash text NOT NULL CHECK (char_length(password_hash) BETWEEN 20 AND 500),
  is_super_admin boolean NOT NULL DEFAULT false,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  failed_logins integer NOT NULL DEFAULT 0,
  locked_until timestamptz,
  last_login_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT users_email_key UNIQUE (email)
);
ALTER TABLE users ENABLE ROW LEVEL SECURITY;   -- sin políticas: nadie sin privilegios ve filas
REVOKE ALL ON users FROM app_user;

-- --------------------------------------------------------------- membresías
-- Qué usuario pertenece a qué negocio y con qué rol.
-- app_user solo puede LEER y BORRAR (de su propio negocio). Crear o cambiar
-- roles se hará con funciones propias (equipo, Paso 5B).
CREATE TABLE memberships (
  tenant_id uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('owner', 'admin', 'agent')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, user_id)
);
CREATE INDEX memberships_user_idx ON memberships (user_id);
ALTER TABLE memberships ENABLE ROW LEVEL SECURITY;
CREATE POLICY memberships_aislamiento ON memberships
  USING (tenant_id = app_current_tenant())
  WITH CHECK (tenant_id = app_current_tenant());
REVOKE INSERT, UPDATE ON memberships FROM app_user;

-- ----------------------------------------------------------------- sesiones
-- Guardamos solo el SHA-256 del token. El token real vive únicamente en la
-- cookie del navegador: si se filtra la base, las sesiones no se pueden usar.
CREATE TABLE sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash bytea NOT NULL UNIQUE CHECK (octet_length(token_hash) = 32),
  user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  active_tenant_id uuid REFERENCES tenants (id) ON DELETE SET NULL,
  acting_tenant_id uuid REFERENCES tenants (id) ON DELETE SET NULL,
  acting_until timestamptz,
  user_agent text CHECK (char_length(user_agent) <= 300),
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  idle_seconds integer NOT NULL CHECK (idle_seconds > 0),
  revoked_at timestamptz
);
CREATE INDEX sessions_user_idx ON sessions (user_id) WHERE revoked_at IS NULL;
CREATE INDEX sessions_expires_idx ON sessions (expires_at);
ALTER TABLE sessions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON sessions FROM app_user;

-- ------------------------------------- acceso de las funciones a tablas FORCE
-- tenants y audit_log tienen FORCE RLS. Las funciones de abajo pertenecen a
-- app_owner y las invoca app_user: dentro de ellas current_user = app_owner y
-- session_user = app_user. Esta combinación SOLO ocurre dentro de funciones
-- SECURITY DEFINER (app_user no puede crear funciones), así que es el límite
-- de confianza correcto.
CREATE POLICY tenants_funciones ON tenants
  USING (current_user = 'app_owner' AND session_user <> 'app_owner')
  WITH CHECK (current_user = 'app_owner' AND session_user <> 'app_owner');
CREATE POLICY audit_log_funciones_lectura ON audit_log
  FOR SELECT USING (current_user = 'app_owner' AND session_user <> 'app_owner');
CREATE POLICY audit_log_funciones_insercion ON audit_log
  FOR INSERT WITH CHECK (current_user = 'app_owner' AND session_user <> 'app_owner');

-- ===================================================== funciones internas
-- (no se otorgan a app_user; solo las usan otras funciones)

-- Devuelve el id del usuario dueño de una sesión válida, o NULL.
CREATE FUNCTION auth_session_user(p_token_hash bytea) RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT s.user_id
  FROM sessions s JOIN users u ON u.id = s.user_id
  WHERE s.token_hash = p_token_hash
    AND s.revoked_at IS NULL
    AND now() < s.expires_at
    AND now() < s.last_seen_at + make_interval(secs => s.idle_seconds)
    AND u.status = 'active'
$$;

-- Exige una sesión válida de súper admin. Si no, error 42501.
CREATE FUNCTION admin_require(p_token_hash bytea) RETURNS uuid
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE v_user uuid;
BEGIN
  v_user := auth_session_user(p_token_hash);
  IF v_user IS NULL OR NOT EXISTS (SELECT 1 FROM users WHERE id = v_user AND is_super_admin) THEN
    RAISE EXCEPTION 'no autorizado' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN v_user;
END
$$;

-- ============================================================ cuentas
CREATE FUNCTION auth_signup(p_email text, p_password_hash text, p_tenant_name text, p_slug text)
RETURNS TABLE (new_user_id uuid, new_tenant_id uuid)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE v_user uuid; v_tenant uuid;
BEGIN
  INSERT INTO users (email, password_hash) VALUES (p_email, p_password_hash)
    RETURNING id INTO v_user;
  INSERT INTO tenants (name, slug, status, trial_ends_at)
    VALUES (p_tenant_name, p_slug, 'trial', now() + interval '7 days')
    RETURNING id INTO v_tenant;
  INSERT INTO memberships (tenant_id, user_id, role) VALUES (v_tenant, v_user, 'owner');
  INSERT INTO audit_log (tenant_id, actor_id, action, target_type, target_id)
    VALUES (v_tenant, v_user, 'tenant.created', 'tenant', v_tenant::text);
  RETURN QUERY SELECT v_user, v_tenant;
END
$$;

CREATE FUNCTION auth_get_login(p_email text)
RETURNS TABLE (uid uuid, pw_hash text, super_admin boolean, user_status text, lock_until timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT id, password_hash, is_super_admin, status, locked_until
  FROM users WHERE email = lower(p_email)
$$;

-- Registra un intento fallido. A los 10 fallos seguidos bloquea 15 minutos.
CREATE FUNCTION auth_login_failed(p_user_id uuid) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE v_count integer;
BEGIN
  UPDATE users SET failed_logins = failed_logins + 1
    WHERE id = p_user_id RETURNING failed_logins INTO v_count;
  IF v_count >= 10 THEN
    UPDATE users SET locked_until = now() + interval '15 minutes', failed_logins = 0
      WHERE id = p_user_id;
    RETURN true;
  END IF;
  RETURN false;
END
$$;

CREATE FUNCTION auth_login_ok(p_user_id uuid) RETURNS void
LANGUAGE sql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  UPDATE users SET failed_logins = 0, locked_until = NULL, last_login_at = now()
  WHERE id = p_user_id
$$;

-- ============================================================ sesiones
-- Súper admin: 8 h de vida y 30 min de inactividad. Resto: 30 días y 7 días.
CREATE FUNCTION auth_create_session(p_user_id uuid, p_token_hash bytea, p_user_agent text)
RETURNS TABLE (session_id uuid, max_age_seconds integer)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_super boolean; v_tenant uuid; v_life interval; v_idle integer; v_id uuid;
BEGIN
  SELECT is_super_admin INTO v_super FROM users WHERE id = p_user_id AND status = 'active';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'usuario no disponible' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF v_super THEN v_life := interval '8 hours'; v_idle := 1800;
  ELSE v_life := interval '30 days'; v_idle := 604800;
  END IF;

  SELECT tenant_id INTO v_tenant FROM memberships
    WHERE user_id = p_user_id ORDER BY created_at LIMIT 1;

  -- Limpieza de sesiones viejas.
  DELETE FROM sessions
    WHERE expires_at < now() - interval '7 days' OR revoked_at < now() - interval '7 days';
  -- Máximo 10 sesiones activas por usuario: se revocan las más antiguas.
  UPDATE sessions SET revoked_at = now()
    WHERE id IN (
      SELECT id FROM sessions
      WHERE user_id = p_user_id AND revoked_at IS NULL AND expires_at > now()
      ORDER BY created_at DESC OFFSET 9
    );

  INSERT INTO sessions (token_hash, user_id, active_tenant_id, user_agent, expires_at, idle_seconds)
    VALUES (p_token_hash, p_user_id, v_tenant, left(p_user_agent, 300), now() + v_life, v_idle)
    RETURNING id INTO v_id;
  RETURN QUERY SELECT v_id, floor(extract(epoch FROM v_life))::integer;
END
$$;

CREATE FUNCTION auth_get_session(p_token_hash bytea)
RETURNS TABLE (
  sess_id uuid, sess_user_id uuid, sess_email text, sess_super boolean,
  sess_active_tenant uuid, sess_tenant_status text, sess_role text, sess_acting_tenant uuid
)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE s sessions%ROWTYPE; u users%ROWTYPE;
BEGIN
  SELECT * INTO s FROM sessions
    WHERE token_hash = p_token_hash
      AND revoked_at IS NULL
      AND now() < expires_at
      AND now() < last_seen_at + make_interval(secs => idle_seconds);
  IF NOT FOUND THEN RETURN; END IF;

  SELECT * INTO u FROM users WHERE id = s.user_id AND status = 'active';
  IF NOT FOUND THEN RETURN; END IF;

  IF s.last_seen_at < now() - interval '60 seconds' THEN
    UPDATE sessions SET last_seen_at = now() WHERE id = s.id;
  END IF;

  -- La suplantación caduca sola (y nunca vale para quien no es súper admin).
  IF s.acting_tenant_id IS NOT NULL
     AND (NOT u.is_super_admin OR s.acting_until IS NULL OR s.acting_until <= now()) THEN
    UPDATE sessions SET acting_tenant_id = NULL, acting_until = NULL WHERE id = s.id;
    s.acting_tenant_id := NULL;
  END IF;

  RETURN QUERY SELECT
    s.id, u.id, u.email, u.is_super_admin, s.active_tenant_id,
    (SELECT t.status FROM tenants t WHERE t.id = s.active_tenant_id),
    (SELECT m.role FROM memberships m
       WHERE m.tenant_id = s.active_tenant_id AND m.user_id = u.id),
    s.acting_tenant_id;
END
$$;

CREATE FUNCTION auth_list_memberships(p_token_hash bytea)
RETURNS TABLE (m_tenant_id uuid, m_tenant_name text, m_role text)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT t.id, t.name, m.role
  FROM memberships m JOIN tenants t ON t.id = m.tenant_id
  WHERE m.user_id = auth_session_user(p_token_hash)
  ORDER BY m.created_at
$$;

CREATE FUNCTION auth_set_active_tenant(p_token_hash bytea, p_tenant_id uuid) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE v_user uuid;
BEGIN
  v_user := auth_session_user(p_token_hash);
  IF v_user IS NULL THEN RETURN false; END IF;
  IF NOT EXISTS (SELECT 1 FROM memberships WHERE tenant_id = p_tenant_id AND user_id = v_user) THEN
    RETURN false;
  END IF;
  UPDATE sessions SET active_tenant_id = p_tenant_id WHERE token_hash = p_token_hash;
  RETURN true;
END
$$;

CREATE FUNCTION auth_revoke_session(p_token_hash bytea) RETURNS void
LANGUAGE sql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  UPDATE sessions SET revoked_at = now() WHERE token_hash = p_token_hash AND revoked_at IS NULL
$$;

-- "Cerrar sesión en todos lados".
CREATE FUNCTION auth_revoke_all_sessions(p_token_hash bytea) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE v_user uuid;
BEGIN
  v_user := auth_session_user(p_token_hash);
  IF v_user IS NOT NULL THEN
    UPDATE sessions SET revoked_at = now() WHERE user_id = v_user AND revoked_at IS NULL;
  END IF;
END
$$;

-- ============================================================ súper admin
CREATE FUNCTION admin_list_tenants(p_token_hash bytea)
RETURNS TABLE (
  t_id uuid, t_name text, t_slug text, t_status text,
  t_trial_ends_at timestamptz, t_created_at timestamptz, t_members bigint
)
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  PERFORM admin_require(p_token_hash);
  RETURN QUERY
    SELECT t.id, t.name, t.slug, t.status, t.trial_ends_at, t.created_at,
           (SELECT count(*) FROM memberships m WHERE m.tenant_id = t.id)
    FROM tenants t ORDER BY t.created_at DESC LIMIT 500;
END
$$;

-- Entrar a un negocio como soporte: exige motivo, dura 30 min y queda en la
-- auditoría DEL NEGOCIO (el dueño puede verlo).
CREATE FUNCTION admin_start_impersonation(p_token_hash bytea, p_tenant_id uuid, p_reason text)
RETURNS timestamptz
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE v_user uuid; v_until timestamptz;
BEGIN
  v_user := admin_require(p_token_hash);
  IF char_length(btrim(p_reason)) < 10 OR char_length(btrim(p_reason)) > 500 THEN
    RAISE EXCEPTION 'motivo inválido' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM tenants WHERE id = p_tenant_id) THEN
    RAISE EXCEPTION 'negocio inexistente' USING ERRCODE = 'no_data_found';
  END IF;
  v_until := now() + interval '30 minutes';
  UPDATE sessions SET acting_tenant_id = p_tenant_id, acting_until = v_until
    WHERE token_hash = p_token_hash;
  INSERT INTO audit_log (tenant_id, actor_id, action, target_type, target_id, metadata)
    VALUES (p_tenant_id, v_user, 'admin.impersonation.start', 'tenant', p_tenant_id::text,
            jsonb_build_object('reason', btrim(p_reason), 'until', v_until));
  RETURN v_until;
END
$$;

CREATE FUNCTION admin_stop_impersonation(p_token_hash bytea) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE v_user uuid; v_tenant uuid;
BEGIN
  v_user := admin_require(p_token_hash);
  SELECT acting_tenant_id INTO v_tenant FROM sessions WHERE token_hash = p_token_hash;
  IF v_tenant IS NOT NULL THEN
    INSERT INTO audit_log (tenant_id, actor_id, action, target_type, target_id)
      VALUES (v_tenant, v_user, 'admin.impersonation.stop', 'tenant', v_tenant::text);
    UPDATE sessions SET acting_tenant_id = NULL, acting_until = NULL
      WHERE token_hash = p_token_hash;
  END IF;
END
$$;

CREATE FUNCTION admin_set_tenant_status(p_token_hash bytea, p_tenant_id uuid, p_status text)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE v_user uuid; v_old text;
BEGIN
  v_user := admin_require(p_token_hash);
  SELECT status INTO v_old FROM tenants WHERE id = p_tenant_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'negocio inexistente' USING ERRCODE = 'no_data_found';
  END IF;
  UPDATE tenants SET status = p_status WHERE id = p_tenant_id;
  INSERT INTO audit_log (tenant_id, actor_id, action, target_type, target_id, metadata)
    VALUES (p_tenant_id, v_user, 'admin.tenant.status', 'tenant', p_tenant_id::text,
            jsonb_build_object('from', v_old, 'to', p_status));
END
$$;

-- ============================================================== permisos
REVOKE ALL ON FUNCTION
  auth_session_user(bytea), admin_require(bytea),
  auth_signup(text, text, text, text), auth_get_login(text),
  auth_login_failed(uuid), auth_login_ok(uuid),
  auth_create_session(uuid, bytea, text), auth_get_session(bytea),
  auth_list_memberships(bytea), auth_set_active_tenant(bytea, uuid),
  auth_revoke_session(bytea), auth_revoke_all_sessions(bytea),
  admin_list_tenants(bytea), admin_start_impersonation(bytea, uuid, text),
  admin_stop_impersonation(bytea), admin_set_tenant_status(bytea, uuid, text)
FROM PUBLIC;

-- app_user NO recibe auth_session_user ni admin_require (son internas).
GRANT EXECUTE ON FUNCTION
  auth_signup(text, text, text, text), auth_get_login(text),
  auth_login_failed(uuid), auth_login_ok(uuid),
  auth_create_session(uuid, bytea, text), auth_get_session(bytea),
  auth_list_memberships(bytea), auth_set_active_tenant(bytea, uuid),
  auth_revoke_session(bytea), auth_revoke_all_sessions(bytea),
  admin_list_tenants(bytea), admin_start_impersonation(bytea, uuid, text),
  admin_stop_impersonation(bytea), admin_set_tenant_status(bytea, uuid, text)
TO app_user;
