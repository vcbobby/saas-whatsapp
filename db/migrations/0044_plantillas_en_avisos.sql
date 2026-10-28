-- Paso 32: plantillas de WhatsApp en los avisos automáticos.
-- Una regla de «avisar al cliente» puede tener una plantilla aprobada de respaldo: si al enviar el aviso ya pasaron las 24 horas del
-- último mensaje del cliente, se envía la plantilla (con los datos del pedido/cita) en lugar de crear una tarea para avisar a mano.
-- Al crearse el aviso se guarda una copia de la plantilla ya llena (nombre, idioma, datos y texto), así que borrar o cambiar la plantilla después no lo rompe.

ALTER TABLE whatsapp_templates ADD CONSTRAINT whatsapp_templates_tenant_id_key UNIQUE (tenant_id, id);

ALTER TABLE automation_rules
  ADD COLUMN template_id uuid,
  ADD COLUMN template_params jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD CONSTRAINT automation_rules_template_fk FOREIGN KEY (tenant_id, template_id) REFERENCES whatsapp_templates (tenant_id, id) ON DELETE SET NULL (template_id),
  ADD CONSTRAINT automation_rules_template_check CHECK (jsonb_typeof(template_params) = 'array' AND jsonb_array_length(template_params) <= 10 AND (template_id IS NULL OR action_type = 'mensaje'));

ALTER TABLE customer_notifications
  ADD COLUMN template_name text CHECK (template_name ~ '^[a-z0-9_]{1,100}$'),
  ADD COLUMN template_language text CHECK (template_language ~ '^[a-z]{2,3}(_[A-Z]{2})?$'),
  ADD COLUMN template_params jsonb CHECK (template_params IS NULL OR (jsonb_typeof(template_params) = 'array' AND jsonb_array_length(template_params) <= 10)),
  ADD COLUMN template_text text CHECK (char_length(template_text) <= 1024),
  ADD CONSTRAINT customer_notifications_template_check CHECK ((template_name IS NULL) = (template_language IS NULL) AND (template_name IS NULL) = (template_text IS NULL) AND (template_name IS NULL) = (template_params IS NULL));

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
  v_t_name text; v_t_lang text; v_t_body text; v_t_params jsonb; v_t_text text; v_t_vars integer; v_k integer;
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
      ELSIF r.action_type = 'app' THEN
        -- Aviso a una app conectada (Telegram, Discord, Slack, Zapier…): una entrega por regla+evento, sin duplicar.
        IF r.target_endpoint_id IS NOT NULL THEN
          v_body := left(render_template(r.message_template, p_tenant, p_data), 1000);
          IF v_body <> '' AND EXISTS (SELECT 1 FROM webhook_endpoints e WHERE e.tenant_id = p_tenant AND e.id = r.target_endpoint_id AND e.active)
             AND (SELECT count(*) FROM webhook_deliveries WHERE tenant_id = p_tenant AND status = 'pendiente') < 5000 THEN
            INSERT INTO webhook_deliveries (tenant_id, endpoint_id, event_id, event_type, payload)
            VALUES (p_tenant, r.target_endpoint_id, md5('app:' || r.id::text || ':' || p_event::text)::uuid, 'automation.message',
                    jsonb_build_object('id', md5('app:' || r.id::text || ':' || p_event::text)::uuid, 'type', 'automation.message', 'api_version', '2026-10-01',
                      'created_at', to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
                      'data', jsonb_build_object('text', v_body, 'rule', r.name, 'source_event', p_type)))
            ON CONFLICT DO NOTHING;
          END IF;
        END IF;
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

        -- Plantilla de respaldo (opcional): si al enviar ya pasaron las 24 h, se manda esta plantilla aprobada en vez de crear la tarea.
        -- Se guarda una copia con los datos ya llenos; si algún dato queda vacío o la plantilla ya no sirve, no se usa.
        v_t_name := NULL; v_t_lang := NULL; v_t_params := NULL; v_t_text := NULL;
        IF r.template_id IS NOT NULL THEN
          SELECT t.name, t.language, t.body INTO v_t_name, v_t_lang, v_t_body
            FROM whatsapp_templates t WHERE t.tenant_id = p_tenant AND t.id = r.template_id AND t.status = 'APPROVED' AND t.sendable;
          IF v_t_name IS NOT NULL THEN
            SELECT COALESCE(jsonb_agg(to_jsonb(left(btrim(regexp_replace(render_template(x.v, p_tenant, p_data), '[\r\n\t ]+', ' ', 'g')), 600)) ORDER BY x.ord), '[]'::jsonb)
              INTO v_t_params FROM jsonb_array_elements_text(r.template_params) WITH ORDINALITY AS x(v, ord);
            SELECT count(DISTINCT m[1]) INTO v_t_vars FROM regexp_matches(v_t_body, '\{\{\s*(\d{1,2})\s*\}\}', 'g') AS m;
            IF jsonb_array_length(v_t_params) <> v_t_vars OR EXISTS (SELECT 1 FROM jsonb_array_elements_text(v_t_params) e WHERE btrim(e) = '') THEN
              v_t_name := NULL; v_t_lang := NULL;
            END IF;
            IF v_t_name IS NOT NULL THEN
              v_t_text := regexp_replace(v_t_body, '\{\{\s*(\d{1,2})\s*\}\}', '{{\1}}', 'g');
              FOR v_k IN 1..jsonb_array_length(v_t_params) LOOP
                v_t_text := replace(v_t_text, '{{' || v_k || '}}', v_t_params ->> (v_k - 1));
              END LOOP;
              v_t_text := left(v_t_text, 1024);
            END IF;
          END IF;
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
        INSERT INTO customer_notifications (tenant_id, rule_id, event_id, contact_id, conversation_id, customer_name, body, fallback_title, status, reason, finished_at,
                                            template_name, template_language, template_params, template_text)
        VALUES (p_tenant, r.id, p_event, v_contact, v_conv, left(v_name, 200), v_body, v_title, v_status_n, v_reason, CASE WHEN v_status_n = 'pendiente' THEN NULL ELSE now() END,
                v_t_name, v_t_lang, CASE WHEN v_t_name IS NULL THEN NULL ELSE v_t_params END, v_t_text)
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
