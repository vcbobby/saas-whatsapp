-- Paso 30 (ajuste): los avisos de plan se pueden pedir para UN negocio (lo usan las pruebas, para no llenar la cola con todos los negocios de prueba viejos).
DROP FUNCTION email_notice_candidates();
CREATE FUNCTION email_notice_candidates(p_tenant uuid DEFAULT NULL)
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
   WHERE (p_tenant IS NULL OR c.tid = p_tenant)
     AND NOT EXISTS (SELECT 1 FROM email_outbox x WHERE x.dedupe_key = c.key || ':' || o.email)
   LIMIT 200
$$;
REVOKE ALL ON FUNCTION email_notice_candidates(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION email_notice_candidates(uuid) TO app_user;
