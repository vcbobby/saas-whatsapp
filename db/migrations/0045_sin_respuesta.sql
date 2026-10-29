-- Paso 33: aviso por tiempo «un cliente lleva esperando respuesta de una persona».
-- Se activa cuando una conversación está en manos de una persona (status «human») y el último mensaje es del cliente, sin ninguna respuesta
-- (de la persona ni del asistente) desde hace los minutos elegidos. Acciones: tarea en «Hoy» o aviso a una app conectada (Telegram, Slack…).
-- No admite «avisar al cliente»: lo que falta es que una persona conteste.

ALTER TABLE automation_rules DROP CONSTRAINT automation_rules_trigger_event_check;
ALTER TABLE automation_rules DROP CONSTRAINT automation_rules_offset_check;
ALTER TABLE automation_rules
  ADD CONSTRAINT automation_rules_trigger_event_check CHECK (trigger_event IN
    ('order.created','order.status_changed','appointment.created','appointment.status_changed','appointment.rescheduled','conversation.handoff','appointment.upcoming','order.pending_stale','contact.created','stock.low','conversation.unanswered')),
  ADD CONSTRAINT automation_rules_offset_check CHECK ((trigger_event IN ('appointment.upcoming','order.pending_stale','conversation.unanswered')) = (offset_minutes IS NOT NULL));

CREATE OR REPLACE FUNCTION run_time_automations(p_tenant uuid) RETURNS integer
LANGUAGE plpgsql AS $$
DECLARE
  r record; a record; o record; c record;
  v_n integer := 0;
BEGIN
  IF NOT tenant_has_module(p_tenant, 'automatizaciones') THEN
    RETURN 0;
  END IF;
  FOR r IN SELECT * FROM automation_rules WHERE tenant_id = p_tenant AND active AND offset_minutes IS NOT NULL ORDER BY created_at, id LOOP
    BEGIN
      IF r.trigger_event = 'appointment.upcoming' THEN
        FOR a IN
          SELECT ap.id, ap.starts_at FROM appointments ap
           WHERE ap.tenant_id = p_tenant AND ap.status IN ('pendiente','confirmada')
             AND ap.starts_at > now()
             AND ap.starts_at - make_interval(mins => r.offset_minutes) <= now()
             AND ap.created_at <= ap.starts_at - make_interval(mins => r.offset_minutes)
           ORDER BY ap.starts_at LIMIT 200
        LOOP
          PERFORM run_automations(p_tenant, 'appointment.upcoming', COALESCE(appointment_event_data(p_tenant, a.id), '{}'::jsonb),
                                  md5(r.id::text || ':' || a.id::text || ':' || extract(epoch from a.starts_at)::text)::uuid, r.id);
          v_n := v_n + 1;
        END LOOP;
      ELSIF r.trigger_event = 'order.pending_stale' THEN
        FOR o IN
          SELECT od.id FROM orders od
           WHERE od.tenant_id = p_tenant AND od.status = 'pendiente'
             AND od.created_at <= now() - make_interval(mins => r.offset_minutes)
             AND od.created_at + make_interval(mins => r.offset_minutes) >= r.created_at
           ORDER BY od.created_at LIMIT 200
        LOOP
          PERFORM run_automations(p_tenant, 'order.pending_stale', COALESCE(order_event_data(p_tenant, o.id), '{}'::jsonb),
                                  md5(r.id::text || ':' || o.id::text)::uuid, r.id);
          v_n := v_n + 1;
        END LOOP;
      ELSIF r.trigger_event = 'conversation.unanswered' THEN
        -- Conversaciones que pasaron a una persona y cuyo ÚLTIMO mensaje es del cliente, sin respuesta (de nadie) desde hace el tiempo elegido.
        -- Solo mensajes posteriores a la creación de la regla y de los últimos 7 días (no se inunda con historial viejo).
        -- El evento incluye el id del último mensaje del cliente: si vuelve a escribir y se queda sin respuesta, avisa de nuevo.
        FOR c IN
          SELECT cv.id AS conv_id, ct.display_name AS contact_name, lm.id AS msg_id
            FROM conversations cv
            JOIN contacts ct ON ct.tenant_id = cv.tenant_id AND ct.id = cv.contact_id
            JOIN LATERAL (SELECT im.id, im.created_at FROM messages im
                           WHERE im.tenant_id = cv.tenant_id AND im.conversation_id = cv.id AND im.direction = 'in'
                           ORDER BY im.created_at DESC, im.id DESC LIMIT 1) lm ON true
           WHERE cv.tenant_id = p_tenant AND cv.status = 'human'
             AND lm.created_at <= now() - make_interval(mins => r.offset_minutes)
             AND lm.created_at + make_interval(mins => r.offset_minutes) >= r.created_at
             AND lm.created_at > now() - interval '7 days'
             AND NOT EXISTS (SELECT 1 FROM messages om WHERE om.tenant_id = cv.tenant_id AND om.conversation_id = cv.id AND om.direction = 'out' AND om.created_at > lm.created_at)
           ORDER BY lm.created_at LIMIT 200
        LOOP
          PERFORM run_automations(p_tenant, 'conversation.unanswered',
                                  jsonb_build_object('conversation', jsonb_build_object('id', c.conv_id, 'contact_name', c.contact_name, 'status', 'human')),
                                  md5(r.id::text || ':' || c.conv_id::text || ':' || c.msg_id::text)::uuid, r.id);
          v_n := v_n + 1;
        END LOOP;
      END IF;
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING 'run_time_automations: la regla % falló: %', r.id, SQLERRM;
    END;
  END LOOP;
  RETURN v_n;
END
$$;
