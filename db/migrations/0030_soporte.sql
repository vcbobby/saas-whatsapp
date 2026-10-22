-- Paso 20C: bandeja de soporte. Los negocios escriben; el súper admin responde desde Administración.
-- Todo lo que cambia datos pasa por funciones (la aplicación solo LEE las tablas): así nadie puede falsificar una respuesta
-- de soporte, reabrir tickets ajenos ni saltarse los topes.

CREATE TABLE support_tickets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  created_by uuid REFERENCES users (id) ON DELETE SET NULL,
  subject text NOT NULL CHECK (char_length(subject) BETWEEN 3 AND 120),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'answered', 'closed')),
  last_from text NOT NULL DEFAULT 'user' CHECK (last_from IN ('user', 'support')),
  created_at timestamptz NOT NULL DEFAULT now(),
  last_message_at timestamptz NOT NULL DEFAULT now(),
  closed_at timestamptz,
  UNIQUE (tenant_id, id),
  CHECK ((status = 'closed') = (closed_at IS NOT NULL))
);
CREATE INDEX support_tickets_tenant_idx ON support_tickets (tenant_id, last_message_at DESC);
CREATE INDEX support_tickets_cola_idx ON support_tickets (status, last_message_at) WHERE status <> 'closed';

CREATE TABLE support_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  ticket_id uuid NOT NULL,
  from_support boolean NOT NULL DEFAULT false,
  author_id uuid REFERENCES users (id) ON DELETE SET NULL,
  body text NOT NULL CHECK (char_length(body) BETWEEN 1 AND 4000),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (tenant_id, ticket_id) REFERENCES support_tickets (tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX support_messages_ticket_idx ON support_messages (tenant_id, ticket_id, created_at);

ALTER TABLE support_tickets ENABLE ROW LEVEL SECURITY;
ALTER TABLE support_tickets FORCE ROW LEVEL SECURITY;
CREATE POLICY support_tickets_aislamiento ON support_tickets
  USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());
CREATE POLICY support_tickets_funciones ON support_tickets
  USING (CURRENT_USER = 'app_owner' AND SESSION_USER <> 'app_owner')
  WITH CHECK (CURRENT_USER = 'app_owner' AND SESSION_USER <> 'app_owner');
ALTER TABLE support_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE support_messages FORCE ROW LEVEL SECURITY;
CREATE POLICY support_messages_aislamiento ON support_messages
  USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());
CREATE POLICY support_messages_funciones ON support_messages
  USING (CURRENT_USER = 'app_owner' AND SESSION_USER <> 'app_owner')
  WITH CHECK (CURRENT_USER = 'app_owner' AND SESSION_USER <> 'app_owner');

-- La aplicación solo lee; escribir es cosa de las funciones de abajo.
REVOKE INSERT, UPDATE, DELETE ON support_tickets, support_messages FROM app_user;

-- Limpieza del texto en la base de datos (defensa en profundidad; la API ya lo limpia): sin caracteres de control ni de
-- dirección de texto, y sin espacios sobrantes en los extremos.
CREATE FUNCTION support_clean(p_text text) RETURNS text
LANGUAGE sql IMMUTABLE
AS $$ SELECT btrim(regexp_replace(COALESCE(p_text, ''), '[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u202A-\u202E\u2066-\u2069]', '', 'g'), E' \t\r\n') $$;

-- ------------------------------------------------------------ lado del negocio
-- Estas funciones se llaman DENTRO de withTenant (app.tenant_id fijado por el servidor): nunca se confía en un id de negocio de la petición.
CREATE FUNCTION support_create(p_user uuid, p_subject text, p_body text) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE v_tenant uuid := app_current_tenant(); v_subject text := support_clean(p_subject); v_body text := support_clean(p_body); v_id uuid; v_open integer;
BEGIN
  IF v_tenant IS NULL THEN RAISE EXCEPTION 'sin negocio' USING ERRCODE = '42501'; END IF;
  IF char_length(v_subject) < 3 OR char_length(v_subject) > 120 OR char_length(v_body) < 1 OR char_length(v_body) > 4000 THEN
    RAISE EXCEPTION 'datos inválidos' USING ERRCODE = '22023';
  END IF;
  SELECT count(*) INTO v_open FROM support_tickets WHERE tenant_id = v_tenant AND status <> 'closed';
  IF v_open >= 5 THEN RAISE EXCEPTION 'demasiados tickets abiertos' USING ERRCODE = '53400'; END IF;
  INSERT INTO support_tickets (tenant_id, created_by, subject) VALUES (v_tenant, p_user, v_subject) RETURNING id INTO v_id;
  INSERT INTO support_messages (tenant_id, ticket_id, from_support, author_id, body) VALUES (v_tenant, v_id, false, p_user, v_body);
  RETURN v_id;
