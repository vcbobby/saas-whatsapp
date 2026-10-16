-- Paso 16C: las reglas de automatización pueden AVISAR AL CLIENTE por WhatsApp («Tu pedido #12 fue confirmado»).
-- Seguridad de diseño:
--  * El aviso nace en la misma transacción que el cambio (igual que las tareas) y queda en customer_notifications (un solo aviso por regla+evento).
--  * Lo envía el worker; solo dentro de las 24 h del último mensaje del cliente (si no, se crea una tarea en «Hoy» para avisarle por otro medio).
--  * Tope: 5 avisos automáticos por cliente cada 24 h (frena bucles). El cliente puede pedir la baja (contacts.notifications_off).
--  * La cola entre negocios (notification_queue) solo guarda ids; la app no la toca directamente.

ALTER TABLE contacts ADD COLUMN notifications_off boolean NOT NULL DEFAULT false;

ALTER TABLE automation_rules
  ADD COLUMN action_type text NOT NULL DEFAULT 'tarea' CHECK (action_type IN ('tarea', 'mensaje')),
  ADD COLUMN message_template text CHECK (char_length(message_template) BETWEEN 1 AND 600),
  ADD CONSTRAINT automation_rules_mensaje_check CHECK (
    (action_type = 'tarea' AND message_template IS NULL)
    OR (action_type = 'mensaje' AND message_template IS NOT NULL
        AND trigger_event IN ('order.created','order.status_changed','appointment.created','appointment.status_changed','appointment.rescheduled'))
  );

CREATE TABLE customer_notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  rule_id uuid NOT NULL,
  event_id uuid NOT NULL,
  contact_id uuid,
  conversation_id uuid,
  customer_name text CHECK (char_length(customer_name) <= 200),
  body text NOT NULL CHECK (char_length(body) BETWEEN 1 AND 1000),
  -- Título de la tarea que se crea si el aviso no se puede enviar.
  fallback_title text NOT NULL CHECK (char_length(fallback_title) BETWEEN 1 AND 200),
  status text NOT NULL DEFAULT 'pendiente' CHECK (status IN ('pendiente', 'enviado', 'omitido', 'fallido')),
  reason text CHECK (char_length(reason) <= 300),
  attempts integer NOT NULL DEFAULT 0,
  message_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, rule_id, event_id),
  CHECK ((status = 'pendiente') = (finished_at IS NULL))
);
CREATE INDEX customer_notifications_negocio_idx ON customer_notifications (tenant_id, created_at DESC);
CREATE INDEX customer_notifications_contacto_idx ON customer_notifications (tenant_id, contact_id, created_at DESC);
ALTER TABLE customer_notifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE customer_notifications FORCE ROW LEVEL SECURITY;
CREATE POLICY customer_notifications_aislamiento ON customer_notifications
  USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());

-- Cola entre negocios (sin RLS, solo ids). La app no la toca directamente.
CREATE TABLE notification_queue (
  notification_id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  locked_until timestamptz
);
CREATE INDEX notification_queue_due_idx ON notification_queue (next_attempt_at);
REVOKE ALL ON notification_queue FROM PUBLIC, app_user;

CREATE FUNCTION notification_enqueue_trg() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF NEW.status = 'pendiente' THEN
    INSERT INTO notification_queue (notification_id, tenant_id) VALUES (NEW.id, NEW.tenant_id) ON CONFLICT DO NOTHING;
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER customer_notifications_encolar AFTER INSERT ON customer_notifications
  FOR EACH ROW EXECUTE FUNCTION notification_enqueue_trg();

CREATE FUNCTION notification_claim(p_limit integer, p_lock_seconds integer)
RETURNS TABLE (out_tenant_id uuid, out_notification_id uuid)
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  UPDATE notification_queue q SET locked_until = now() + make_interval(secs => LEAST(GREATEST(COALESCE(p_lock_seconds, 60), 10), 600))
   WHERE q.notification_id IN (
     SELECT k.notification_id FROM notification_queue k
      WHERE k.next_attempt_at <= now() AND (k.locked_until IS NULL OR k.locked_until < now())
      ORDER BY k.next_attempt_at
      FOR UPDATE SKIP LOCKED
      LIMIT LEAST(GREATEST(COALESCE(p_limit, 1), 1), 50))
  RETURNING q.tenant_id, q.notification_id;
