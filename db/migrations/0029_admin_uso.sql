-- Paso 20B: uso y salud de la plataforma para el súper admin.
-- 1) Se cuentan los fallos de la IA (antes solo quedaban en el registro del servidor).
ALTER TABLE agent_usage_daily ADD COLUMN ai_errors integer NOT NULL DEFAULT 0 CHECK (ai_errors >= 0);
ALTER TABLE copilot_usage_daily ADD COLUMN ai_errors integer NOT NULL DEFAULT 0 CHECK (ai_errors >= 0);

-- 2) Lectura entre negocios SOLO para admin_usage(): hace falta estar dentro de una función del dueño llamada por la
--    aplicación Y que esa función active la marca app.admin_read. Solo SELECT; nada se escribe por esta vía.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['messages', 'agent_usage_daily', 'copilot_usage_daily', 'agent_events', 'appointments', 'orders',
                           'kb_documents', 'webhook_deliveries', 'customer_notifications', 'automation_rules', 'webhook_endpoints']
  LOOP
    EXECUTE format(
      'CREATE POLICY %I ON %I FOR SELECT USING (CURRENT_USER = ''app_owner'' AND SESSION_USER <> ''app_owner'' AND current_setting(''app.admin_read'', true) = ''1'')',
      t || '_admin_lectura', t);
  END LOOP;
END $$;

-- 3) Resumen de uso: solo cifras (sin textos de mensajes ni datos de clientes).
CREATE FUNCTION admin_usage(p_token_hash bytea, p_tz text DEFAULT 'America/Caracas') RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_tz text := CASE WHEN EXISTS (SELECT 1 FROM pg_timezone_names WHERE name = p_tz) THEN p_tz ELSE 'UTC' END;
  v_today date := (now() AT TIME ZONE v_tz)::date;
  v_utc_today date := (now() AT TIME ZONE 'utc')::date;
  v_out jsonb;
