-- Paso 21: protección de costos de la IA.
-- 1) Se cuentan las LLAMADAS a la IA (no solo las respuestas enviadas) y, por mensaje, cuántas veces se llamó (tope de reintentos).
ALTER TABLE agent_usage_daily ADD COLUMN ai_calls integer NOT NULL DEFAULT 0 CHECK (ai_calls >= 0);
ALTER TABLE copilot_usage_daily ADD COLUMN ai_calls integer NOT NULL DEFAULT 0 CHECK (ai_calls >= 0);
ALTER TABLE messages ADD COLUMN ai_calls smallint NOT NULL DEFAULT 0 CHECK (ai_calls >= 0);

-- 2) Nuevos incidentes que el asistente puede registrar.
ALTER TABLE agent_events DROP CONSTRAINT agent_events_kind_check;
ALTER TABLE agent_events ADD CONSTRAINT agent_events_kind_check CHECK (kind IN
  ('inyeccion', 'fuga_prompt', 'salida_bloqueada', 'limite_contacto', 'bucle', 'reintentos_ia', 'pico_de_uso', 'limite_tokens', 'ia_pausada'));

-- 3) Ajustes globales de presupuesto (una sola fila). Solo se tocan mediante funciones.
CREATE TABLE ai_budget (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),
  monthly_budget_usd numeric(12, 2) CHECK (monthly_budget_usd IS NULL OR monthly_budget_usd > 0),
  price_in_usd_per_mtok numeric(12, 4) NOT NULL DEFAULT 0 CHECK (price_in_usd_per_mtok >= 0),
  price_out_usd_per_mtok numeric(12, 4) NOT NULL DEFAULT 0 CHECK (price_out_usd_per_mtok >= 0),
  daily_token_limit bigint CHECK (daily_token_limit IS NULL OR daily_token_limit > 0),
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO ai_budget (id) VALUES (true);

-- Avisos ya emitidos (50 %, 80 %, 100 %) por periodo; no se repiten.
CREATE TABLE ai_budget_alerts (
  kind text NOT NULL CHECK (kind IN ('presupuesto_mes', 'tokens_dia')),
  period date NOT NULL,
  level smallint NOT NULL CHECK (level IN (50, 80, 100)),
  value numeric NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (kind, period, level)
);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['ai_budget', 'ai_budget_alerts'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY %I ON %I USING (CURRENT_USER = ''app_owner'' AND SESSION_USER <> ''app_owner'') WITH CHECK (CURRENT_USER = ''app_owner'' AND SESSION_USER <> ''app_owner'')', t || '_funciones', t);
    EXECUTE format('REVOKE ALL ON %I FROM PUBLIC, app_user', t);
  END LOOP;
END $$;

-- 4) Decisión pura (sin leer ni escribir nada): fácil de probar con cualquier cifra.
CREATE FUNCTION ai_guard_eval(p_budget numeric, p_price_in numeric, p_price_out numeric, p_day_limit bigint,
                              p_month_in bigint, p_month_out bigint, p_day_tokens bigint) RETURNS jsonb
LANGUAGE sql IMMUTABLE
AS $$
  SELECT jsonb_build_object(
    'spendUsd', s.spend,
    'budgetUsd', p_budget,
    'budgetPct', s.bpct,
    'dayTokens', p_day_tokens,
    'dayLimit', p_day_limit,
    'dayPct', s.dpct,
    'monthIn', p_month_in,
    'monthOut', p_month_out,
    'blocked', (s.bpct >= 100 OR s.dpct >= 100),
    'reason', CASE WHEN s.bpct >= 100 THEN 'presupuesto' WHEN s.dpct >= 100 THEN 'tokens_dia' ELSE NULL END)
  FROM (
    SELECT round(p_month_in::numeric * p_price_in / 1000000 + p_month_out::numeric * p_price_out / 1000000, 4) AS spend,
           CASE WHEN p_budget IS NULL THEN 0 ELSE round((p_month_in::numeric * p_price_in / 1000000 + p_month_out::numeric * p_price_out / 1000000) * 100 / p_budget, 2) END AS bpct,
           round(p_day_tokens::numeric * 100 / p_day_limit, 2) AS dpct
  ) s
