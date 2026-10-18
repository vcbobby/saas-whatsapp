-- Paso 18B: los módulos incluidos en el plan se APLICAN.
-- Módulos: agenda, catalogo (catálogo y pedidos), copiloto, automatizaciones (reglas y conexiones/webhooks).

CREATE FUNCTION tenant_has_module(p_tenant uuid, p_module text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT COALESCE((SELECT p_module = ANY (p.modules) FROM tenants t JOIN plans p ON p.id = t.plan_id WHERE t.id = p_tenant), false)
$$;
REVOKE ALL ON FUNCTION tenant_has_module(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION tenant_has_module(uuid, text) TO app_user;

-- Sin el módulo de automatizaciones no se disparan reglas ni se encolan entregas a conexiones.
CREATE OR REPLACE FUNCTION emit_event(p_tenant uuid, p_type text, p_data jsonb) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
  v_event uuid := gen_random_uuid();
  v_payload jsonb;
BEGIN
  IF NOT tenant_has_module(p_tenant, 'automatizaciones') THEN
    RETURN; -- sin el módulo no hay automatizaciones ni entregas a conexiones
  END IF;
  BEGIN
    PERFORM run_automations(p_tenant, p_type, p_data, v_event);
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'emit_event: automatizaciones fallaron (%): %', p_type, SQLERRM;
  END;
  IF NOT EXISTS (SELECT 1 FROM webhook_endpoints WHERE tenant_id = p_tenant AND active AND p_type = ANY (events)) THEN
    RETURN;
  END IF;
  IF (SELECT count(*) FROM webhook_deliveries WHERE tenant_id = p_tenant AND status = 'pendiente') >= 5000 THEN
    RAISE WARNING 'emit_event: demasiadas entregas pendientes para el negocio %', p_tenant;
    RETURN;
  END IF;
  v_payload := jsonb_build_object(
    'id', v_event, 'type', p_type, 'api_version', '2026-10-01',
    'created_at', to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'), 'data', p_data);
  INSERT INTO webhook_deliveries (tenant_id, endpoint_id, event_id, event_type, payload)
  SELECT e.tenant_id, e.id, v_event, p_type, v_payload
    FROM webhook_endpoints e WHERE e.tenant_id = p_tenant AND e.active AND p_type = ANY (e.events);
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'emit_event falló (%): %', p_type, SQLERRM;
END
$$;
CREATE OR REPLACE FUNCTION run_automations(p_tenant uuid, p_type text, p_data jsonb, p_event uuid, p_rule uuid DEFAULT NULL) RETURNS void
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
  IF NOT tenant_has_module(p_tenant, 'automatizaciones') THEN
    RETURN; -- el plan del negocio no incluye automatizaciones
  END IF;
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
CREATE OR REPLACE FUNCTION run_time_automations(p_tenant uuid) RETURNS integer
LANGUAGE plpgsql AS $$
DECLARE
  r record; a record; o record;
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
      END IF;
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING 'run_time_automations: la regla % falló: %', r.id, SQLERRM;
    END;
  END LOOP;
  RETURN v_n;
END
$$;

-- ---- Plan de prueba: es el de los negocios nuevos. Trae TODOS los módulos (para probar la app completa)
-- pero pocas respuestas al mes. Los Planes 1-3 quedan como planes de pago.
UPDATE plans SET is_default = false WHERE is_default;
INSERT INTO plans (slug, name, position, is_default, max_replies_month, max_members, modules)
  VALUES ('prueba', 'Prueba gratis', 0, true, 200, 3, ARRAY['agenda','catalogo','copiloto','automatizaciones']);
-- Los negocios que estaban en el antiguo plan por defecto (Plan 1) pasan a la prueba, para que no pierdan módulos de golpe.
-- (tenants tiene FORCE RLS: se suspende solo durante este UPDATE de la migración)
ALTER TABLE tenants DISABLE TRIGGER tenants_plan_guard;
ALTER TABLE tenants NO FORCE ROW LEVEL SECURITY;
UPDATE tenants SET plan_id = (SELECT id FROM plans WHERE slug = 'prueba') WHERE plan_id = (SELECT id FROM plans WHERE slug = 'plan-1');
ALTER TABLE tenants FORCE ROW LEVEL SECURITY;
ALTER TABLE tenants ENABLE TRIGGER tenants_plan_guard;