END
$$;

CREATE FUNCTION support_reply(p_ticket uuid, p_user uuid, p_body text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE v_tenant uuid := app_current_tenant(); v_body text := support_clean(p_body); v_n integer;
BEGIN
  IF v_tenant IS NULL THEN RAISE EXCEPTION 'sin negocio' USING ERRCODE = '42501'; END IF;
  IF char_length(v_body) < 1 OR char_length(v_body) > 4000 THEN RAISE EXCEPTION 'datos inválidos' USING ERRCODE = '22023'; END IF;
  PERFORM 1 FROM support_tickets WHERE id = p_ticket AND tenant_id = v_tenant FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'no encontrado' USING ERRCODE = 'P0002'; END IF;
  SELECT count(*) INTO v_n FROM support_messages WHERE tenant_id = v_tenant AND ticket_id = p_ticket;
  IF v_n >= 200 THEN RAISE EXCEPTION 'conversación demasiado larga' USING ERRCODE = '53400'; END IF;
  INSERT INTO support_messages (tenant_id, ticket_id, from_support, author_id, body) VALUES (v_tenant, p_ticket, false, p_user, v_body);
  -- Escribir de nuevo reabre el ticket.
  UPDATE support_tickets SET status = 'open', last_from = 'user', last_message_at = now(), closed_at = NULL WHERE id = p_ticket AND tenant_id = v_tenant;
END
$$;

CREATE FUNCTION support_close(p_ticket uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE v_tenant uuid := app_current_tenant();
BEGIN
  IF v_tenant IS NULL THEN RAISE EXCEPTION 'sin negocio' USING ERRCODE = '42501'; END IF;
  UPDATE support_tickets SET status = 'closed', closed_at = COALESCE(closed_at, now()) WHERE id = p_ticket AND tenant_id = v_tenant;
  IF NOT FOUND THEN RAISE EXCEPTION 'no encontrado' USING ERRCODE = 'P0002'; END IF;
END
$$;

-- ----------------------------------------------------------- lado del súper admin
CREATE FUNCTION admin_support_list(p_token_hash bytea, p_status text DEFAULT NULL)
RETURNS TABLE (t_id uuid, t_tenant_id uuid, t_tenant_name text, t_email text, t_subject text, t_status text, t_last_from text, t_created_at timestamptz, t_last_message_at timestamptz, t_messages bigint)
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  PERFORM admin_require(p_token_hash);
  IF p_status IS NOT NULL AND p_status NOT IN ('open', 'answered', 'closed') THEN RAISE EXCEPTION 'estado inválido' USING ERRCODE = '22023'; END IF;
  RETURN QUERY
    SELECT s.id, s.tenant_id, t.name, u.email, s.subject, s.status, s.last_from, s.created_at, s.last_message_at,
           (SELECT count(*) FROM support_messages m WHERE m.ticket_id = s.id AND m.tenant_id = s.tenant_id)
      FROM support_tickets s
      JOIN tenants t ON t.id = s.tenant_id
      LEFT JOIN users u ON u.id = s.created_by
     WHERE p_status IS NULL OR s.status = p_status
     ORDER BY (s.status = 'closed'), s.last_message_at DESC
     LIMIT 200;
END
$$;

CREATE FUNCTION admin_support_get(p_token_hash bytea, p_ticket uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE v jsonb;
BEGIN
  PERFORM admin_require(p_token_hash);
  SELECT jsonb_build_object(
    'id', s.id, 'tenantId', s.tenant_id, 'tenantName', t.name, 'email', u.email, 'subject', s.subject, 'status', s.status,
    'createdAt', s.created_at, 'lastMessageAt', s.last_message_at,
    'messages', (SELECT COALESCE(jsonb_agg(jsonb_build_object('id', m.id, 'fromSupport', m.from_support, 'body', m.body, 'createdAt', m.created_at) ORDER BY m.created_at, m.id), '[]'::jsonb)
                   FROM support_messages m WHERE m.ticket_id = s.id AND m.tenant_id = s.tenant_id))
    INTO v
    FROM support_tickets s JOIN tenants t ON t.id = s.tenant_id LEFT JOIN users u ON u.id = s.created_by
   WHERE s.id = p_ticket;
  IF v IS NULL THEN RAISE EXCEPTION 'no encontrado' USING ERRCODE = 'P0002'; END IF;
  RETURN v;
END
$$;

CREATE FUNCTION admin_support_reply(p_token_hash bytea, p_ticket uuid, p_body text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE v_admin uuid; v_tenant uuid; v_body text := support_clean(p_body); v_n integer;
BEGIN
  v_admin := admin_require(p_token_hash);
  IF char_length(v_body) < 1 OR char_length(v_body) > 4000 THEN RAISE EXCEPTION 'datos inválidos' USING ERRCODE = '22023'; END IF;
  SELECT tenant_id INTO v_tenant FROM support_tickets WHERE id = p_ticket FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'no encontrado' USING ERRCODE = 'P0002'; END IF;
  SELECT count(*) INTO v_n FROM support_messages WHERE tenant_id = v_tenant AND ticket_id = p_ticket;
  IF v_n >= 200 THEN RAISE EXCEPTION 'conversación demasiado larga' USING ERRCODE = '53400'; END IF;
  INSERT INTO support_messages (tenant_id, ticket_id, from_support, author_id, body) VALUES (v_tenant, p_ticket, true, v_admin, v_body);
  UPDATE support_tickets SET status = 'answered', last_from = 'support', last_message_at = now(), closed_at = NULL WHERE id = p_ticket;
  INSERT INTO audit_log (tenant_id, actor_id, action, target_type, target_id, metadata)
    VALUES (v_tenant, v_admin, 'support.replied', 'support_ticket', p_ticket::text, '{}'::jsonb);
END
$$;

CREATE FUNCTION admin_support_set_status(p_token_hash bytea, p_ticket uuid, p_status text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE v_admin uuid; v_tenant uuid;
BEGIN
  v_admin := admin_require(p_token_hash);
  IF p_status NOT IN ('open', 'closed') THEN RAISE EXCEPTION 'estado inválido' USING ERRCODE = '22023'; END IF;
  UPDATE support_tickets SET status = p_status,
         closed_at = CASE WHEN p_status = 'closed' THEN COALESCE(closed_at, now()) ELSE NULL END
   WHERE id = p_ticket RETURNING tenant_id INTO v_tenant;
  IF NOT FOUND THEN RAISE EXCEPTION 'no encontrado' USING ERRCODE = 'P0002'; END IF;
  INSERT INTO audit_log (tenant_id, actor_id, action, target_type, target_id, metadata)
    VALUES (v_tenant, v_admin, 'support.' || p_status, 'support_ticket', p_ticket::text, '{}'::jsonb);
END
$$;

REVOKE ALL ON FUNCTION support_clean(text), support_create(uuid, text, text), support_reply(uuid, uuid, text), support_close(uuid),
  admin_support_list(bytea, text), admin_support_get(bytea, uuid), admin_support_reply(bytea, uuid, text), admin_support_set_status(bytea, uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION support_clean(text), support_create(uuid, text, text), support_reply(uuid, uuid, text), support_close(uuid),
  admin_support_list(bytea, text), admin_support_get(bytea, uuid), admin_support_reply(bytea, uuid, text), admin_support_set_status(bytea, uuid, text) TO app_user;

-- El resumen del súper admin ahora cuenta los tickets que esperan respuesta.
CREATE OR REPLACE FUNCTION admin_overview(p_token_hash bytea, p_tz text DEFAULT 'America/Caracas') RETURNS jsonb
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
    'supportOpen', (SELECT count(*) FROM support_tickets WHERE status = 'open'),
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
