-- Paso 30: correos automáticos (verificación, recuperar contraseña, invitaciones, avisos de plan y cobros).
-- Diseño:
--  * Bandeja de salida (email_outbox) SIN acceso directo para la aplicación: solo funciones definer. Los cuerpos con enlaces secretos
--    se borran al enviarse (salvo en el proveedor de desarrollo, donde son la bandeja visible).
--  * Los enlaces llevan un token aleatorio de 32 bytes; en la base solo queda su hash. De un solo uso y con vencimiento.
--  * Recuperar contraseña: no revela si el correo existe, máximo 3 solicitudes por hora por cuenta, al usarse cierra TODAS las sesiones.
--  * Verificación de correo: aviso suave (no bloquea). Las cuentas que ya existían se marcan como verificadas para no molestarlas.

-- ------------------------------------------------------------------ bandeja de salida
CREATE TABLE email_outbox (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid REFERENCES tenants (id) ON DELETE CASCADE,
  to_email text NOT NULL CHECK (to_email = lower(to_email) AND char_length(to_email) BETWEEN 3 AND 254 AND to_email !~ '[\s<>,;"\r\n]'),
  template text NOT NULL CHECK (char_length(template) BETWEEN 1 AND 60),
  subject text NOT NULL CHECK (char_length(subject) BETWEEN 1 AND 200 AND subject !~ '[\r\n]'),
  body_text text CHECK (char_length(body_text) <= 20000),
  body_html text CHECK (char_length(body_html) <= 60000),
  status text NOT NULL DEFAULT 'pendiente' CHECK (status IN ('pendiente', 'enviado', 'fallido')),
  attempts integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  locked_until timestamptz,
  last_error text CHECK (char_length(last_error) <= 300),
  provider text,
  provider_id text,
  dedupe_key text UNIQUE CHECK (char_length(dedupe_key) <= 200),
  created_at timestamptz NOT NULL DEFAULT now(),
  sent_at timestamptz
);
CREATE INDEX email_outbox_pendientes_idx ON email_outbox (next_attempt_at) WHERE status = 'pendiente';
CREATE INDEX email_outbox_recientes_idx ON email_outbox (created_at DESC);
ALTER TABLE email_outbox ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON email_outbox FROM PUBLIC, app_user;

-- Encola un correo. Con dedupe_key repetida no hace nada (devuelve NULL). Tope: 5000 pendientes en total (freno de emergencia).
CREATE FUNCTION email_enqueue(p_tenant uuid, p_to text, p_template text, p_subject text, p_text text, p_html text, p_dedupe text) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE v_id uuid;
BEGIN
  IF (SELECT count(*) FROM email_outbox WHERE status = 'pendiente') >= 5000 THEN
    RAISE WARNING 'email_enqueue: demasiados correos pendientes';
    RETURN NULL;
  END IF;
  INSERT INTO email_outbox (tenant_id, to_email, template, subject, body_text, body_html, dedupe_key)
  VALUES (p_tenant, lower(p_to), p_template, p_subject, p_text, p_html, p_dedupe)
  ON CONFLICT (dedupe_key) DO NOTHING
  RETURNING id INTO v_id;
  RETURN v_id;
END
$$;

-- El worker toma correos vencidos y los bloquea unos segundos (varios workers no toman el mismo).
CREATE FUNCTION email_claim(p_limit integer, p_lock_seconds integer)
RETURNS TABLE (out_id uuid, out_to text, out_subject text, out_text text, out_html text, out_attempts integer, out_template text)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  RETURN QUERY
  WITH c AS (
    SELECT o.id FROM email_outbox o
     WHERE o.status = 'pendiente' AND o.next_attempt_at <= now() AND (o.locked_until IS NULL OR o.locked_until < now())
     ORDER BY o.next_attempt_at LIMIT greatest(1, least(p_limit, 50)) FOR UPDATE SKIP LOCKED
  )
  UPDATE email_outbox o SET locked_until = now() + make_interval(secs => p_lock_seconds), attempts = o.attempts + 1
    FROM c WHERE o.id = c.id
  RETURNING o.id, o.to_email, o.subject, o.body_text, o.body_html, o.attempts, o.template;
