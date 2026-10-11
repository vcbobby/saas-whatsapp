-- 0009: corrige una condición de carrera en el tope de sesiones (Paso 9C).
-- Con muchos inicios de sesión simultáneos del mismo usuario se podía pasar de 10 sesiones activas
-- (o de 3 pendientes de 2FA). Ahora cada usuario emite sesiones de una en una.
CREATE OR REPLACE FUNCTION auth_issue_session(
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

  -- Un inicio de sesión a la vez por usuario: sin este candado, varios simultáneos cuentan las sesiones
  -- activas ANTES de que los otros inserten la suya y se pasan del tope (se vio 12 de 10 bajo carga).
  PERFORM pg_advisory_xact_lock(hashtextextended('sesiones:' || p_user_id::text, 0));

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
