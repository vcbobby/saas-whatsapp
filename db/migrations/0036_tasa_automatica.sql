-- Paso 23: tasa BCV automática. El worker lee la tasa de fuentes externas y la aplica SOLO si pasa los controles.
-- Modo «manual» (por defecto): todo sigue como antes. Modo «auto»: la tasa se renueva sola; el admin siempre puede pisarla a mano.
ALTER TABLE platform_settings
  ADD COLUMN rate_mode text NOT NULL DEFAULT 'manual' CHECK (rate_mode IN ('auto', 'manual')),
  ADD COLUMN rate_source text CHECK (char_length(rate_source) <= 40),
  ADD COLUMN rate_last_attempt_at timestamptz,
  ADD COLUMN rate_last_ok_at timestamptz,
  ADD COLUMN rate_last_error text CHECK (char_length(rate_last_error) <= 300);

-- Historial de la tasa (solo cuando cambia, o cuando se rechazó un valor sospechoso). Nadie lo toca desde la aplicación.
CREATE TABLE rate_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  rate numeric(14,4) NOT NULL CHECK (rate > 0),
  source text NOT NULL CHECK (char_length(source) BETWEEN 1 AND 40),
  kind text NOT NULL CHECK (kind IN ('auto', 'manual', 'rejected')),
  note text CHECK (char_length(note) <= 300),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX rate_history_fecha_idx ON rate_history (created_at DESC);
ALTER TABLE rate_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE rate_history FORCE ROW LEVEL SECURITY;
CREATE POLICY rate_history_funciones ON rate_history
  USING (CURRENT_USER = 'app_owner' AND SESSION_USER <> 'app_owner')
  WITH CHECK (CURRENT_USER = 'app_owner' AND SESSION_USER <> 'app_owner');
REVOKE ALL ON rate_history FROM PUBLIC, app_user;

-- ¿Hay que ir a buscar la tasa? (lo consulta el worker; no revela nada sensible)
CREATE FUNCTION rate_mode() RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$ SELECT rate_mode FROM platform_settings $$;

-- Aplicar una tasa leída de una fuente. Devuelve 'ok', 'manual' (el admin tiene el modo manual: se ignora) o 'rejected'.
-- Control de cordura: si cambia más de ±15 % respecto a la tasa vigente, NO se aplica (queda en el historial para que el admin decida).
CREATE FUNCTION rate_apply_auto(p_rate numeric, p_source text) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE s platform_settings%ROWTYPE; v_pct numeric;
BEGIN
  IF p_rate IS NULL OR p_rate <= 0 OR p_rate > 100000000 THEN RAISE EXCEPTION 'tasa inválida' USING ERRCODE = 'invalid_parameter_value'; END IF;
  IF p_source IS NULL OR char_length(btrim(p_source)) NOT BETWEEN 1 AND 40 THEN RAISE EXCEPTION 'fuente inválida' USING ERRCODE = 'invalid_parameter_value'; END IF;
  SELECT * INTO s FROM platform_settings FOR UPDATE;
  IF s.rate_mode <> 'auto' THEN RETURN 'manual'; END IF;
  UPDATE platform_settings SET rate_last_attempt_at = now();
  IF s.bcv_rate IS NOT NULL AND (p_rate < s.bcv_rate * 0.85 OR p_rate > s.bcv_rate * 1.15) THEN
    v_pct := round((p_rate / s.bcv_rate - 1) * 100, 1);
    INSERT INTO rate_history (rate, source, kind, note) VALUES (round(p_rate, 4), p_source, 'rejected', 'Cambio de ' || v_pct || ' % respecto a ' || s.bcv_rate);
    UPDATE platform_settings SET rate_last_error = 'Valor rechazado por cambio brusco (' || v_pct || ' %). Revísalo y, si es correcto, escríbelo a mano.';
    RETURN 'rejected';
  END IF;
  IF s.bcv_rate IS DISTINCT FROM round(p_rate, 4) THEN
    INSERT INTO rate_history (rate, source, kind) VALUES (round(p_rate, 4), p_source, 'auto');
  END IF;
  -- Aunque el valor sea el mismo, se renueva la fecha: confirma que sigue vigente (si no, a las 36 h se cortaría el cobro en bolívares).
  UPDATE platform_settings SET bcv_rate = round(p_rate, 4), bcv_rate_at = now(), rate_source = p_source,
    rate_last_ok_at = now(), rate_last_error = NULL;
  RETURN 'ok';
