-- Paso 19D: perfil y cuenta.
-- Cambio de contraseña: solo con una sesión válida. Cierra las demás sesiones de la persona (si alguien más
-- tenía abierta su cuenta, deja de tener acceso) y deja constancia en el registro del negocio.
CREATE FUNCTION auth_change_password(p_token_hash bytea, p_new_hash text) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE v_user uuid; v_tenant uuid; v_closed integer;
BEGIN
  v_user := auth_session_user(p_token_hash);
  IF v_user IS NULL THEN
    RAISE EXCEPTION 'sesión no válida' USING ERRCODE = '42501';
  END IF;
  UPDATE users SET password_hash = p_new_hash, failed_logins = 0, locked_until = NULL WHERE id = v_user;
  UPDATE sessions SET revoked_at = now()
    WHERE user_id = v_user AND revoked_at IS NULL AND token_hash <> p_token_hash;
  GET DIAGNOSTICS v_closed = ROW_COUNT;
  SELECT active_tenant_id INTO v_tenant FROM sessions WHERE token_hash = p_token_hash;
  IF v_tenant IS NOT NULL THEN
    INSERT INTO audit_log (tenant_id, actor_id, action, target_type, target_id, metadata)
      VALUES (v_tenant, v_user, 'account.password_changed', 'user', v_user::text, jsonb_build_object('sessions_closed', v_closed));
  END IF;
  RETURN v_closed;
END
$$;
REVOKE ALL ON FUNCTION auth_change_password(bytea, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION auth_change_password(bytea, text) TO app_user;
