-- Paso 40: reporte semanal por correo y pantalla de Reportes.
ALTER TABLE team_settings ADD COLUMN weekly_report boolean NOT NULL DEFAULT true;

-- Qué semanas ya se enviaron (sin RLS: solo se toca con la función de abajo). Evita enviar dos veces el mismo reporte.
CREATE TABLE report_state (
  tenant_id uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  week_start date NOT NULL,
  claimed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, week_start)
);
REVOKE ALL ON report_state FROM PUBLIC, app_user;

-- El worker pide los negocios a los que les toca el reporte de esta semana (lunes desde las 12:00 UTC = 8:00 en Venezuela).
-- Marca la semana como tomada: un negocio sale a lo sumo una vez por semana. Solo negocios activos o en prueba vigente, con más de 7 días de vida.
CREATE FUNCTION report_claim(p_limit integer) RETURNS TABLE (out_tenant_id uuid, out_week_start date)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_week date := date_trunc('week', now() AT TIME ZONE 'UTC')::date;
BEGIN
  IF now() < (v_week::timestamp + interval '12 hours') AT TIME ZONE 'UTC' THEN RETURN; END IF;
  DELETE FROM report_state WHERE week_start < v_week - 90;
  RETURN QUERY
    INSERT INTO report_state (tenant_id, week_start)
    SELECT t.id, v_week FROM tenants t
     WHERE (t.status = 'active' OR (t.status = 'trial' AND (t.trial_ends_at IS NULL OR t.trial_ends_at > now())))
       AND t.created_at < now() - interval '7 days'
       AND NOT EXISTS (SELECT 1 FROM report_state s WHERE s.tenant_id = t.id AND s.week_start = v_week)
     ORDER BY t.created_at
     LIMIT LEAST(GREATEST(COALESCE(p_limit, 1), 1), 100)
    ON CONFLICT DO NOTHING
    RETURNING report_state.tenant_id, report_state.week_start;
END
$$;
REVOKE ALL ON FUNCTION report_claim(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION report_claim(integer) TO app_user;
