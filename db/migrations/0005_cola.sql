-- 0005: cola de trabajo (Paso 7).
-- Postgres es la fuente de verdad; Redis solo transporta. Cada mensaje entrante
-- nace "pending" y pasa a "done" cuando el worker lo procesa. Si Redis se cae o
-- un trabajo se pierde, el barrendero vuelve a encolar lo que siga "pending".

ALTER TABLE messages
  ADD COLUMN process_state text NOT NULL DEFAULT 'done'
    CHECK (process_state IN ('pending', 'done', 'failed')),
  ADD COLUMN process_state_at timestamptz NOT NULL DEFAULT now();

CREATE INDEX messages_pendientes_idx ON messages (process_state_at)
  WHERE direction = 'in' AND process_state = 'pending';

-- El barrendero necesita mirar todos los negocios, pero messages tiene RLS forzada.
-- Esta función entra negocio por negocio (solo los que tienen WhatsApp conectado),
-- devuelve ÚNICAMENTE ids (nunca contenido) y no deja ningún negocio fijado al terminar.
CREATE FUNCTION queue_pending_inbound(p_min_age_seconds integer, p_limit integer)
RETURNS TABLE (out_tenant_id uuid, out_message_id uuid)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  t uuid;
  remaining integer := LEAST(GREATEST(COALESCE(p_limit, 1), 1), 500);
  n integer;
  min_age integer := GREATEST(COALESCE(p_min_age_seconds, 0), 0);
BEGIN
  FOR t IN SELECT DISTINCT ti.tenant_id FROM tenant_integrations ti WHERE ti.provider = 'whatsapp' LOOP
    EXIT WHEN remaining <= 0;
    PERFORM set_config('app.tenant_id', t::text, true);
    RETURN QUERY
      SELECT m.tenant_id, m.id FROM messages m
      WHERE m.direction = 'in' AND m.process_state = 'pending'
        AND m.process_state_at < now() - make_interval(secs => min_age)
      ORDER BY m.process_state_at
      LIMIT remaining;
    GET DIAGNOSTICS n = ROW_COUNT;
    remaining := remaining - n;
  END LOOP;
  PERFORM set_config('app.tenant_id', '', true);
  RETURN;
END
$$;
REVOKE ALL ON FUNCTION queue_pending_inbound(integer, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION queue_pending_inbound(integer, integer) TO app_user;