$$;
REVOKE ALL ON FUNCTION notification_claim(integer, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION notification_claim(integer, integer) TO app_user;

CREATE FUNCTION notification_queue_set(p_notification uuid, p_next_at timestamptz) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  WITH del AS (DELETE FROM notification_queue WHERE notification_id = p_notification AND tenant_id = app_current_tenant() AND p_next_at IS NULL RETURNING 1)
  UPDATE notification_queue SET next_attempt_at = p_next_at, locked_until = NULL
   WHERE notification_id = p_notification AND tenant_id = app_current_tenant() AND p_next_at IS NOT NULL;
$$;
REVOKE ALL ON FUNCTION notification_queue_set(uuid, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION notification_queue_set(uuid, timestamptz) TO app_user;

-- Rellena {cliente} {numero} {servicio} {total} {estado} {fecha} con los datos del evento.
CREATE FUNCTION render_template(p_tpl text, p_tenant uuid, p_data jsonb) RETURNS text
LANGUAGE plpgsql STABLE AS $$
DECLARE
  v_status text := COALESCE(p_data #>> '{order,status}', p_data #>> '{appointment,status}');
  v_name text := COALESCE(p_data #>> '{order,customer_name}', p_data #>> '{appointment,customer_name}', p_data #>> '{conversation,contact_name}', 'cliente');
  v_total text := CASE WHEN p_data #> '{order,total_minor}' IS NULL THEN ''
                       ELSE to_char(round(((p_data #>> '{order,total_minor}')::numeric) / 100, 2), 'FM999999999990.00') || ' ' || COALESCE(p_data #>> '{order,currency}', '') END;
  v_tz text := COALESCE((SELECT timezone FROM agenda_settings WHERE tenant_id = p_tenant), 'America/Caracas');
  v_when text := '';
  v text := p_tpl;
BEGIN
  IF p_data #>> '{appointment,starts_at}' IS NOT NULL THEN
    v_when := to_char((p_data #>> '{appointment,starts_at}')::timestamptz AT TIME ZONE v_tz, 'DD/MM/YYYY "a las" HH24:MI');
  END IF;
  v := replace(v, '{cliente}', COALESCE(v_name, 'cliente'));
  v := replace(v, '{numero}', COALESCE(p_data #>> '{order,number}', ''));
  v := replace(v, '{servicio}', COALESCE(p_data #>> '{appointment,service}', ''));
  v := replace(v, '{total}', v_total);
  v := replace(v, '{estado}', COALESCE(v_status, ''));
  v := replace(v, '{fecha}', v_when);
  RETURN btrim(regexp_replace(v, '[ \t]+', ' ', 'g'));
END
$$;

-- Reglas: ahora con dos acciones (tarea / aviso al cliente).
CREATE OR REPLACE FUNCTION run_automations(p_tenant uuid, p_type text, p_data jsonb, p_event uuid) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
  r record;
  v_status text := COALESCE(p_data #>> '{order,status}', p_data #>> '{appointment,status}');
  v_name text := COALESCE(p_data #>> '{order,customer_name}', p_data #>> '{appointment,customer_name}', p_data #>> '{conversation,contact_name}', 'cliente');
  v_title text;
  v_body text;
  v_open integer;
  v_pending integer;
  v_ref_conv uuid; v_ref_contact uuid; v_phone text;
  v_contact uuid; v_conv uuid; v_off boolean; v_recent integer;
  v_status_n text; v_reason text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM automation_rules WHERE tenant_id = p_tenant AND active AND trigger_event = p_type) THEN
    RETURN;
  END IF;
  SELECT count(*) INTO v_open FROM work_items WHERE tenant_id = p_tenant AND source = 'sistema' AND dedupe_key LIKE 'auto:%' AND status IN ('abierto','en_proceso');
  IF v_open >= 500 THEN
    RAISE WARNING 'run_automations: demasiadas tareas automáticas abiertas para %', p_tenant;
    RETURN;
  END IF;
  FOR r IN SELECT * FROM automation_rules WHERE tenant_id = p_tenant AND active AND trigger_event = p_type
            AND (only_status IS NULL OR only_status = v_status) ORDER BY created_at, id LOOP
    BEGIN
      v_title := left(render_template(r.task_title, p_tenant, p_data), 200);
      IF v_title = '' THEN v_title := left(r.name, 200); END IF;

      IF r.action_type = 'tarea' THEN
        INSERT INTO work_items (tenant_id, type, priority, title, due_at, source, dedupe_key)
        VALUES (p_tenant, 'tarea', r.task_priority, v_title,
                CASE WHEN r.task_due_minutes IS NULL THEN NULL ELSE now() + make_interval(mins => r.task_due_minutes) END,
                'sistema', 'auto:' || r.id::text || ':' || p_event::text)
        ON CONFLICT DO NOTHING;
      ELSE
        v_body := left(render_template(r.message_template, p_tenant, p_data), 1000);
        IF v_body = '' THEN CONTINUE; END IF;
        -- ¿A quién? Conversación del pedido/cita → contacto del pedido/cita → teléfono que coincida con un contacto.
        v_ref_conv := NULL; v_ref_contact := NULL; v_contact := NULL; v_conv := NULL;
        IF p_type LIKE 'order.%' THEN
          SELECT o.conversation_id, o.contact_id, o.customer_phone INTO v_ref_conv, v_ref_contact, v_phone FROM orders o WHERE o.tenant_id = p_tenant AND o.id = (p_data #>> '{order,id}')::uuid;
        ELSE
          SELECT a.conversation_id, a.contact_id, a.customer_phone INTO v_ref_conv, v_ref_contact, v_phone FROM appointments a WHERE a.tenant_id = p_tenant AND a.id = (p_data #>> '{appointment,id}')::uuid;
        END IF;
        IF v_ref_conv IS NOT NULL THEN
          SELECT c.id, c.contact_id INTO v_conv, v_contact FROM conversations c WHERE c.tenant_id = p_tenant AND c.id = v_ref_conv;
        END IF;
        IF v_contact IS NULL AND v_ref_contact IS NOT NULL THEN v_contact := v_ref_contact; END IF;
        IF v_contact IS NULL AND v_phone IS NOT NULL AND regexp_replace(v_phone, '\D', '', 'g') <> '' THEN
          SELECT ct.id INTO v_contact FROM contacts ct WHERE ct.tenant_id = p_tenant AND ct.wa_id = regexp_replace(v_phone, '\D', '', 'g');
        END IF;
        IF v_conv IS NULL AND v_contact IS NOT NULL THEN
          SELECT c.id INTO v_conv FROM conversations c WHERE c.tenant_id = p_tenant AND c.contact_id = v_contact AND c.status <> 'closed' ORDER BY c.created_at DESC LIMIT 1;
        END IF;

        v_status_n := 'pendiente'; v_reason := NULL;
        IF v_contact IS NULL OR v_conv IS NULL THEN
          v_status_n := 'omitido'; v_reason := 'sin_conversacion';
        ELSE
          SELECT notifications_off INTO v_off FROM contacts WHERE tenant_id = p_tenant AND id = v_contact;
          SELECT count(*) INTO v_recent FROM customer_notifications WHERE tenant_id = p_tenant AND contact_id = v_contact AND status IN ('pendiente','enviado') AND created_at > now() - interval '24 hours';
          SELECT count(*) INTO v_pending FROM customer_notifications WHERE tenant_id = p_tenant AND status = 'pendiente';
          IF v_off THEN v_status_n := 'omitido'; v_reason := 'baja';
          ELSIF v_recent >= 5 THEN v_status_n := 'omitido'; v_reason := 'limite_24h';
          ELSIF v_pending >= 2000 THEN v_status_n := 'omitido'; v_reason := 'cola_llena';
          END IF;
        END IF;
        INSERT INTO customer_notifications (tenant_id, rule_id, event_id, contact_id, conversation_id, customer_name, body, fallback_title, status, reason, finished_at)
        VALUES (p_tenant, r.id, p_event, v_contact, v_conv, left(v_name, 200), v_body, v_title, v_status_n, v_reason, CASE WHEN v_status_n = 'pendiente' THEN NULL ELSE now() END)
        ON CONFLICT DO NOTHING;
        -- Si de entrada no se puede avisar, queda una tarea para hacerlo a mano (salvo que el cliente pidió la baja).
        IF v_status_n = 'omitido' AND v_reason <> 'baja' THEN
          INSERT INTO work_items (tenant_id, type, priority, title, detail, due_at, source, dedupe_key)
          VALUES (p_tenant, 'tarea', r.task_priority, v_title, left('No se pudo avisar por WhatsApp. Mensaje sugerido: ' || v_body, 2000),
                  CASE WHEN r.task_due_minutes IS NULL THEN NULL ELSE now() + make_interval(mins => r.task_due_minutes) END,
                  'sistema', 'auto:' || r.id::text || ':' || p_event::text)
          ON CONFLICT DO NOTHING;
        END IF;
      END IF;
      UPDATE automation_rules SET run_count = run_count + 1, last_run_at = now() WHERE tenant_id = p_tenant AND id = r.id;
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING 'run_automations: la regla % falló: %', r.id, SQLERRM;
    END;
  END LOOP;
END
$$;