END
$$;

-- Resultado de un envío. p_retry_in: segundos hasta el próximo intento (NULL = se rindió). p_purge: borrar los cuerpos (tienen enlaces secretos).
CREATE FUNCTION email_mark(p_id uuid, p_sent boolean, p_error text, p_provider text, p_provider_id text, p_retry_in integer, p_purge boolean) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF p_sent THEN
    UPDATE email_outbox SET status = 'enviado', sent_at = now(), provider = p_provider, provider_id = left(p_provider_id, 200), last_error = NULL, locked_until = NULL,
           body_text = CASE WHEN p_purge THEN NULL ELSE body_text END, body_html = CASE WHEN p_purge THEN NULL ELSE body_html END
     WHERE id = p_id;
  ELSIF p_retry_in IS NOT NULL THEN
    UPDATE email_outbox SET last_error = left(p_error, 300), next_attempt_at = now() + make_interval(secs => p_retry_in), locked_until = NULL WHERE id = p_id;
  ELSE
    UPDATE email_outbox SET status = 'fallido', last_error = left(p_error, 300), locked_until = NULL, provider = p_provider,
           body_text = NULL, body_html = NULL WHERE id = p_id;
  END IF;
END
$$;

-- Limpieza: los registros viejos se borran (30 días los enviados; 90 los fallidos).
CREATE FUNCTION email_purge() RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE n integer;
BEGIN
  DELETE FROM email_outbox WHERE (status = 'enviado' AND created_at < now() - interval '30 days') OR (status = 'fallido' AND created_at < now() - interval '90 days');
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END
$$;

