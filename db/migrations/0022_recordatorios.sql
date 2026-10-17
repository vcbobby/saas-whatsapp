-- Paso 16D: reglas por TIEMPO («24 h antes de una cita», «pedido sin confirmar desde hace X»).
-- Diseño:
--  * Un reloj en el worker (cada ~30 s) revisa SOLO los negocios que tienen reglas de tiempo activas (índice sin RLS: automation_time_index, solo ids).
--  * Cada coincidencia usa un id de evento DETERMINISTA (regla + cita/pedido [+ hora de la cita]); la restricción única
--    de la 16B/16C garantiza que nunca se avise dos veces lo mismo, aunque el reloj se repita o se reinicie.
--  * Recordatorio de cita: solo si la cita ya existía cuando llegó la hora del recordatorio (no se avisa «24 h antes» de una cita
--    hecha hace 3 horas) y si sigue pendiente o confirmada. Si se reprograma, avisa de nuevo para la hora nueva.

ALTER TABLE automation_rules DROP CONSTRAINT automation_rules_trigger_event_check;
ALTER TABLE automation_rules DROP CONSTRAINT automation_rules_mensaje_check;
ALTER TABLE automation_rules ADD COLUMN offset_minutes integer CHECK (offset_minutes BETWEEN 1 AND 43200);
ALTER TABLE automation_rules
  ADD CONSTRAINT automation_rules_trigger_event_check CHECK (trigger_event IN
    ('order.created','order.status_changed','appointment.created','appointment.status_changed','appointment.rescheduled','conversation.handoff','appointment.upcoming','order.pending_stale')),
  ADD CONSTRAINT automation_rules_mensaje_check CHECK (
    (action_type = 'tarea' AND message_template IS NULL)
    OR (action_type = 'mensaje' AND message_template IS NOT NULL
        AND trigger_event IN ('order.created','order.status_changed','appointment.created','appointment.status_changed','appointment.rescheduled','appointment.upcoming','order.pending_stale'))),
  ADD CONSTRAINT automation_rules_offset_check CHECK ((trigger_event IN ('appointment.upcoming','order.pending_stale')) = (offset_minutes IS NOT NULL));

-- Índice de negocios con reglas de tiempo activas (sin RLS, solo ids; la app no lo toca directamente).
CREATE TABLE automation_time_index (
  tenant_id uuid PRIMARY KEY,
  last_tick_at timestamptz
);
REVOKE ALL ON automation_time_index FROM PUBLIC, app_user;

CREATE FUNCTION automation_time_index_trg() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_tenant uuid := COALESCE(NEW.tenant_id, OLD.tenant_id);
BEGIN
  IF EXISTS (SELECT 1 FROM automation_rules WHERE tenant_id = v_tenant AND active AND offset_minutes IS NOT NULL) THEN
    INSERT INTO automation_time_index (tenant_id) VALUES (v_tenant) ON CONFLICT DO NOTHING;
  ELSE
    DELETE FROM automation_time_index WHERE tenant_id = v_tenant;
  END IF;
  RETURN NULL;
END
$$;
CREATE TRIGGER automation_rules_indice_tiempo AFTER INSERT OR UPDATE OR DELETE ON automation_rules
  FOR EACH ROW EXECUTE FUNCTION automation_time_index_trg();

-- Toma hasta p_limit negocios cuya última revisión fue hace más de p_every_seconds. Devuelve solo ids.
CREATE FUNCTION time_tick_claim(p_limit integer, p_every_seconds integer) RETURNS TABLE (out_tenant_id uuid)
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  UPDATE automation_time_index i SET last_tick_at = now()
   WHERE i.tenant_id IN (
     SELECT k.tenant_id FROM automation_time_index k
      WHERE k.last_tick_at IS NULL OR k.last_tick_at < now() - make_interval(secs => GREATEST(COALESCE(p_every_seconds, 30), 5))
      ORDER BY k.last_tick_at NULLS FIRST
      FOR UPDATE SKIP LOCKED
      LIMIT LEAST(GREATEST(COALESCE(p_limit, 1), 1), 50))
  RETURNING i.tenant_id;
$$;
REVOKE ALL ON FUNCTION time_tick_claim(integer, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION time_tick_claim(integer, integer) TO app_user;

-- run_automations ahora puede limitarse a UNA regla (p_rule): así las reglas de tiempo no activan a las demás.
DROP FUNCTION run_automations(uuid, text, jsonb, uuid);
CREATE FUNCTION run_automations(p_tenant uuid, p_type text, p_data jsonb, p_event uuid, p_rule uuid DEFAULT NULL) RETURNS void
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
  IF NOT EXISTS (SELECT 1 FROM automation_rules WHERE tenant_id = p_tenant AND active AND trigger_event = p_type AND (p_rule IS NULL OR id = p_rule)) THEN
    RETURN;
  END IF;
  SELECT count(*) INTO v_open FROM work_items WHERE tenant_id = p_tenant AND source = 'sistema' AND dedupe_key LIKE 'auto:%' AND status IN ('abierto','en_proceso');
  IF v_open >= 500 THEN
    RAISE WARNING 'run_automations: demasiadas tareas automáticas abiertas para %', p_tenant;
    RETURN;
  END IF;
  FOR r IN SELECT * FROM automation_rules WHERE tenant_id = p_tenant AND active AND trigger_event = p_type
            AND (p_rule IS NULL OR id = p_rule) AND (only_status IS NULL OR only_status = v_status) ORDER BY created_at, id LOOP
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


-- Revisa las reglas de tiempo de UN negocio (se llama dentro de withTenant). Devuelve cuántos eventos procesó.
CREATE FUNCTION run_time_automations(p_tenant uuid) RETURNS integer
LANGUAGE plpgsql AS $$
DECLARE
  r record; a record; o record;
  v_n integer := 0;
BEGIN
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
      END IF;
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING 'run_time_automations: la regla % falló: %', r.id, SQLERRM;
    END;
  END LOOP;
  RETURN v_n;
END
$$;
