-- Paso 38: bandeja mejorada.
--  * Notas privadas dentro de la conversación (solo el equipo las ve; nunca salen por WhatsApp).
--  * Reparto automático: cuando el asistente pasa una conversación a una persona, se asigna sola.
--  * Aviso por correo al equipo (cola global `handoff_alerts`, que el worker vacía).

-- ------------------------------------------------------------------ notas privadas
CREATE TABLE conversation_notes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  conversation_id uuid NOT NULL,
  author_id uuid,
  author_label text NOT NULL CHECK (char_length(author_label) BETWEEN 1 AND 80),
  body text NOT NULL CHECK (char_length(body) BETWEEN 1 AND 2000),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, conversation_id) REFERENCES conversations (tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX conversation_notes_conv_idx ON conversation_notes (tenant_id, conversation_id, created_at);
ALTER TABLE conversation_notes ENABLE ROW LEVEL SECURITY;
ALTER TABLE conversation_notes FORCE ROW LEVEL SECURITY;
CREATE POLICY conversation_notes_aislamiento ON conversation_notes
  USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());
-- Una nota no se edita ni se borra desde la aplicación (queda como constancia de lo que se habló).
REVOKE UPDATE, DELETE ON conversation_notes FROM app_user;

-- ------------------------------------------------------------------ reparto
CREATE TABLE team_settings (
  tenant_id uuid PRIMARY KEY REFERENCES tenants (id) ON DELETE CASCADE,
  assign_mode text NOT NULL DEFAULT 'manual' CHECK (assign_mode IN ('manual', 'turnos', 'menos_carga')),
  notify_email boolean NOT NULL DEFAULT true,
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE team_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE team_settings FORCE ROW LEVEL SECURITY;
CREATE POLICY team_settings_aislamiento ON team_settings
  USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());

-- A quién le tocó la última vez (para repartir por turnos).
CREATE TABLE assignment_rotation (
  tenant_id uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  last_assigned_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, user_id)
);
ALTER TABLE assignment_rotation ENABLE ROW LEVEL SECURITY;
ALTER TABLE assignment_rotation FORCE ROW LEVEL SECURITY;
CREATE POLICY assignment_rotation_aislamiento ON assignment_rotation
  USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());

-- Cola global de avisos (sin RLS: solo se toca con funciones de abajo; el worker la vacía).
CREATE TABLE handoff_alerts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  conversation_id uuid NOT NULL,
  assigned_to uuid,
  reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  sent_at timestamptz
);
CREATE INDEX handoff_alerts_pendientes_idx ON handoff_alerts (created_at) WHERE sent_at IS NULL;
REVOKE ALL ON handoff_alerts FROM PUBLIC, app_user;

-- Elige a quién asignar. Con varios agentes, solo ellos; si el negocio no tiene agentes, todo el equipo.
CREATE FUNCTION pick_assignee(p_tenant uuid) RETURNS uuid
LANGUAGE plpgsql AS $$
DECLARE
  v_mode text;
  v_pick uuid;
BEGIN
  SELECT assign_mode INTO v_mode FROM team_settings WHERE tenant_id = p_tenant;
  IF v_mode IS NULL OR v_mode = 'manual' THEN RETURN NULL; END IF;
  WITH pool AS (
    SELECT m.user_id FROM memberships m
     WHERE m.tenant_id = p_tenant
       AND (m.role = 'agent' OR NOT EXISTS (SELECT 1 FROM memberships a WHERE a.tenant_id = p_tenant AND a.role = 'agent'))
  )
  SELECT p.user_id INTO v_pick
    FROM pool p LEFT JOIN assignment_rotation r ON r.tenant_id = p_tenant AND r.user_id = p.user_id
   ORDER BY
     CASE WHEN v_mode = 'menos_carga'
          THEN (SELECT count(*) FROM conversations c WHERE c.tenant_id = p_tenant AND c.status = 'human' AND c.assigned_to = p.user_id)
          ELSE 0 END,
     COALESCE(r.last_assigned_at, 'epoch'::timestamptz), p.user_id
   LIMIT 1;
  IF v_pick IS NOT NULL THEN
    INSERT INTO assignment_rotation (tenant_id, user_id, last_assigned_at) VALUES (p_tenant, v_pick, now())
      ON CONFLICT (tenant_id, user_id) DO UPDATE SET last_assigned_at = now();
  END IF;
  RETURN v_pick;
END
$$;

-- Cuando el asistente (o un fallo) pasa la conversación a una persona: se asigna según el reparto y se deja un aviso para el equipo.
-- Si alguien la toma a propósito ('tomada_por_persona') no se toca.
CREATE FUNCTION conversations_handoff_route() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF NEW.assigned_to IS NULL THEN
    NEW.assigned_to := pick_assignee(NEW.tenant_id);
  END IF;
  INSERT INTO handoff_alerts (tenant_id, conversation_id, assigned_to, reason)
    VALUES (NEW.tenant_id, NEW.id, NEW.assigned_to, NEW.handoff_reason);
  RETURN NEW;
END
$$;
CREATE TRIGGER conversations_handoff_route_trg BEFORE UPDATE ON conversations
  FOR EACH ROW WHEN (OLD.status = 'bot' AND NEW.status = 'human' AND NEW.handoff_reason IS DISTINCT FROM 'tomada_por_persona')
  EXECUTE FUNCTION conversations_handoff_route();

-- El worker toma los avisos pendientes (los marca como enviados al tomarlos: a lo sumo una vez).
CREATE FUNCTION handoff_alert_claim(p_limit integer) RETURNS TABLE (out_id uuid, out_tenant_id uuid, out_conversation_id uuid, out_assigned_to uuid, out_reason text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  DELETE FROM handoff_alerts WHERE created_at < now() - interval '7 days';
  RETURN QUERY
    UPDATE handoff_alerts h SET sent_at = now()
     WHERE h.id IN (SELECT k.id FROM handoff_alerts k WHERE k.sent_at IS NULL AND k.created_at > now() - interval '1 day'
                     ORDER BY k.created_at FOR UPDATE SKIP LOCKED LIMIT LEAST(GREATEST(COALESCE(p_limit, 1), 1), 100))
    RETURNING h.id, h.tenant_id, h.conversation_id, h.assigned_to, h.reason;
END
$$;
REVOKE ALL ON FUNCTION handoff_alert_claim(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION handoff_alert_claim(integer) TO app_user;

-- A quién avisar: la persona asignada (si sigue en el equipo) o, si nadie la tiene, el dueño y los administradores.
CREATE FUNCTION handoff_recipients(p_tenant uuid, p_user uuid) RETURNS TABLE (out_email text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT u.email FROM memberships m JOIN users u ON u.id = m.user_id
   WHERE m.tenant_id = p_tenant
     AND CASE WHEN p_user IS NOT NULL AND EXISTS (SELECT 1 FROM memberships x WHERE x.tenant_id = p_tenant AND x.user_id = p_user)
              THEN m.user_id = p_user ELSE m.role IN ('owner', 'admin') END
$$;
REVOKE ALL ON FUNCTION handoff_recipients(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION handoff_recipients(uuid, uuid) TO app_user;

-- Nombre corto de un miembro del equipo (lo que va antes de la @ del correo), solo si es de ese negocio.
CREATE FUNCTION member_label(p_tenant uuid, p_user uuid) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT split_part(u.email, '@', 1) FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.tenant_id = p_tenant AND m.user_id = p_user
$$;
REVOKE ALL ON FUNCTION member_label(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION member_label(uuid, uuid) TO app_user;