$$;

-- 5) Estado actual de toda la plataforma. Lo llaman el asistente y el copiloto antes de gastar IA; devuelve solo totales.
--    Anota (una sola vez por periodo) los avisos del 50, 80 y 100 %.
CREATE FUNCTION ai_guard_state(p_default_day_limit bigint) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  s ai_budget%ROWTYPE;
  v_month date := date_trunc('month', now() AT TIME ZONE 'utc')::date;
  v_today date := (now() AT TIME ZONE 'utc')::date;
  v_in bigint; v_out bigint; v_day bigint; v_limit bigint; v_res jsonb; lvl int;
BEGIN
  IF p_default_day_limit IS NULL OR p_default_day_limit < 1 THEN RAISE EXCEPTION 'tope inválido' USING ERRCODE = '22023'; END IF;
  PERFORM set_config('app.admin_read', '1', true);
  SELECT * INTO s FROM ai_budget;
  SELECT COALESCE(sum(i), 0), COALESCE(sum(o), 0) INTO v_in, v_out
    FROM (SELECT input_tokens AS i, output_tokens AS o FROM agent_usage_daily WHERE day >= v_month
          UNION ALL SELECT input_tokens, output_tokens FROM copilot_usage_daily WHERE day >= v_month) u;
  SELECT COALESCE(sum(t), 0) INTO v_day
    FROM (SELECT input_tokens + output_tokens AS t FROM agent_usage_daily WHERE day = v_today
          UNION ALL SELECT input_tokens + output_tokens FROM copilot_usage_daily WHERE day = v_today) u;
  v_limit := COALESCE(s.daily_token_limit, p_default_day_limit);
  v_res := ai_guard_eval(s.monthly_budget_usd, s.price_in_usd_per_mtok, s.price_out_usd_per_mtok, v_limit, v_in, v_out, v_day);
  FOREACH lvl IN ARRAY ARRAY[50, 80, 100] LOOP
    IF s.monthly_budget_usd IS NOT NULL AND (v_res->>'budgetPct')::numeric >= lvl THEN
      INSERT INTO ai_budget_alerts (kind, period, level, value) VALUES ('presupuesto_mes', v_month, lvl, (v_res->>'spendUsd')::numeric) ON CONFLICT DO NOTHING;
    END IF;
    IF (v_res->>'dayPct')::numeric >= lvl THEN
      INSERT INTO ai_budget_alerts (kind, period, level, value) VALUES ('tokens_dia', v_today, lvl, v_day) ON CONFLICT DO NOTHING;
    END IF;
  END LOOP;
  RETURN v_res || jsonb_build_object('budgetSet', s.monthly_budget_usd IS NOT NULL);
END
$$;

-- 6) Súper admin: ver y cambiar los ajustes.
CREATE FUNCTION admin_ai_budget_get(p_token_hash bytea, p_default_day_limit bigint) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  s ai_budget%ROWTYPE;
  v_month date := date_trunc('month', now() AT TIME ZONE 'utc')::date;
  v_state jsonb; v_alerts jsonb; v_top jsonb;
