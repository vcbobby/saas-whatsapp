-- Paso 36: seguridad de la cuenta.
--  (a) Cambiar la contraseña con 2FA activo exige un código válido (y NO reutilizado: se consume el paso, igual que al apagar el 2FA).
--  (b) Dispositivos conocidos por usuario, para avisar por correo cuando alguien entra desde uno nuevo.
-- Mismas reglas que el resto de la autenticación: app_user no ve estas tablas; solo llama a funciones.

CREATE FUNCTION auth_change_password_mfa(p_token_hash bytea, p_new_hash text, p_step bigint) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE v_user uuid;
BEGIN
  v_user := auth_session_user(p_token_hash);
  IF v_user IS NULL THEN
    RAISE EXCEPTION 'sesión no válida' USING ERRCODE = '42501';
  END IF;
  -- Consume el código: el mismo código no sirve dos veces.
  UPDATE user_mfa SET last_step = p_step
    WHERE user_id = v_user AND enabled_at IS NOT NULL AND last_step < p_step;
  IF NOT FOUND THEN RETURN -1; END IF;
  RETURN auth_change_password(p_token_hash, p_new_hash);
END
$$;
REVOKE ALL ON FUNCTION auth_change_password_mfa(bytea, text, bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION auth_change_password_mfa(bytea, text, bigint) TO app_user;

-- Dispositivos (navegador + sistema) desde los que cada persona ha entrado. No se guarda el texto completo del navegador:
-- solo una etiqueta legible («Chrome en Windows»), su huella, la fecha y la última IP vista.
CREATE TABLE login_devices (
  user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  device_hash text NOT NULL CHECK (char_length(device_hash) BETWEEN 8 AND 64),
  label text NOT NULL CHECK (char_length(label) <= 80),
  first_seen timestamptz NOT NULL DEFAULT now(),
  last_seen timestamptz NOT NULL DEFAULT now(),
  last_ip text CHECK (char_length(last_ip) <= 64),
  PRIMARY KEY (user_id, device_hash)
);
ALTER TABLE login_devices ENABLE ROW LEVEL SECURITY;
ALTER TABLE login_devices FORCE ROW LEVEL SECURITY;
CREATE POLICY login_devices_funciones ON login_devices
  USING (CURRENT_USER = 'app_owner' AND SESSION_USER <> 'app_owner')
  WITH CHECK (CURRENT_USER = 'app_owner' AND SESSION_USER <> 'app_owner');
REVOKE ALL ON login_devices FROM PUBLIC, app_user;

-- Registra el dispositivo. is_new = true solo si es NUEVO y la persona ya tenía otros (el primero, el del registro, no avisa).
-- Devuelve también el correo de la cuenta, para poder avisarle (app_user no puede leer la tabla de usuarios).
CREATE FUNCTION login_device_seen(p_user uuid, p_hash text, p_label text, p_ip text) RETURNS TABLE (is_new boolean, user_email text)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE v_known integer; v_new boolean; v_email text;
BEGIN
  SELECT count(*) INTO v_known FROM login_devices WHERE user_id = p_user;
  INSERT INTO login_devices (user_id, device_hash, label, last_ip) VALUES (p_user, p_hash, left(p_label, 80), left(p_ip, 64))
    ON CONFLICT (user_id, device_hash) DO UPDATE SET last_seen = now(), last_ip = EXCLUDED.last_ip, label = EXCLUDED.label
    RETURNING (xmax = 0) INTO v_new;
  -- Máximo 30 dispositivos por persona: se olvidan los más antiguos.
  DELETE FROM login_devices WHERE user_id = p_user AND device_hash IN (
    SELECT device_hash FROM login_devices WHERE user_id = p_user ORDER BY last_seen DESC OFFSET 30);
  SELECT u.email INTO v_email FROM users u WHERE u.id = p_user;
  RETURN QUERY SELECT (v_new AND v_known > 0), v_email;
END
$$;
REVOKE ALL ON FUNCTION login_device_seen(uuid, text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION login_device_seen(uuid, text, text, text) TO app_user;
