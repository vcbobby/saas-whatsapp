-- Paso 28: conexiones por app (Telegram, Discord, Slack, Zapier/Make/n8n) y automatizaciones más amplias.
-- Diseño:
--  * Una conexión tiene un «tipo» (kind). El tipo «webhook» es el de siempre (aviso firmado). Los tipos de app guardan sus
--    credenciales (enlace del canal, token del bot…) CIFRADAS en app_config_enc; la columna url solo lleva un texto para mostrar.
--  * Eventos nuevos: contact.created (primer mensaje de un cliente nuevo) y stock.low (producto bajo o agotado).
--  * Acción nueva «app»: una regla puede enviar un texto a una conexión concreta. Si esa conexión se borra, la regla queda sin destino.

ALTER TABLE webhook_endpoints
  ADD COLUMN kind text NOT NULL DEFAULT 'webhook' CHECK (kind IN ('webhook','zapier','make','n8n','discord','slack','telegram')),
  ADD COLUMN app_config_enc text,
  ADD COLUMN app_key_version integer,
  ADD CONSTRAINT webhook_endpoints_config_check CHECK ((kind IN ('discord','slack','telegram')) = (app_config_enc IS NOT NULL AND app_key_version IS NOT NULL));
ALTER TABLE webhook_endpoints DROP CONSTRAINT webhook_endpoints_events_check;
ALTER TABLE webhook_endpoints ADD CONSTRAINT webhook_endpoints_events_check CHECK (
  cardinality(events) BETWEEN 1 AND 12
  AND events <@ ARRAY['order.created','order.status_changed','appointment.created','appointment.status_changed','appointment.rescheduled','conversation.handoff','contact.created','stock.low']::text[]);

ALTER TABLE automation_rules DROP CONSTRAINT automation_rules_trigger_event_check;
ALTER TABLE automation_rules DROP CONSTRAINT automation_rules_mensaje_check;
ALTER TABLE automation_rules DROP CONSTRAINT automation_rules_action_type_check;
ALTER TABLE automation_rules ADD COLUMN target_endpoint_id uuid;
ALTER TABLE automation_rules
  ADD CONSTRAINT automation_rules_target_fk FOREIGN KEY (tenant_id, target_endpoint_id) REFERENCES webhook_endpoints (tenant_id, id) ON DELETE SET NULL (target_endpoint_id),
  ADD CONSTRAINT automation_rules_action_type_check CHECK (action_type IN ('tarea','mensaje','app')),
  ADD CONSTRAINT automation_rules_trigger_event_check CHECK (trigger_event IN
    ('order.created','order.status_changed','appointment.created','appointment.status_changed','appointment.rescheduled','conversation.handoff','appointment.upcoming','order.pending_stale','contact.created','stock.low')),
  ADD CONSTRAINT automation_rules_mensaje_check CHECK (
    (action_type = 'tarea' AND message_template IS NULL AND target_endpoint_id IS NULL)
    OR (action_type = 'mensaje' AND message_template IS NOT NULL AND target_endpoint_id IS NULL
        AND trigger_event IN ('order.created','order.status_changed','appointment.created','appointment.status_changed','appointment.rescheduled','appointment.upcoming','order.pending_stale'))
    OR (action_type = 'app' AND message_template IS NOT NULL));

-- Plantillas: {cliente} también para clientes nuevos; {producto} y {stock} para avisos de inventario.
CREATE OR REPLACE FUNCTION render_template(p_tpl text, p_tenant uuid, p_data jsonb) RETURNS text
LANGUAGE plpgsql STABLE AS $$
DECLARE
  v_status text := COALESCE(p_data #>> '{order,status}', p_data #>> '{appointment,status}');
  v_name text := COALESCE(p_data #>> '{order,customer_name}', p_data #>> '{appointment,customer_name}', p_data #>> '{conversation,contact_name}', p_data #>> '{contact,name}', 'cliente');
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
  v := replace(v, '{producto}', COALESCE(p_data #>> '{product,name}', ''));
  v := replace(v, '{stock}', COALESCE(p_data #>> '{product,stock}', ''));
  RETURN btrim(regexp_replace(v, '[ \t]+', ' ', 'g'));
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

-- Cliente nuevo: se avisa cuando se crea el contacto (el primer mensaje que escribe). Un contacto que ya existía no vuelve a disparar.
CREATE FUNCTION trg_contact_created() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM emit_event(NEW.tenant_id, 'contact.created', jsonb_build_object('contact', jsonb_build_object('id', NEW.id, 'name', COALESCE(NEW.display_name, 'cliente'), 'phone', NEW.wa_id, 'created_at', NEW.created_at)));
  RETURN NULL;
END
$$;
CREATE TRIGGER contacts_evento_nuevo AFTER INSERT ON contacts FOR EACH ROW EXECUTE FUNCTION trg_contact_created();

-- Inventario: avisa al CRUZAR el mínimo hacia abajo (de «bien» a «bajo») o al quedar en 0 (agotado). No repite mientras siga bajo.
-- El mínimo por defecto (10) debe coincidir con DEFAULT_LOW_STOCK de src/lib/inventory/levels.ts.
CREATE FUNCTION trg_stock_low() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_min integer := COALESCE(NEW.min_stock, 10);
BEGIN
  IF OLD.stock IS NULL OR NEW.stock IS NULL OR NEW.stock >= OLD.stock THEN RETURN NULL; END IF;
  IF (OLD.stock > v_min AND NEW.stock <= v_min) OR (OLD.stock > 0 AND NEW.stock <= 0) THEN
    PERFORM emit_event(NEW.tenant_id, 'stock.low', jsonb_build_object('product', jsonb_build_object(
      'id', NEW.id, 'name', NEW.name, 'stock', NEW.stock, 'min_stock', v_min, 'unit', NEW.unit, 'level', CASE WHEN NEW.stock <= 0 THEN 'agotado' ELSE 'bajo' END)));
  END IF;
  RETURN NULL;
END
$$;
CREATE TRIGGER catalog_products_evento_stock AFTER UPDATE OF stock ON catalog_products FOR EACH ROW EXECUTE FUNCTION trg_stock_low();
