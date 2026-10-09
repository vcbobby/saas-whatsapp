-- 0003: verificación en dos pasos (TOTP), códigos de recuperación y equipo.
--
-- Mismas reglas que 0002: app_user no lee ni escribe estas tablas; solo llama
-- a funciones que validan todo dentro de la base de datos.

-- ---------------------------------------------------------------- tablas 2FA
-- El secreto TOTP se guarda CIFRADO (AES-256-GCM, hecho por la aplicación).
CREATE TABLE user_mfa (
  user_id uuid PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
  secret_enc text NOT NULL,
  key_version integer NOT NULL,
  enabled_at timestamptz,                         -- NULL = configuración sin terminar
  last_step bigint NOT NULL DEFAULT 0,            -- anti-repetición: un código sirve una vez
  failed_attempts integer NOT NULL DEFAULT 0,
  locked_until timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE user_mfa ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON user_mfa FROM app_user;

-- Solo se guarda el SHA-256 de cada código de recuperación.
CREATE TABLE mfa_recovery_codes (
  user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  code_hash bytea NOT NULL CHECK (octet_length(code_hash) = 32),
  used_at timestamptz,
  PRIMARY KEY (user_id, code_hash)
);
ALTER TABLE mfa_recovery_codes ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON mfa_recovery_codes FROM app_user;

-- Sesión "a medias": la contraseña fue correcta pero falta el código 2FA.
-- Una sesión pendiente NO sirve para nada más que para completar el 2FA.
ALTER TABLE sessions ADD COLUMN mfa_pending boolean NOT NULL DEFAULT false;

-- --------------------------------------------------------------- invitaciones
CREATE TABLE invitations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  email text NOT NULL CHECK (email = lower(email) AND char_length(email) BETWEEN 3 AND 254),
  role text NOT NULL CHECK (role IN ('admin', 'agent')),
  token_hash bytea NOT NULL UNIQUE CHECK (octet_length(token_hash) = 32),
  invited_by uuid REFERENCES users (id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  accepted_at timestamptz,
  revoked_at timestamptz
);
CREATE UNIQUE INDEX invitations_pendiente_idx ON invitations (tenant_id, email)
  WHERE accepted_at IS NULL AND revoked_at IS NULL;
ALTER TABLE invitations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON invitations FROM app_user;

-- ===================================================== funciones internas
-- Sesión válida, incluyendo las pendientes de 2FA.
CREATE FUNCTION auth_session_user_any(p_token_hash bytea) RETURNS uuid
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

-- Sesión válida y COMPLETA (las pendientes de 2FA no cuentan). Reemplaza a la de 0002.
CREATE OR REPLACE FUNCTION auth_session_user(p_token_hash bytea) RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT s.user_id
  FROM sessions s JOIN users u ON u.id = s.user_id
  WHERE s.token_hash = p_token_hash
    AND NOT s.mfa_pending
    AND s.revoked_at IS NULL
    AND now() < s.expires_at
    AND now() < s.last_seen_at + make_interval(secs => s.idle_seconds)
    AND u.status = 'active'
$$;

-- El súper admin exige sesión completa Y 2FA activado. Reemplaza a la de 0002.
CREATE OR REPLACE FUNCTION admin_require(p_token_hash bytea) RETURNS uuid
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE v_user uuid;
BEGIN
  v_user := auth_session_user(p_token_hash);
  IF v_user IS NULL
     OR NOT EXISTS (SELECT 1 FROM users WHERE id = v_user AND is_super_admin)
     OR NOT EXISTS (SELECT 1 FROM user_mfa WHERE user_id = v_user AND enabled_at IS NOT NULL) THEN
    RAISE EXCEPTION 'no autorizado' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN v_user;
END
$$;

-- Crea la sesión. Pendiente = 10 minutos y solo vale para el 2FA.
CREATE FUNCTION auth_issue_session(
  p_user_id uuid, p_token_hash bytea, p_user_agent text, p_pending boolean
) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_super boolean; v_tenant uuid; v_life interval; v_idle integer;
BEGIN
  SELECT is_super_admin INTO v_super FROM users WHERE id = p_user_id AND status = 'active';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'usuario no disponible' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_pending THEN v_life := interval '10 minutes'; v_idle := 600;
  ELSIF v_super THEN v_life := interval '8 hours'; v_idle := 1800;
  ELSE v_life := interval '30 days'; v_idle := 604800;
  END IF;

  SELECT tenant_id INTO v_tenant FROM memberships
    WHERE user_id = p_user_id ORDER BY created_at LIMIT 1;

  DELETE FROM sessions
    WHERE expires_at < now() - interval '7 days' OR revoked_at < now() - interval '7 days';

  IF p_pending THEN
    -- Máximo 3 pendientes: quien solo conoce la contraseña no puede
    -- expulsar las sesiones reales de la persona.
    UPDATE sessions SET revoked_at = now()
      WHERE id IN (
        SELECT id FROM sessions
        WHERE user_id = p_user_id AND mfa_pending AND revoked_at IS NULL AND expires_at > now()
        ORDER BY created_at DESC OFFSET 2
      );
  ELSE
    -- Máximo 10 sesiones completas activas por usuario.
    UPDATE sessions SET revoked_at = now()
      WHERE id IN (
        SELECT id FROM sessions
        WHERE user_id = p_user_id AND NOT mfa_pending AND revoked_at IS NULL AND expires_at > now()
        ORDER BY created_at DESC OFFSET 9
      );
  END IF;

  INSERT INTO sessions (token_hash, user_id, active_tenant_id, user_agent, expires_at, idle_seconds, mfa_pending)
    VALUES (p_token_hash, p_user_id, v_tenant, left(p_user_agent, 300), now() + v_life, v_idle, p_pending);
  RETURN floor(extract(epoch FROM v_life))::integer;
END
$$;

-- Suma un fallo de 2FA. A los 5 seguidos bloquea 15 minutos y cierra las pendientes.
CREATE FUNCTION mfa_register_failure(p_user_id uuid) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE v_count integer;
BEGIN
  UPDATE user_mfa SET failed_attempts = failed_attempts + 1
    WHERE user_id = p_user_id RETURNING failed_attempts INTO v_count;
  IF v_count IS NOT NULL AND v_count >= 5 THEN
    UPDATE user_mfa SET locked_until = now() + interval '15 minutes', failed_attempts = 0
      WHERE user_id = p_user_id;
    UPDATE sessions SET revoked_at = now()
      WHERE user_id = p_user_id AND mfa_pending AND revoked_at IS NULL;
    RETURN true;
  END IF;
  RETURN false;
END
$$;

-- Rol con el que la sesión actúa en un negocio (NULL = sin acceso).
CREATE FUNCTION auth_tenant_role(p_token_hash bytea, p_tenant_id uuid) RETURNS text
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE v_user uuid; v_role text;
BEGIN
  v_user := auth_session_user(p_token_hash);
  IF v_user IS NULL THEN RETURN NULL; END IF;
  IF EXISTS (
    SELECT 1 FROM sessions s JOIN users u ON u.id = s.user_id
    JOIN user_mfa f ON f.user_id = u.id AND f.enabled_at IS NOT NULL
    WHERE s.token_hash = p_token_hash AND u.is_super_admin
      AND s.acting_tenant_id = p_tenant_id AND s.acting_until > now()
  ) THEN
    RETURN 'admin';
  END IF;
  SELECT role INTO v_role FROM memberships WHERE tenant_id = p_tenant_id AND user_id = v_user;
  RETURN v_role;
END
$$;

-- ================================================ sesiones (reemplazos de 0002)
DROP FUNCTION auth_create_session(uuid, bytea, text);
CREATE FUNCTION auth_create_session(p_user_id uuid, p_token_hash bytea, p_user_agent text)
RETURNS TABLE (max_age_seconds integer, is_pending boolean)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE v_pending boolean; v_age integer;
BEGIN
  v_pending := EXISTS (SELECT 1 FROM user_mfa WHERE user_id = p_user_id AND enabled_at IS NOT NULL);
  v_age := auth_issue_session(p_user_id, p_token_hash, p_user_agent, v_pending);
  RETURN QUERY SELECT v_age, v_pending;
END
$$;

DROP FUNCTION auth_get_session(bytea);
CREATE FUNCTION auth_get_session(p_token_hash bytea)
RETURNS TABLE (
  sess_id uuid, sess_user_id uuid, sess_email text, sess_super boolean,
  sess_active_tenant uuid, sess_tenant_status text, sess_role text, sess_acting_tenant uuid,
  sess_mfa_enabled boolean, sess_needs_mfa_setup boolean
)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE s sessions%ROWTYPE; u users%ROWTYPE; v_mfa boolean; v_super boolean;
BEGIN
  SELECT * INTO s FROM sessions
    WHERE token_hash = p_token_hash
      AND NOT mfa_pending
      AND revoked_at IS NULL
      AND now() < expires_at
      AND now() < last_seen_at + make_interval(secs => idle_seconds);
  IF NOT FOUND THEN RETURN; END IF;

  SELECT * INTO u FROM users WHERE id = s.user_id AND status = 'active';
  IF NOT FOUND THEN RETURN; END IF;

  v_mfa := EXISTS (SELECT 1 FROM user_mfa WHERE user_id = u.id AND enabled_at IS NOT NULL);
  -- Súper admin "efectivo" = lo es Y tiene 2FA. Sin 2FA se comporta como usuario común.
  v_super := u.is_super_admin AND v_mfa;

  IF s.last_seen_at < now() - interval '60 seconds' THEN
    UPDATE sessions SET last_seen_at = now() WHERE id = s.id;
  END IF;

  IF s.acting_tenant_id IS NOT NULL
     AND (NOT v_super OR s.acting_until IS NULL OR s.acting_until <= now()) THEN
    UPDATE sessions SET acting_tenant_id = NULL, acting_until = NULL WHERE id = s.id;
    s.acting_tenant_id := NULL;
  END IF;

  RETURN QUERY SELECT
    s.id, u.id, u.email, v_super, s.active_tenant_id,
    (SELECT t.status FROM tenants t WHERE t.id = s.active_tenant_id),
    (SELECT m.role FROM memberships m
       WHERE m.tenant_id = s.active_tenant_id AND m.user_id = u.id),
    s.acting_tenant_id,
    v_mfa,
    (u.is_super_admin AND NOT v_mfa);
END
$$;

-- ===================================================== 2FA: iniciar sesión
-- Datos para verificar el código de una sesión pendiente.
CREATE FUNCTION mfa_get_pending(p_token_hash bytea)
RETURNS TABLE (p_user_id uuid, p_secret_enc text, p_key_version integer, p_last_step bigint, p_locked_until timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT s.user_id, f.secret_enc, f.key_version, f.last_step, f.locked_until
  FROM sessions s
  JOIN users u ON u.id = s.user_id AND u.status = 'active'
  JOIN user_mfa f ON f.user_id = s.user_id AND f.enabled_at IS NOT NULL
  WHERE s.token_hash = p_token_hash AND s.mfa_pending
    AND s.revoked_at IS NULL AND now() < s.expires_at
    AND now() < s.last_seen_at + make_interval(secs => s.idle_seconds)
$$;

-- Registra un fallo de código (sesión pendiente o completa). true = quedó bloqueado.
CREATE FUNCTION mfa_fail(p_token_hash bytea) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE v_user uuid;
BEGIN
  v_user := auth_session_user_any(p_token_hash);
  IF v_user IS NULL THEN RETURN false; END IF;
  RETURN mfa_register_failure(v_user);
END
$$;

-- Completa el 2FA con un código TOTP ya validado por la app (paso p_step).
-- Devuelve los segundos de vida de la sesión nueva, o NULL si no procede.
CREATE FUNCTION mfa_complete(p_pending_hash bytea, p_step bigint, p_new_hash bytea, p_user_agent text)
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE v_user uuid;
BEGIN
  SELECT g.p_user_id INTO v_user FROM mfa_get_pending(p_pending_hash) g;
  IF v_user IS NULL THEN RETURN NULL; END IF;
  IF EXISTS (SELECT 1 FROM user_mfa WHERE user_id = v_user AND locked_until > now()) THEN
    RETURN NULL;
  END IF;
  -- Un paso de tiempo solo se acepta una vez (el UPDATE es atómico).
  UPDATE user_mfa SET last_step = p_step, failed_attempts = 0, locked_until = NULL
    WHERE user_id = v_user AND enabled_at IS NOT NULL AND last_step < p_step;
  IF NOT FOUND THEN RETURN NULL; END IF;

  UPDATE sessions SET revoked_at = now() WHERE token_hash = p_pending_hash;
  RETURN auth_issue_session(v_user, p_new_hash, p_user_agent, false);
END
$$;

-- Completa el 2FA con un código de recuperación (de un solo uso).
CREATE FUNCTION mfa_complete_recovery(
  p_pending_hash bytea, p_code_hash bytea, p_new_hash bytea, p_user_agent text
) RETURNS TABLE (max_age_seconds integer, codes_left integer)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE v_user uuid; v_age integer;
BEGIN
  SELECT g.p_user_id INTO v_user FROM mfa_get_pending(p_pending_hash) g;
  IF v_user IS NULL THEN RETURN; END IF;
  IF EXISTS (SELECT 1 FROM user_mfa WHERE user_id = v_user AND locked_until > now()) THEN
    RETURN;
  END IF;
  UPDATE mfa_recovery_codes SET used_at = now()
    WHERE user_id = v_user AND code_hash = p_code_hash AND used_at IS NULL;
  IF NOT FOUND THEN
    PERFORM mfa_register_failure(v_user);
    RETURN;
  END IF;
  UPDATE user_mfa SET failed_attempts = 0, locked_until = NULL WHERE user_id = v_user;
  UPDATE sessions SET revoked_at = now() WHERE token_hash = p_pending_hash;
  v_age := auth_issue_session(v_user, p_new_hash, p_user_agent, false);
  RETURN QUERY SELECT v_age,
    (SELECT count(*)::integer FROM mfa_recovery_codes WHERE user_id = v_user AND used_at IS NULL);
END
$$;

-- ================================================ 2FA: configurar y apagar
CREATE FUNCTION mfa_status(p_token_hash bytea)
RETURNS TABLE (st_enabled boolean, st_codes_left integer)
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE v_user uuid;
BEGIN
  v_user := auth_session_user(p_token_hash);
  IF v_user IS NULL THEN RETURN; END IF;
  RETURN QUERY SELECT
    EXISTS (SELECT 1 FROM user_mfa WHERE user_id = v_user AND enabled_at IS NOT NULL),
    (SELECT count(*)::integer FROM mfa_recovery_codes WHERE user_id = v_user AND used_at IS NULL);
END
$$;

-- Guarda el secreto (ya cifrado) de una configuración nueva. false = ya estaba activo.
CREATE FUNCTION mfa_setup_start(p_token_hash bytea, p_secret_enc text, p_key_version integer)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE v_user uuid;
BEGIN
  v_user := auth_session_user(p_token_hash);
  IF v_user IS NULL THEN
    RAISE EXCEPTION 'no autorizado' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF EXISTS (SELECT 1 FROM user_mfa WHERE user_id = v_user AND enabled_at IS NOT NULL) THEN
    RETURN false;
  END IF;
  INSERT INTO user_mfa (user_id, secret_enc, key_version)
    VALUES (v_user, p_secret_enc, p_key_version)
    ON CONFLICT (user_id) DO UPDATE
      SET secret_enc = EXCLUDED.secret_enc, key_version = EXCLUDED.key_version,
          last_step = 0, failed_attempts = 0, locked_until = NULL, created_at = now();
  RETURN true;
END
$$;

-- Secreto del propio usuario (configuración pendiente o activo) para verificar un código.
CREATE FUNCTION mfa_get_secret(p_token_hash bytea)
RETURNS TABLE (g_secret_enc text, g_key_version integer, g_last_step bigint,
               g_locked_until timestamptz, g_enabled boolean)
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE v_user uuid;
BEGIN
  v_user := auth_session_user(p_token_hash);
  IF v_user IS NULL THEN RETURN; END IF;
  RETURN QUERY SELECT f.secret_enc, f.key_version, f.last_step, f.locked_until,
                      f.enabled_at IS NOT NULL
               FROM user_mfa f WHERE f.user_id = v_user;
END
$$;

-- Activa el 2FA tras comprobar el primer código. Cierra las DEMÁS sesiones.
CREATE FUNCTION mfa_setup_enable(p_token_hash bytea, p_step bigint, p_code_hashes bytea[])
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE v_user uuid; v_tenant uuid;
BEGIN
  v_user := auth_session_user(p_token_hash);
  IF v_user IS NULL THEN
    RAISE EXCEPTION 'no autorizado' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF coalesce(array_length(p_code_hashes, 1), 0) <> 10 THEN
    RAISE EXCEPTION 'se esperan 10 códigos' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  UPDATE user_mfa SET enabled_at = now(), last_step = p_step, failed_attempts = 0, locked_until = NULL
    WHERE user_id = v_user AND enabled_at IS NULL AND last_step < p_step;
  IF NOT FOUND THEN RETURN false; END IF;

  DELETE FROM mfa_recovery_codes WHERE user_id = v_user;
  INSERT INTO mfa_recovery_codes (user_id, code_hash)
    SELECT v_user, h FROM unnest(p_code_hashes) AS h;

  UPDATE sessions SET revoked_at = now()
    WHERE user_id = v_user AND revoked_at IS NULL AND token_hash <> p_token_hash;

  SELECT active_tenant_id INTO v_tenant FROM sessions WHERE token_hash = p_token_hash;
  IF v_tenant IS NOT NULL THEN
    INSERT INTO audit_log (tenant_id, actor_id, action, target_type, target_id)
      VALUES (v_tenant, v_user, 'user.mfa.enabled', 'user', v_user::text);
  END IF;
  RETURN true;
END
$$;

-- Apaga el 2FA. La app ya comprobó contraseña y código. El súper admin NO puede apagarlo.
CREATE FUNCTION mfa_disable(p_token_hash bytea, p_step bigint) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE v_user uuid; v_tenant uuid;
BEGIN
  v_user := auth_session_user(p_token_hash);
  IF v_user IS NULL OR EXISTS (SELECT 1 FROM users WHERE id = v_user AND is_super_admin) THEN
    RAISE EXCEPTION 'no autorizado' USING ERRCODE = 'insufficient_privilege';
  END IF;
  UPDATE user_mfa SET last_step = p_step
    WHERE user_id = v_user AND enabled_at IS NOT NULL AND last_step < p_step;
  IF NOT FOUND THEN RETURN false; END IF;

  SELECT active_tenant_id INTO v_tenant FROM sessions WHERE token_hash = p_token_hash;
  DELETE FROM mfa_recovery_codes WHERE user_id = v_user;
  DELETE FROM user_mfa WHERE user_id = v_user;
  UPDATE sessions SET revoked_at = now()
    WHERE user_id = v_user AND revoked_at IS NULL AND token_hash <> p_token_hash;
  IF v_tenant IS NOT NULL THEN
    INSERT INTO audit_log (tenant_id, actor_id, action, target_type, target_id)
      VALUES (v_tenant, v_user, 'user.mfa.disabled', 'user', v_user::text);
  END IF;
  RETURN true;
END
$$;

-- Genera códigos de recuperación nuevos (los anteriores dejan de servir).
CREATE FUNCTION mfa_regenerate_codes(p_token_hash bytea, p_step bigint, p_code_hashes bytea[])
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE v_user uuid; v_tenant uuid;
BEGIN
  v_user := auth_session_user(p_token_hash);
  IF v_user IS NULL THEN
    RAISE EXCEPTION 'no autorizado' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF coalesce(array_length(p_code_hashes, 1), 0) <> 10 THEN
    RAISE EXCEPTION 'se esperan 10 códigos' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  UPDATE user_mfa SET last_step = p_step
    WHERE user_id = v_user AND enabled_at IS NOT NULL AND last_step < p_step;
  IF NOT FOUND THEN RETURN false; END IF;

  DELETE FROM mfa_recovery_codes WHERE user_id = v_user;
  INSERT INTO mfa_recovery_codes (user_id, code_hash)
    SELECT v_user, h FROM unnest(p_code_hashes) AS h;

  SELECT active_tenant_id INTO v_tenant FROM sessions WHERE token_hash = p_token_hash;
  IF v_tenant IS NOT NULL THEN
    INSERT INTO audit_log (tenant_id, actor_id, action, target_type, target_id)
      VALUES (v_tenant, v_user, 'user.mfa.codes_regenerated', 'user', v_user::text);
  END IF;
  RETURN true;
END
$$;

-- ========================================================= equipo
-- Reglas: dueño y admin ven el equipo; el admin solo invita/quita agentes;
-- solo el dueño cambia roles; el dueño nunca se quita ni se degrada.

CREATE FUNCTION team_members(p_token_hash bytea, p_tenant_id uuid)
RETURNS TABLE (m_user_id uuid, m_email text, m_role text, m_since timestamptz, m_mfa boolean)
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE v_role text;
BEGIN
  v_role := auth_tenant_role(p_token_hash, p_tenant_id);
  IF v_role IS NULL OR v_role NOT IN ('owner', 'admin') THEN
    RAISE EXCEPTION 'no autorizado' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN QUERY
    SELECT u.id, u.email, m.role, m.created_at,
           EXISTS (SELECT 1 FROM user_mfa f WHERE f.user_id = u.id AND f.enabled_at IS NOT NULL)
    FROM memberships m JOIN users u ON u.id = m.user_id
    WHERE m.tenant_id = p_tenant_id
    ORDER BY (m.role = 'owner') DESC, m.created_at;
END
$$;

CREATE FUNCTION team_invitations(p_token_hash bytea, p_tenant_id uuid)
RETURNS TABLE (i_id uuid, i_email text, i_role text, i_created timestamptz, i_expires timestamptz)
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE v_role text;
BEGIN
  v_role := auth_tenant_role(p_token_hash, p_tenant_id);
  IF v_role IS NULL OR v_role NOT IN ('owner', 'admin') THEN
    RAISE EXCEPTION 'no autorizado' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN QUERY
    SELECT i.id, i.email, i.role, i.created_at, i.expires_at
    FROM invitations i
    WHERE i.tenant_id = p_tenant_id AND i.accepted_at IS NULL AND i.revoked_at IS NULL
      AND i.expires_at > now()
    ORDER BY i.created_at DESC;
END
$$;

CREATE FUNCTION team_invite(
  p_token_hash bytea, p_tenant_id uuid, p_email text, p_role text, p_inv_hash bytea
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE v_role text; v_actor uuid; v_email text; v_id uuid;
BEGIN
  v_role := auth_tenant_role(p_token_hash, p_tenant_id);
  IF v_role IS NULL OR v_role NOT IN ('owner', 'admin') THEN
    RAISE EXCEPTION 'no autorizado' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_role NOT IN ('admin', 'agent') THEN
    RAISE EXCEPTION 'rol inválido' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF v_role = 'admin' AND p_role <> 'agent' THEN
    RAISE EXCEPTION 'no autorizado' USING ERRCODE = 'insufficient_privilege';
  END IF;
  v_email := lower(btrim(p_email));
  IF char_length(v_email) < 3 OR char_length(v_email) > 254 THEN
    RAISE EXCEPTION 'correo inválido' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF EXISTS (
    SELECT 1 FROM memberships m JOIN users u ON u.id = m.user_id
    WHERE m.tenant_id = p_tenant_id AND u.email = v_email
  ) THEN
    RAISE EXCEPTION 'ya es miembro' USING ERRCODE = 'unique_violation';
  END IF;
  -- Tope provisional de 25 entre miembros e invitaciones pendientes (luego lo fijará el plan).
  IF (SELECT count(*) FROM memberships WHERE tenant_id = p_tenant_id)
     + (SELECT count(*) FROM invitations
        WHERE tenant_id = p_tenant_id AND accepted_at IS NULL AND revoked_at IS NULL
          AND expires_at > now()) >= 25 THEN
    RAISE EXCEPTION 'límite de equipo' USING ERRCODE = 'program_limit_exceeded';
  END IF;

  v_actor := auth_session_user(p_token_hash);
  UPDATE invitations SET revoked_at = now()
    WHERE tenant_id = p_tenant_id AND email = v_email AND accepted_at IS NULL AND revoked_at IS NULL;
  INSERT INTO invitations (tenant_id, email, role, token_hash, invited_by, expires_at)
    VALUES (p_tenant_id, v_email, p_role, p_inv_hash, v_actor, now() + interval '7 days')
    RETURNING id INTO v_id;
  INSERT INTO audit_log (tenant_id, actor_id, action, target_type, target_id, metadata)
    VALUES (p_tenant_id, v_actor, 'team.invited', 'invitation', v_id::text,
            jsonb_build_object('email', v_email, 'role', p_role));
  RETURN v_id;
END
$$;

CREATE FUNCTION team_revoke_invitation(p_token_hash bytea, p_tenant_id uuid, p_invitation_id uuid)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE v_role text; v_email text; v_inv_role text;
BEGIN
  v_role := auth_tenant_role(p_token_hash, p_tenant_id);
  IF v_role IS NULL OR v_role NOT IN ('owner', 'admin') THEN
    RAISE EXCEPTION 'no autorizado' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT email, role INTO v_email, v_inv_role FROM invitations
    WHERE id = p_invitation_id AND tenant_id = p_tenant_id
      AND accepted_at IS NULL AND revoked_at IS NULL;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'invitación inexistente' USING ERRCODE = 'no_data_found';
  END IF;
  IF v_role = 'admin' AND v_inv_role <> 'agent' THEN
    RAISE EXCEPTION 'no autorizado' USING ERRCODE = 'insufficient_privilege';
  END IF;
  UPDATE invitations SET revoked_at = now() WHERE id = p_invitation_id;
  INSERT INTO audit_log (tenant_id, actor_id, action, target_type, target_id, metadata)
    VALUES (p_tenant_id, auth_session_user(p_token_hash), 'team.invitation_revoked',
            'invitation', p_invitation_id::text, jsonb_build_object('email', v_email));
END
$$;

CREATE FUNCTION team_set_role(p_token_hash bytea, p_tenant_id uuid, p_user_id uuid, p_role text)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE v_role text; v_old text;
BEGIN
  v_role := auth_tenant_role(p_token_hash, p_tenant_id);
  -- Impersonar (soporte) actúa como 'admin' y por eso no puede cambiar roles.
  IF v_role IS DISTINCT FROM 'owner' THEN
    RAISE EXCEPTION 'no autorizado' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_role NOT IN ('admin', 'agent') THEN
    RAISE EXCEPTION 'rol inválido' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  SELECT role INTO v_old FROM memberships WHERE tenant_id = p_tenant_id AND user_id = p_user_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'miembro inexistente' USING ERRCODE = 'no_data_found';
  END IF;
  IF v_old = 'owner' THEN
    RAISE EXCEPTION 'el dueño no se modifica' USING ERRCODE = 'insufficient_privilege';
  END IF;
  UPDATE memberships SET role = p_role WHERE tenant_id = p_tenant_id AND user_id = p_user_id;
  INSERT INTO audit_log (tenant_id, actor_id, action, target_type, target_id, metadata)
    VALUES (p_tenant_id, auth_session_user(p_token_hash), 'team.role_changed', 'user',
            p_user_id::text, jsonb_build_object('from', v_old, 'to', p_role));
END
$$;

CREATE FUNCTION team_remove(p_token_hash bytea, p_tenant_id uuid, p_user_id uuid)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE v_role text; v_target text; v_actor uuid;
BEGIN
  v_role := auth_tenant_role(p_token_hash, p_tenant_id);
  IF v_role IS NULL OR v_role NOT IN ('owner', 'admin') THEN
    RAISE EXCEPTION 'no autorizado' USING ERRCODE = 'insufficient_privilege';
  END IF;
  v_actor := auth_session_user(p_token_hash);
  IF p_user_id = v_actor THEN
    RAISE EXCEPTION 'no puedes quitarte a ti mismo' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  SELECT role INTO v_target FROM memberships WHERE tenant_id = p_tenant_id AND user_id = p_user_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'miembro inexistente' USING ERRCODE = 'no_data_found';
  END IF;
  IF v_target = 'owner' OR (v_role = 'admin' AND v_target <> 'agent') THEN
    RAISE EXCEPTION 'no autorizado' USING ERRCODE = 'insufficient_privilege';
  END IF;
  DELETE FROM memberships WHERE tenant_id = p_tenant_id AND user_id = p_user_id;
  -- Sus sesiones dejan de apuntar a este negocio (pasan a otro suyo, o a ninguno).
  UPDATE sessions s SET active_tenant_id =
      (SELECT m.tenant_id FROM memberships m WHERE m.user_id = p_user_id ORDER BY m.created_at LIMIT 1)
    WHERE s.user_id = p_user_id AND s.active_tenant_id = p_tenant_id;
  INSERT INTO audit_log (tenant_id, actor_id, action, target_type, target_id, metadata)
    VALUES (p_tenant_id, v_actor, 'team.removed', 'user', p_user_id::text,
            jsonb_build_object('role', v_target));
END
$$;

-- ================================================ invitaciones (públicas)
-- Ver a qué negocio se invita (para pintar la pantalla). Necesita el token secreto.
CREATE FUNCTION invite_peek(p_inv_hash bytea)
RETURNS TABLE (v_email text, v_role text, v_tenant_name text, v_user_exists boolean)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT i.email, i.role, t.name, EXISTS (SELECT 1 FROM users u WHERE u.email = i.email)
  FROM invitations i JOIN tenants t ON t.id = i.tenant_id
  WHERE i.token_hash = p_inv_hash AND i.accepted_at IS NULL AND i.revoked_at IS NULL
    AND i.expires_at > now()
$$;

-- Crear la cuenta de la persona invitada. El correo sale de la invitación, no del formulario.
CREATE FUNCTION invite_signup(p_inv_hash bytea, p_password_hash text) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE i invitations%ROWTYPE; v_user uuid;
BEGIN
  SELECT * INTO i FROM invitations
    WHERE token_hash = p_inv_hash AND accepted_at IS NULL AND revoked_at IS NULL
      AND expires_at > now()
    FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'invitación inválida' USING ERRCODE = 'no_data_found';
  END IF;
  INSERT INTO users (email, password_hash) VALUES (i.email, p_password_hash)
    RETURNING id INTO v_user;                      -- 23505 si ya existe
  INSERT INTO memberships (tenant_id, user_id, role) VALUES (i.tenant_id, v_user, i.role);
  UPDATE invitations SET accepted_at = now() WHERE id = i.id;
  INSERT INTO audit_log (tenant_id, actor_id, action, target_type, target_id, metadata)
    VALUES (i.tenant_id, v_user, 'team.joined', 'user', v_user::text,
            jsonb_build_object('role', i.role));
  RETURN v_user;
END
$$;

-- Aceptar estando ya con sesión: solo si la sesión es del correo invitado.
CREATE FUNCTION invite_accept(p_token_hash bytea, p_inv_hash bytea) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE i invitations%ROWTYPE; v_user uuid; v_email text;
BEGIN
  v_user := auth_session_user(p_token_hash);
  IF v_user IS NULL THEN
    RAISE EXCEPTION 'no autorizado' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT email INTO v_email FROM users WHERE id = v_user;
  SELECT * INTO i FROM invitations
    WHERE token_hash = p_inv_hash AND accepted_at IS NULL AND revoked_at IS NULL
      AND expires_at > now()
    FOR UPDATE;
  IF NOT FOUND OR i.email <> v_email THEN
    RAISE EXCEPTION 'invitación inválida' USING ERRCODE = 'no_data_found';
  END IF;
  INSERT INTO memberships (tenant_id, user_id, role) VALUES (i.tenant_id, v_user, i.role)
    ON CONFLICT (tenant_id, user_id) DO NOTHING;
  UPDATE invitations SET accepted_at = now() WHERE id = i.id;
  UPDATE sessions SET active_tenant_id = i.tenant_id WHERE token_hash = p_token_hash;
  INSERT INTO audit_log (tenant_id, actor_id, action, target_type, target_id, metadata)
    VALUES (i.tenant_id, v_user, 'team.joined', 'user', v_user::text,
            jsonb_build_object('role', i.role));
  RETURN i.tenant_id;
END
$$;

-- ============================================================== permisos
REVOKE ALL ON FUNCTION
  auth_session_user_any(bytea), auth_issue_session(uuid, bytea, text, boolean),
  mfa_register_failure(uuid), auth_tenant_role(bytea, uuid),
  auth_create_session(uuid, bytea, text), auth_get_session(bytea),
  mfa_get_pending(bytea), mfa_fail(bytea), mfa_complete(bytea, bigint, bytea, text),
  mfa_complete_recovery(bytea, bytea, bytea, text),
  mfa_status(bytea), mfa_setup_start(bytea, text, integer), mfa_get_secret(bytea),
  mfa_setup_enable(bytea, bigint, bytea[]), mfa_disable(bytea, bigint),
  mfa_regenerate_codes(bytea, bigint, bytea[]),
  team_members(bytea, uuid), team_invitations(bytea, uuid),
  team_invite(bytea, uuid, text, text, bytea), team_revoke_invitation(bytea, uuid, uuid),
  team_set_role(bytea, uuid, uuid, text), team_remove(bytea, uuid, uuid),
  invite_peek(bytea), invite_signup(bytea, text), invite_accept(bytea, bytea)
FROM PUBLIC;

-- Internas (NO se otorgan): auth_session_user_any, auth_issue_session,
-- mfa_register_failure, auth_tenant_role.
GRANT EXECUTE ON FUNCTION
  auth_create_session(uuid, bytea, text), auth_get_session(bytea),
  mfa_get_pending(bytea), mfa_fail(bytea), mfa_complete(bytea, bigint, bytea, text),
  mfa_complete_recovery(bytea, bytea, bytea, text),
  mfa_status(bytea), mfa_setup_start(bytea, text, integer), mfa_get_secret(bytea),
  mfa_setup_enable(bytea, bigint, bytea[]), mfa_disable(bytea, bigint),
  mfa_regenerate_codes(bytea, bigint, bytea[]),
  team_members(bytea, uuid), team_invitations(bytea, uuid),
  team_invite(bytea, uuid, text, text, bytea), team_revoke_invitation(bytea, uuid, uuid),
  team_set_role(bytea, uuid, uuid, text), team_remove(bytea, uuid, uuid),
  invite_peek(bytea), invite_signup(bytea, text), invite_accept(bytea, bytea)
TO app_user;