BEGIN
  PERFORM admin_require(p_token_hash);
  PERFORM set_config('app.admin_read', '1', true);

  v_out := jsonb_build_object(
    'tz', v_tz,
    'today', to_char(v_today, 'YYYY-MM-DD'),
    'totals30', (
      SELECT jsonb_build_object(
        'messagesIn', COALESCE(sum(m.n_in), 0), 'messagesOut', COALESCE(sum(m.n_out), 0))
      FROM (SELECT count(*) FILTER (WHERE direction = 'in') AS n_in, count(*) FILTER (WHERE direction = 'out') AS n_out
              FROM messages WHERE created_at >= now() - interval '30 days') m
    ) || (
      SELECT jsonb_build_object('agentReplies', COALESCE(sum(replies), 0), 'agentTokens', COALESCE(sum(input_tokens + output_tokens), 0), 'agentErrors', COALESCE(sum(ai_errors), 0))
        FROM agent_usage_daily WHERE day >= v_utc_today - 29
    ) || (
      SELECT jsonb_build_object('copilotQuestions', COALESCE(sum(questions), 0), 'copilotTokens', COALESCE(sum(input_tokens + output_tokens), 0), 'copilotErrors', COALESCE(sum(ai_errors), 0))
        FROM copilot_usage_daily WHERE day >= v_utc_today - 29
    ) || jsonb_build_object(
      'activeTenants', (SELECT count(DISTINCT tenant_id) FROM messages WHERE direction = 'in' AND created_at >= now() - interval '30 days'),
      'liveTenants', (SELECT count(*) FROM tenants WHERE status IN ('trial', 'active'))
    ),
    'daily', (
      SELECT COALESCE(jsonb_agg(jsonb_build_object('day', to_char(g.d, 'YYYY-MM-DD'),
               'messagesIn', COALESCE(mi.n, 0), 'replies', COALESCE(au.replies, 0),
               'tokens', COALESCE(au.tokens, 0) + COALESCE(cu.tokens, 0), 'errors', COALESCE(au.errs, 0) + COALESCE(cu.errs, 0)) ORDER BY g.d), '[]'::jsonb)
      FROM generate_series(v_today - 13, v_today, interval '1 day') AS g(d)
      LEFT JOIN (SELECT (created_at AT TIME ZONE v_tz)::date AS d, count(*)::int AS n FROM messages
                  WHERE direction = 'in' AND created_at >= now() - interval '16 days' GROUP BY 1) mi ON mi.d = g.d::date
      LEFT JOIN (SELECT day AS d, sum(replies)::int AS replies, sum(input_tokens + output_tokens)::bigint AS tokens, sum(ai_errors)::int AS errs
                   FROM agent_usage_daily WHERE day >= v_utc_today - 15 GROUP BY 1) au ON au.d = g.d::date
      LEFT JOIN (SELECT day AS d, sum(input_tokens + output_tokens)::bigint AS tokens, sum(ai_errors)::int AS errs
                   FROM copilot_usage_daily WHERE day >= v_utc_today - 15 GROUP BY 1) cu ON cu.d = g.d::date
    ),
    -- Cuántos negocios usaron cada módulo en los últimos 30 días (o lo tienen configurado, donde no hay «uso» diario).
    'modules', jsonb_build_array(
      jsonb_build_object('key', 'asistente', 'label', 'Asistente de WhatsApp', 'tenants', (SELECT count(DISTINCT tenant_id) FROM agent_usage_daily WHERE day >= v_utc_today - 29 AND replies > 0)),
      jsonb_build_object('key', 'copiloto', 'label', 'Copiloto', 'tenants', (SELECT count(DISTINCT tenant_id) FROM copilot_usage_daily WHERE day >= v_utc_today - 29 AND questions > 0)),
      jsonb_build_object('key', 'agenda', 'label', 'Agenda de citas', 'tenants', (SELECT count(DISTINCT tenant_id) FROM appointments WHERE created_at >= now() - interval '30 days')),
      jsonb_build_object('key', 'pedidos', 'label', 'Pedidos', 'tenants', (SELECT count(DISTINCT tenant_id) FROM orders WHERE created_at >= now() - interval '30 days')),
      jsonb_build_object('key', 'conocimiento', 'label', 'Conocimiento (documentos listos)', 'tenants', (SELECT count(DISTINCT tenant_id) FROM kb_documents WHERE status = 'ready')),
      jsonb_build_object('key', 'automatizaciones', 'label', 'Automatizaciones activas', 'tenants', (SELECT count(DISTINCT tenant_id) FROM automation_rules WHERE active)),
      jsonb_build_object('key', 'conexiones', 'label', 'Conexiones activas', 'tenants', (SELECT count(DISTINCT tenant_id) FROM webhook_endpoints WHERE active))
    ),
    -- Salud de los últimos 7 días.
    'health7', jsonb_build_object(
      'sendFailed', (SELECT count(*) FROM messages WHERE direction = 'out' AND send_state = 'failed' AND created_at >= now() - interval '7 days'),
      'deliveryFailed', (SELECT count(*) FROM messages WHERE direction = 'out' AND delivery_status = 'failed' AND created_at >= now() - interval '7 days'),
      'processFailed', (SELECT count(*) FROM messages WHERE direction = 'in' AND process_state = 'failed' AND created_at >= now() - interval '7 days'),
      'aiErrors', (SELECT COALESCE(sum(ai_errors), 0) FROM agent_usage_daily WHERE day >= v_utc_today - 6) + (SELECT COALESCE(sum(ai_errors), 0) FROM copilot_usage_daily WHERE day >= v_utc_today - 6),
      'kbFailed', (SELECT count(*) FROM kb_documents WHERE status = 'failed'),
      'webhooksFailed', (SELECT count(*) FROM webhook_deliveries WHERE status = 'fallido' AND created_at >= now() - interval '7 days'),
      'notificationsFailed', (SELECT count(*) FROM customer_notifications WHERE status = 'fallido' AND created_at >= now() - interval '7 days'),
      'injection', (SELECT count(*) FROM agent_events WHERE kind = 'inyeccion' AND created_at >= now() - interval '7 days'),
      'promptLeak', (SELECT count(*) FROM agent_events WHERE kind = 'fuga_prompt' AND created_at >= now() - interval '7 days'),
      'blockedOutput', (SELECT count(*) FROM agent_events WHERE kind = 'salida_bloqueada' AND created_at >= now() - interval '7 days'),
      'contactLimited', (SELECT count(*) FROM agent_events WHERE kind = 'limite_contacto' AND created_at >= now() - interval '7 days')
    ),
    -- Los 10 negocios que más IA consumieron en 30 días (para detectar abusos o fugas de costo).
    'top', (
      SELECT COALESCE(jsonb_agg(jsonb_build_object('name', x.name, 'status', x.status, 'replies', x.replies, 'tokens', x.tokens, 'questions', x.questions, 'errors', x.errs) ORDER BY x.tokens DESC), '[]'::jsonb)
      FROM (
        SELECT t.name, t.status,
               COALESCE(a.replies, 0)::int AS replies, (COALESCE(a.tokens, 0) + COALESCE(c.tokens, 0))::bigint AS tokens,
               COALESCE(c.questions, 0)::int AS questions, (COALESCE(a.errs, 0) + COALESCE(c.errs, 0))::int AS errs
          FROM tenants t
          LEFT JOIN (SELECT tenant_id, sum(replies) AS replies, sum(input_tokens + output_tokens) AS tokens, sum(ai_errors) AS errs
                       FROM agent_usage_daily WHERE day >= v_utc_today - 29 GROUP BY 1) a ON a.tenant_id = t.id
          LEFT JOIN (SELECT tenant_id, sum(questions) AS questions, sum(input_tokens + output_tokens) AS tokens, sum(ai_errors) AS errs
                       FROM copilot_usage_daily WHERE day >= v_utc_today - 29 GROUP BY 1) c ON c.tenant_id = t.id
         WHERE COALESCE(a.tokens, 0) + COALESCE(c.tokens, 0) > 0
         ORDER BY COALESCE(a.tokens, 0) + COALESCE(c.tokens, 0) DESC LIMIT 10
      ) x
    )
  );
  RETURN v_out;
END
$$;
REVOKE ALL ON FUNCTION admin_usage(bytea, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION admin_usage(bytea, text) TO app_user;