-- Bandeja de desarrollo: últimos correos (la aplicación SOLO la llama cuando las herramientas de desarrollo están encendidas).
CREATE FUNCTION email_dev_list(p_limit integer)
RETURNS TABLE (out_id uuid, out_to text, out_subject text, out_text text, out_status text, out_template text, out_created timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT id, to_email, subject, body_text, status, template, created_at FROM email_outbox ORDER BY created_at DESC LIMIT greatest(1, least(p_limit, 100))
$$;

-- ------------------------------------------------------------------ recuperar contraseña
CREATE TABLE password_resets (
  token_hash bytea PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX password_resets_usuario_idx ON password_resets (user_id, created_at DESC);
ALTER TABLE password_resets ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON password_resets FROM PUBLIC, app_user;

-- Crea la solicitud. Devuelve el correo SOLO si hay que mandar el mensaje (cuenta activa y sin abuso); si no, NULL (la app responde igual).
CREATE FUNCTION auth_request_reset(p_email text, p_hash bytea) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE v_user uuid; v_email text;
BEGIN
  SELECT id, email INTO v_user, v_email FROM users WHERE email = lower(p_email) AND status = 'active';
  IF v_user IS NULL THEN RETURN NULL; END IF;
  IF (SELECT count(*) FROM password_resets WHERE user_id = v_user AND created_at > now() - interval '1 hour') >= 3 THEN RETURN NULL; END IF;
  INSERT INTO password_resets (token_hash, user_id, expires_at) VALUES (p_hash, v_user, now() + interval '1 hour');
  RETURN v_email;
END
$$;

-- ¿El enlace sirve? Devuelve el correo de la cuenta (para validar la contraseña nueva) sin gastar el enlace.
CREATE FUNCTION auth_reset_peek(p_hash bytea) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT u.email FROM password_resets r JOIN users u ON u.id = r.user_id
   WHERE r.token_hash = p_hash AND r.used_at IS NULL AND r.expires_at > now() AND u.status = 'active'
$$;

-- Cambia la contraseña con el enlace (una sola vez). Cierra TODAS las sesiones, quita el bloqueo, anula los demás enlaces y deja constancia.
CREATE FUNCTION auth_reset_password(p_hash bytea, p_new_hash text) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE v_user uuid; v_email text; v_closed integer;
BEGIN
  UPDATE password_resets r SET used_at = now()
    FROM users u
   WHERE r.token_hash = p_hash AND r.used_at IS NULL AND r.expires_at > now() AND u.id = r.user_id AND u.status = 'active'
  RETURNING r.user_id, u.email INTO v_user, v_email;
  IF v_user IS NULL THEN RETURN NULL; END IF;
  UPDATE users SET password_hash = p_new_hash, failed_logins = 0, locked_until = NULL, email_verified_at = COALESCE(email_verified_at, now()) WHERE id = v_user;
  UPDATE password_resets SET used_at = now() WHERE user_id = v_user AND used_at IS NULL;
  UPDATE sessions SET revoked_at = now() WHERE user_id = v_user AND revoked_at IS NULL;
  GET DIAGNOSTICS v_closed = ROW_COUNT;
  INSERT INTO audit_log (tenant_id, actor_id, action, target_type, target_id, metadata)
    SELECT m.tenant_id, v_user, 'account.password_reset', 'user', v_user::text, jsonb_build_object('sessions_closed', v_closed)
      FROM memberships m WHERE m.user_id = v_user;
  RETURN v_email;
END
$$;

-- ------------------------------------------------------------------ verificación de correo
ALTER TABLE users ADD COLUMN email_verified_at timestamptz;
UPDATE users SET email_verified_at = created_at WHERE email_verified_at IS NULL;  -- cuentas anteriores: no se les pide nada

CREATE TABLE email_verifications (
  token_hash bytea PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX email_verifications_usuario_idx ON email_verifications (user_id, created_at DESC);
ALTER TABLE email_verifications ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON email_verifications FROM PUBLIC, app_user;

-- Crea el enlace de verificación. Devuelve el correo al que mandarlo, o NULL si ya está verificado, la cuenta no está activa o pidió demasiados (5 por hora).
CREATE FUNCTION auth_request_verification(p_user uuid, p_hash bytea) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE v_email text; v_verified timestamptz;
BEGIN
  SELECT email, email_verified_at INTO v_email, v_verified FROM users WHERE id = p_user AND status = 'active';
  IF v_email IS NULL OR v_verified IS NOT NULL THEN RETURN NULL; END IF;
  IF (SELECT count(*) FROM email_verifications WHERE user_id = p_user AND created_at > now() - interval '1 hour') >= 5 THEN RETURN NULL; END IF;
  INSERT INTO email_verifications (token_hash, user_id, expires_at) VALUES (p_hash, p_user, now() + interval '48 hours');
  RETURN v_email;
END
$$;

-- Confirma el correo con el enlace (una sola vez). Devuelve true si valió.
CREATE FUNCTION auth_verify_email(p_hash bytea) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE v_user uuid;
BEGIN
  UPDATE email_verifications SET used_at = now()
   WHERE token_hash = p_hash AND used_at IS NULL AND expires_at > now() RETURNING user_id INTO v_user;
  IF v_user IS NULL THEN RETURN false; END IF;
  UPDATE users SET email_verified_at = COALESCE(email_verified_at, now()) WHERE id = v_user AND status = 'active';
  RETURN true;
END
$$;

CREATE FUNCTION auth_email_verified(p_user uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT COALESCE((SELECT email_verified_at IS NOT NULL FROM users WHERE id = p_user), true)
$$;

-- Quien entra por una invitación recibió el enlace EN su correo: queda verificado sin pedirle nada más.
CREATE FUNCTION auth_mark_verified(p_user uuid) RETURNS void
LANGUAGE sql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  UPDATE users SET email_verified_at = COALESCE(email_verified_at, now()) WHERE id = p_user
$$;

-- ------------------------------------------------------------------ avisos de plan y cobros
-- Devuelve lo que falta avisar (la aplicación arma el texto y lo encola con la misma clave, así nunca se repite).
CREATE FUNCTION email_notice_candidates()
RETURNS TABLE (out_kind text, out_key text, out_tenant uuid, out_tenant_name text, out_to text, out_info jsonb)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  WITH owners AS (
    SELECT m.tenant_id, u.email FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.role = 'owner' AND u.status = 'active'
  ), c AS (
    SELECT 'trial_ending' AS kind, 'trial3:' || t.id || ':' || to_char(t.trial_ends_at, 'YYYYMMDD') AS key, t.id AS tid, t.name AS tname,
           jsonb_build_object('ends_at', t.trial_ends_at) AS info
      FROM tenants t WHERE t.status = 'trial' AND t.trial_ends_at > now() AND t.trial_ends_at < now() + interval '3 days'
    UNION ALL
    SELECT 'trial_ended', 'trial0:' || t.id || ':' || to_char(t.trial_ends_at, 'YYYYMMDD'), t.id, t.name, jsonb_build_object('ends_at', t.trial_ends_at)
      FROM tenants t WHERE t.status = 'trial' AND t.trial_ends_at <= now() AND t.trial_ends_at > now() - interval '14 days'
    UNION ALL
    SELECT 'plan_expiring', 'plan3:' || t.id || ':' || to_char(t.plan_expires_at, 'YYYYMMDD'), t.id, t.name, jsonb_build_object('ends_at', t.plan_expires_at)
      FROM tenants t WHERE t.status = 'active' AND t.plan_expires_at > now() AND t.plan_expires_at < now() + interval '3 days'
    UNION ALL
    SELECT 'plan_expired', 'plan0:' || t.id || ':' || to_char(t.plan_expires_at, 'YYYYMMDD'), t.id, t.name, jsonb_build_object('ends_at', t.plan_expires_at)
      FROM tenants t WHERE t.status = 'past_due' AND t.plan_expires_at IS NOT NULL AND t.plan_expires_at > now() - interval '14 days'
    UNION ALL
    SELECT CASE p.status WHEN 'confirmado' THEN 'payment_confirmed' ELSE 'payment_rejected' END, 'pay:' || p.id || ':' || p.status, t.id, t.name,
           jsonb_build_object('plan', pl.name, 'months', p.months, 'reason', p.reject_reason)
      FROM payments p JOIN tenants t ON t.id = p.tenant_id JOIN plans pl ON pl.id = p.plan_id
     WHERE p.status IN ('confirmado', 'rechazado') AND p.decided_at > now() - interval '2 days'
  )
  SELECT c.kind, c.key || ':' || o.email, c.tid, c.tname, o.email, c.info
    FROM c JOIN owners o ON o.tenant_id = c.tid
   WHERE NOT EXISTS (SELECT 1 FROM email_outbox x WHERE x.dedupe_key = c.key || ':' || o.email)
   LIMIT 200
$$;

REVOKE ALL ON FUNCTION email_enqueue(uuid, text, text, text, text, text, text), email_claim(integer, integer), email_mark(uuid, boolean, text, text, text, integer, boolean),
  email_purge(), email_dev_list(integer), auth_request_reset(text, bytea), auth_reset_peek(bytea), auth_reset_password(bytea, text),
  auth_request_verification(uuid, bytea), auth_verify_email(bytea), auth_email_verified(uuid), auth_mark_verified(uuid), email_notice_candidates() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION email_enqueue(uuid, text, text, text, text, text, text), email_claim(integer, integer), email_mark(uuid, boolean, text, text, text, integer, boolean),
  email_purge(), email_dev_list(integer), auth_request_reset(text, bytea), auth_reset_peek(bytea), auth_reset_password(bytea, text),
  auth_request_verification(uuid, bytea), auth_verify_email(bytea), auth_email_verified(uuid), auth_mark_verified(uuid), email_notice_candidates() TO app_user;
