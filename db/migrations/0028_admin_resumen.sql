-- Paso 20A: resumen de la plataforma para el súper admin (registros y estado de los negocios).
-- Solo cuenta y lista: no expone mensajes ni datos de los clientes de cada negocio.
CREATE FUNCTION admin_overview(p_token_hash bytea, p_tz text DEFAULT 'America/Caracas') RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_tz text := CASE WHEN EXISTS (SELECT 1 FROM pg_timezone_names WHERE name = p_tz) THEN p_tz ELSE 'UTC' END;
  v_today date := (now() AT TIME ZONE v_tz)::date;
  v_out jsonb;
BEGIN
  PERFORM admin_require(p_token_hash);
  SELECT jsonb_build_object(
    'tz', v_tz,
    'today', to_char(v_today, 'YYYY-MM-DD'),
    'tenants', jsonb_build_object(
      'total', count(*),
      'trial', count(*) FILTER (WHERE status = 'trial' AND (trial_ends_at IS NULL OR trial_ends_at > now())),
      'trialExpired', count(*) FILTER (WHERE status = 'trial' AND trial_ends_at <= now()),
      'active', count(*) FILTER (WHERE status = 'active'),
      'expiringSoon', count(*) FILTER (WHERE status = 'active' AND plan_expires_at > now() AND plan_expires_at <= now() + interval '7 days'),
      'pastDue', count(*) FILTER (WHERE status = 'past_due'),
      'suspended', count(*) FILTER (WHERE status = 'suspended')
    ),
    'signups', jsonb_build_object(
      'last7', count(*) FILTER (WHERE created_at >= now() - interval '7 days'),
      'prev7', count(*) FILTER (WHERE created_at >= now() - interval '14 days' AND created_at < now() - interval '7 days'),
      'last30', count(*) FILTER (WHERE created_at >= now() - interval '30 days')
    )
  ) INTO v_out FROM tenants;

  v_out := v_out || jsonb_build_object(
    'users', (SELECT count(*) FROM users WHERE NOT is_super_admin),
    'paymentsToReview', (SELECT count(*) FROM payments WHERE status = 'por_revisar'),
    'daily', (
      SELECT COALESCE(jsonb_agg(jsonb_build_object('day', to_char(g.d, 'YYYY-MM-DD'), 'n', COALESCE(c.n, 0)) ORDER BY g.d), '[]'::jsonb)
      FROM generate_series(v_today - 13, v_today, interval '1 day') AS g(d)
      LEFT JOIN (
        SELECT (created_at AT TIME ZONE v_tz)::date AS d, count(*)::int AS n FROM tenants
         WHERE created_at >= now() - interval '16 days' GROUP BY 1
      ) c ON c.d = g.d::date
    ),
    'recent', (
      SELECT COALESCE(jsonb_agg(jsonb_build_object('name', r.name, 'status', r.status, 'createdAt', r.created_at) ORDER BY r.created_at DESC), '[]'::jsonb)
      FROM (SELECT name, status, created_at FROM tenants ORDER BY created_at DESC LIMIT 6) r
    )
  );
  RETURN v_out;
END
$$;
REVOKE ALL ON FUNCTION admin_overview(bytea, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION admin_overview(bytea, text) TO app_user;
