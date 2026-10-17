-- Paso 18A: planes con límites editables. Los precios NO viven aquí (llegan con el cobro, Paso 18C).
-- Los tres planes de abajo son PROVISIONALES: el súper admin cambia nombres y límites desde Administración.

CREATE TABLE plans (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug text NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9][a-z0-9-]{1,30}$'),
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 60),
  position integer NOT NULL DEFAULT 0,
  is_default boolean NOT NULL DEFAULT false,
  active boolean NOT NULL DEFAULT true,
  -- NULL = sin tope. Cuenta respuestas del asistente por mes calendario (UTC).
  max_replies_month integer CHECK (max_replies_month IS NULL OR max_replies_month BETWEEN 0 AND 10000000),
  max_members integer NOT NULL CHECK (max_members BETWEEN 1 AND 1000),
  -- Módulos incluidos. (Se aplican en el Paso 18B; aquí solo se guardan.)
  modules text[] NOT NULL DEFAULT '{}' CHECK (modules <@ ARRAY['agenda','catalogo','copiloto','automatizaciones']::text[]),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (NOT is_default OR active)
);
CREATE UNIQUE INDEX plans_un_solo_defecto_idx ON plans (is_default) WHERE is_default;
-- Los planes no tienen secretos y los lee cualquier negocio; solo se cambian con funciones del súper admin.
REVOKE INSERT, UPDATE, DELETE ON plans FROM app_user;

INSERT INTO plans (slug, name, position, is_default, max_replies_month, max_members, modules) VALUES
  ('plan-1', 'Plan 1', 1, true, 300, 3, ARRAY['agenda','catalogo']),
  ('plan-2', 'Plan 2', 2, false, 2000, 6, ARRAY['agenda','catalogo','copiloto','automatizaciones']),
  ('plan-3', 'Plan 3', 3, false, 10000, 15, ARRAY['agenda','catalogo','copiloto','automatizaciones']);

CREATE FUNCTION default_plan_id() RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$ SELECT id FROM plans WHERE is_default AND active LIMIT 1 $$;
GRANT EXECUTE ON FUNCTION default_plan_id() TO app_user;

ALTER TABLE tenants ADD COLUMN plan_id uuid REFERENCES plans (id) DEFAULT default_plan_id();
UPDATE tenants SET plan_id = default_plan_id() WHERE plan_id IS NULL;
ALTER TABLE tenants ALTER COLUMN plan_id SET NOT NULL;
CREATE INDEX tenants_plan_idx ON tenants (plan_id);

-- El plan de un negocio solo cambia dentro de las funciones del súper admin (ni siquiera el dueño del negocio).
CREATE FUNCTION tenants_plan_guard() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.plan_id IS DISTINCT FROM OLD.plan_id AND NOT (current_user = 'app_owner' AND session_user <> 'app_owner') THEN
    RAISE EXCEPTION 'el plan solo lo cambia un súper admin' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER tenants_plan_guard BEFORE UPDATE OF plan_id ON tenants
  FOR EACH ROW EXECUTE FUNCTION tenants_plan_guard();