BEGIN
  PERFORM admin_require(p_token_hash);
  v_state := ai_guard_state(p_default_day_limit);
  PERFORM set_config('app.admin_read', '1', true);
  SELECT * INTO s FROM ai_budget;
  SELECT COALESCE(jsonb_agg(jsonb_build_object('kind', kind, 'period', to_char(period, 'YYYY-MM-DD'), 'level', level, 'value', value, 'at', created_at) ORDER BY created_at DESC), '[]'::jsonb)
    INTO v_alerts FROM (SELECT * FROM ai_budget_alerts ORDER BY created_at DESC LIMIT 12) a;
  SELECT COALESCE(jsonb_agg(jsonb_build_object('name', name, 'tokens', tokens,
           'spendUsd', round(tin::numeric * s.price_in_usd_per_mtok / 1000000 + tout::numeric * s.price_out_usd_per_mtok / 1000000, 4)) ORDER BY tokens DESC), '[]'::jsonb)
    INTO v_top
    FROM (SELECT t.name, sum(u.i + u.o)::bigint AS tokens, sum(u.i)::bigint AS tin, sum(u.o)::bigint AS tout
            FROM (SELECT tenant_id, input_tokens AS i, output_tokens AS o FROM agent_usage_daily WHERE day >= v_month
                  UNION ALL SELECT tenant_id, input_tokens, output_tokens FROM copilot_usage_daily WHERE day >= v_month) u
            JOIN tenants t ON t.id = u.tenant_id GROUP BY t.id, t.name HAVING sum(u.i + u.o) > 0 ORDER BY 2 DESC LIMIT 10) x;
  RETURN jsonb_build_object('state', v_state, 'alerts', v_alerts, 'top', v_top,
    'settings', jsonb_build_object('monthlyBudgetUsd', s.monthly_budget_usd, 'priceInUsdPerMtok', s.price_in_usd_per_mtok,
                                   'priceOutUsdPerMtok', s.price_out_usd_per_mtok, 'dailyTokenLimit', s.daily_token_limit),
    'defaultDayLimit', p_default_day_limit);
END
$$;

CREATE FUNCTION admin_ai_budget_set(p_token_hash bytea, p_budget numeric, p_price_in numeric, p_price_out numeric, p_day_limit bigint) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE v_admin uuid;
BEGIN
  v_admin := admin_require(p_token_hash);
  IF p_budget IS NOT NULL AND (p_budget <= 0 OR p_budget > 10000000) THEN RAISE EXCEPTION 'presupuesto inválido' USING ERRCODE = '22023'; END IF;
  IF p_price_in IS NULL OR p_price_out IS NULL OR p_price_in < 0 OR p_price_out < 0 OR p_price_in > 10000 OR p_price_out > 10000 THEN
    RAISE EXCEPTION 'precio inválido' USING ERRCODE = '22023';
  END IF;
  IF p_budget IS NOT NULL AND p_price_in = 0 AND p_price_out = 0 THEN
    RAISE EXCEPTION 'con presupuesto hacen falta los precios por millón de tokens' USING ERRCODE = '22023';
  END IF;
  IF p_day_limit IS NOT NULL AND (p_day_limit < 1000 OR p_day_limit > 1000000000000) THEN RAISE EXCEPTION 'tope diario inválido' USING ERRCODE = '22023'; END IF;
  UPDATE ai_budget SET monthly_budget_usd = p_budget, price_in_usd_per_mtok = p_price_in, price_out_usd_per_mtok = p_price_out,
         daily_token_limit = p_day_limit, updated_at = now();
  INSERT INTO audit_log (tenant_id, actor_id, action, target_type, target_id, metadata)
    VALUES (NULL, v_admin, 'ai_budget.update', 'ai_budget', 'global',
            jsonb_build_object('budgetUsd', p_budget, 'priceIn', p_price_in, 'priceOut', p_price_out, 'dayLimit', p_day_limit));
END
$$;

REVOKE ALL ON FUNCTION ai_guard_eval(numeric, numeric, numeric, bigint, bigint, bigint, bigint), ai_guard_state(bigint),
  admin_ai_budget_get(bytea, bigint), admin_ai_budget_set(bytea, numeric, numeric, numeric, bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ai_guard_eval(numeric, numeric, numeric, bigint, bigint, bigint, bigint), ai_guard_state(bigint),
  admin_ai_budget_get(bytea, bigint), admin_ai_budget_set(bytea, numeric, numeric, numeric, bigint) TO app_user;