END
$$;

-- Ninguna fuente respondió bien.
CREATE FUNCTION rate_report_failure(p_error text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
BEGIN
  UPDATE platform_settings SET rate_last_attempt_at = now(), rate_last_error = left(coalesce(nullif(btrim(p_error), ''), 'Error desconocido'), 300)
    WHERE rate_mode = 'auto';
END
$$;

-- Admin: elegir modo.
CREATE FUNCTION admin_set_rate_mode(p_token_hash bytea, p_mode text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE v_actor uuid;
BEGIN
  PERFORM admin_require(p_token_hash);
  IF p_mode NOT IN ('auto', 'manual') THEN RAISE EXCEPTION 'modo inválido' USING ERRCODE = 'invalid_parameter_value'; END IF;
  v_actor := auth_session_user(p_token_hash);
  UPDATE platform_settings SET rate_mode = p_mode, rate_last_error = NULL WHERE rate_mode IS DISTINCT FROM p_mode;
  INSERT INTO audit_log (tenant_id, actor_id, action, target_type, metadata)
    VALUES (NULL, v_actor, 'rate.mode', 'platform', jsonb_build_object('mode', p_mode));
END
$$;

-- Admin: historial reciente.
CREATE FUNCTION admin_rate_history(p_token_hash bytea) RETURNS TABLE (h_rate numeric, h_source text, h_kind text, h_note text, h_at timestamptz)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$
BEGIN
  PERFORM admin_require(p_token_hash);
  RETURN QUERY SELECT h.rate, h.source, h.kind, h.note, h.created_at FROM rate_history h ORDER BY h.created_at DESC, h.id LIMIT 30;
END
$$;

-- Guardar a mano: se anota en el historial; si el valor cambió, el modo pasa a «manual» (para que la automática no lo pise).
CREATE OR REPLACE FUNCTION admin_set_payment_settings(
  p_token_hash bytea, p_rate numeric, p_pm_bank text, p_pm_phone text, p_pm_holder_id text, p_pm_holder_name text,
  p_paypal text, p_binance text, p_notes text
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE v_old numeric;
BEGIN
  PERFORM admin_require(p_token_hash);
  IF p_rate IS NOT NULL AND (p_rate <= 0 OR p_rate > 100000000) THEN
    RAISE EXCEPTION 'tasa inválida' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  SELECT bcv_rate INTO v_old FROM platform_settings FOR UPDATE;
  IF p_rate IS NOT NULL AND p_rate IS DISTINCT FROM v_old THEN
    INSERT INTO rate_history (rate, source, kind, note) VALUES (round(p_rate, 4), 'admin', 'manual', NULL);
    UPDATE platform_settings SET rate_mode = 'manual', rate_source = 'admin', rate_last_error = NULL;
  END IF;
  UPDATE platform_settings SET
    bcv_rate = p_rate,
    -- la fecha de la tasa solo se renueva cuando el admin la guarda (aunque repita el mismo valor: confirma que sigue vigente)
    bcv_rate_at = CASE WHEN p_rate IS NULL THEN NULL ELSE now() END,
    pm_bank = NULLIF(btrim(p_pm_bank), ''), pm_phone = NULLIF(btrim(p_pm_phone), ''),
    pm_holder_id = NULLIF(btrim(p_pm_holder_id), ''), pm_holder_name = NULLIF(btrim(p_pm_holder_name), ''),
    paypal_email = NULLIF(btrim(p_paypal), ''), binance_id = NULLIF(btrim(p_binance), ''),
    notes = NULLIF(btrim(p_notes), ''), updated_at = now();
END
$$;

REVOKE ALL ON FUNCTION rate_mode(), rate_apply_auto(numeric, text), rate_report_failure(text), admin_set_rate_mode(bytea, text), admin_rate_history(bytea) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION rate_mode(), rate_apply_auto(numeric, text), rate_report_failure(text), admin_set_rate_mode(bytea, text), admin_rate_history(bytea) TO app_user;