-- ---- Funciones del súper admin
CREATE FUNCTION admin_update_plan(
  p_token_hash bytea, p_plan_id uuid, p_name text, p_max_replies integer, p_max_members integer, p_modules text[], p_active boolean
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE v_default boolean;
BEGIN
  PERFORM admin_require(p_token_hash);
  SELECT is_default INTO v_default FROM plans WHERE id = p_plan_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'plan inexistente' USING ERRCODE = 'no_data_found'; END IF;
  IF v_default AND NOT p_active THEN
    RAISE EXCEPTION 'el plan por defecto no se puede desactivar' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  UPDATE plans SET name = btrim(p_name), max_replies_month = p_max_replies, max_members = p_max_members,
         modules = COALESCE(p_modules, '{}'), active = p_active, updated_at = now()
   WHERE id = p_plan_id;
END
$$;

CREATE FUNCTION admin_set_tenant_plan(p_token_hash bytea, p_tenant_id uuid, p_plan_id uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE v_user uuid; v_old uuid; v_active boolean;
BEGIN
  v_user := admin_require(p_token_hash);
  SELECT plan_id INTO v_old FROM tenants WHERE id = p_tenant_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'negocio inexistente' USING ERRCODE = 'no_data_found'; END IF;
  SELECT active INTO v_active FROM plans WHERE id = p_plan_id;
  IF v_active IS NOT TRUE THEN RAISE EXCEPTION 'plan inexistente o inactivo' USING ERRCODE = 'no_data_found'; END IF;
  UPDATE tenants SET plan_id = p_plan_id WHERE id = p_tenant_id;
  INSERT INTO audit_log (tenant_id, actor_id, action, target_type, target_id, metadata)
    VALUES (p_tenant_id, v_user, 'admin.tenant.plan', 'tenant', p_tenant_id::text,
            jsonb_build_object('from', v_old, 'to', p_plan_id));
END
$$;

-- La lista de negocios del súper admin ahora incluye el plan.
DROP FUNCTION admin_list_tenants(bytea);
CREATE FUNCTION admin_list_tenants(p_token_hash bytea)
RETURNS TABLE (
  t_id uuid, t_name text, t_slug text, t_status text,
  t_trial_ends_at timestamptz, t_created_at timestamptz, t_members bigint, t_plan_id uuid
)
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  PERFORM admin_require(p_token_hash);
  RETURN QUERY
    SELECT t.id, t.name, t.slug, t.status, t.trial_ends_at, t.created_at,
           (SELECT count(*) FROM memberships m WHERE m.tenant_id = t.id), t.plan_id
    FROM tenants t ORDER BY t.created_at DESC LIMIT 500;
END
$$;

REVOKE ALL ON FUNCTION admin_update_plan(bytea, uuid, text, integer, integer, text[], boolean),
  admin_set_tenant_plan(bytea, uuid, uuid), admin_list_tenants(bytea) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION admin_update_plan(bytea, uuid, text, integer, integer, text[], boolean),
  admin_set_tenant_plan(bytea, uuid, uuid), admin_list_tenants(bytea) TO app_user;

-- ---- Tope de personas del equipo = el del plan (antes: 25 fijo)
CREATE OR REPLACE FUNCTION team_invite(
  p_token_hash bytea, p_tenant_id uuid, p_email text, p_role text, p_inv_hash bytea
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE v_role text; v_actor uuid; v_email text; v_id uuid; v_max integer;
BEGIN
  v_role := auth_tenant_role(p_token_hash, p_tenant_id);
  IF v_role IS NULL OR v_role NOT IN ('owner', 'admin') THEN
    RAISE EXCEPTION 'no autorizado' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_role NOT IN ('admin', 'agent') THEN
    RAISE EXCEPTION 'rol inválido' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF v_role = 'admin' AND p_role <> 'agent' THEN
    RAISE EXCEPTION 'no autorizado' USING ERRCODE = 'insufficient_privilege';
  END IF;
  v_email := lower(btrim(p_email));
  IF char_length(v_email) < 3 OR char_length(v_email) > 254 THEN
    RAISE EXCEPTION 'correo inválido' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF EXISTS (
    SELECT 1 FROM memberships m JOIN users u ON u.id = m.user_id
    WHERE m.tenant_id = p_tenant_id AND u.email = v_email
  ) THEN
    RAISE EXCEPTION 'ya es miembro' USING ERRCODE = 'unique_violation';
  END IF;
  -- Tope de personas según el plan del negocio (miembros + invitaciones pendientes).
  SELECT p.max_members INTO v_max FROM tenants t JOIN plans p ON p.id = t.plan_id WHERE t.id = p_tenant_id;
  IF (SELECT count(*) FROM memberships WHERE tenant_id = p_tenant_id)
     + (SELECT count(*) FROM invitations
        WHERE tenant_id = p_tenant_id AND accepted_at IS NULL AND revoked_at IS NULL
          AND expires_at > now()) >= COALESCE(v_max, 1) THEN
    RAISE EXCEPTION 'límite de equipo' USING ERRCODE = 'program_limit_exceeded';
  END IF;

  v_actor := auth_session_user(p_token_hash);
  UPDATE invitations SET revoked_at = now()
    WHERE tenant_id = p_tenant_id AND email = v_email AND accepted_at IS NULL AND revoked_at IS NULL;
  INSERT INTO invitations (tenant_id, email, role, token_hash, invited_by, expires_at)
    VALUES (p_tenant_id, v_email, p_role, p_inv_hash, v_actor, now() + interval '7 days')
    RETURNING id INTO v_id;
  INSERT INTO audit_log (tenant_id, actor_id, action, target_type, target_id, metadata)
    VALUES (p_tenant_id, v_actor, 'team.invited', 'invitation', v_id::text,
            jsonb_build_object('email', v_email, 'role', p_role));
  RETURN v_id;
END
$$;

-- ---- Aviso en «Hoy» cuando el asistente se detiene por el tope mensual del plan
CREATE OR REPLACE FUNCTION conversations_work_sync() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_name text;
  v_reason text;
BEGIN
  IF NEW.status = 'human' AND OLD.status = 'bot' AND COALESCE(NEW.handoff_reason, '') <> 'tomada_por_persona' THEN
    SELECT COALESCE(NULLIF(display_name, ''), '+' || wa_id) INTO v_name
      FROM contacts WHERE tenant_id = NEW.tenant_id AND id = NEW.contact_id;
    v_reason := CASE NEW.handoff_reason
      WHEN 'pedido_de_persona' THEN 'El cliente pidió hablar con una persona.'
      WHEN 'limite_diario' THEN 'El asistente llegó a su límite diario de respuestas.'
      WHEN 'limite_plan' THEN 'Se llegó al tope mensual de respuestas del plan; el asistente se detuvo hasta el mes siguiente.'
      WHEN 'limite_contacto' THEN 'Este cliente escribió muchísimo en poco tiempo; el asistente se detuvo.'
      WHEN 'intentos_de_manipulacion' THEN 'El cliente intentó manipular al asistente; revisa el chat con cuidado.'
      WHEN 'envio_rechazado' THEN 'WhatsApp rechazó la respuesta del asistente.'
      WHEN 'envio_incierto' THEN 'No se pudo confirmar si la respuesta llegó al cliente.'
      WHEN 'agente_fallo' THEN 'El asistente tuvo un fallo y no pudo responder.'
      WHEN 'fuga_de_instrucciones' THEN 'El asistente iba a revelar sus instrucciones; se detuvo.'
      WHEN 'salida_bloqueada' THEN 'Se bloqueó una respuesta del asistente por seguridad.'
      WHEN 'respuesta_vacia' THEN 'El asistente no pudo generar una respuesta.'
      ELSE 'El asistente pasó esta conversación a una persona.'
    END;
    INSERT INTO work_items (tenant_id, type, priority, title, detail, conversation_id, contact_id, source)
      VALUES (NEW.tenant_id, 'atencion_humana', 1, 'Atender a ' || v_name, v_reason, NEW.id, NEW.contact_id, 'agente')
      ON CONFLICT (tenant_id, conversation_id) WHERE type = 'atencion_humana' AND status IN ('abierto', 'en_proceso')
      DO NOTHING;
  ELSIF (NEW.status = 'bot' AND OLD.status = 'human') OR (NEW.status = 'closed' AND OLD.status <> 'closed') THEN
    UPDATE work_items SET status = 'resuelto', resolved_at = now()
      WHERE tenant_id = NEW.tenant_id AND conversation_id = NEW.id
        AND type = 'atencion_humana' AND status IN ('abierto', 'en_proceso');
  END IF;
  RETURN NEW;
END
$$;

-- ---- Invitaciones pendientes del negocio ACTUAL (la tabla no es legible por la aplicación)
CREATE FUNCTION tenant_pending_invitations() RETURNS integer
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT count(*)::int FROM invitations
   WHERE tenant_id = app_current_tenant() AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > now()
$$;
REVOKE ALL ON FUNCTION tenant_pending_invitations() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION tenant_pending_invitations() TO app_user;
