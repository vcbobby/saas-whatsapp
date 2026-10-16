-- Paso 16B: reglas de automatización («cuando pase X, crea una tarea en Hoy»).
-- Diseño:
--  * Se apoyan en los mismos eventos de la 16A (emit_event): la tarea se crea EN LA MISMA TRANSACCIÓN que el cambio que la provoca,
--    así que no hay cola ni worker y no se puede perder ni duplicar (dedupe_key = regla + evento).
--  * Un fallo de una regla nunca deshace el pedido/cita que la disparó (cada regla corre en su propio bloque protegido).
--  * La acción de esta versión es solo «crear tarea». Mensajes a clientes llegarán aparte (necesitan ventana de 24 h y baja voluntaria).

CREATE TABLE automation_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 80),
  trigger_event text NOT NULL CHECK (trigger_event IN ('order.created','order.status_changed','appointment.created','appointment.status_changed','appointment.rescheduled','conversation.handoff')),
  -- Solo para «cambia de estado»: actuar únicamente cuando el NUEVO estado sea este (vacío = cualquiera).
  only_status text CHECK (char_length(only_status) <= 30),
  -- Plantilla del título. Admite {cliente} {numero} {servicio} {total} {estado}.
  task_title text NOT NULL CHECK (char_length(task_title) BETWEEN 1 AND 120),
  task_priority smallint NOT NULL DEFAULT 2 CHECK (task_priority BETWEEN 1 AND 3),
  -- Plazo de la tarea, en minutos desde que ocurre el evento (vacío = sin plazo). Máximo 30 días.
  task_due_minutes integer CHECK (task_due_minutes BETWEEN 1 AND 43200),
  active boolean NOT NULL DEFAULT true,
  run_count integer NOT NULL DEFAULT 0,
  last_run_at timestamptz,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  CHECK (only_status IS NULL OR trigger_event IN ('order.status_changed','appointment.status_changed'))
);
CREATE INDEX automation_rules_negocio_idx ON automation_rules (tenant_id, active, trigger_event);
ALTER TABLE automation_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE automation_rules FORCE ROW LEVEL SECURITY;
CREATE POLICY automation_rules_aislamiento ON automation_rules
  USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());

-- Tope por negocio: 20 reglas.
CREATE FUNCTION automation_rules_limite() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('au:' || NEW.tenant_id::text));
  IF (SELECT count(*) FROM automation_rules WHERE tenant_id = NEW.tenant_id) >= 20 THEN
    RAISE EXCEPTION 'Se alcanzó el máximo de 20 reglas' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER automation_rules_tope BEFORE INSERT ON automation_rules
  FOR EACH ROW EXECUTE FUNCTION automation_rules_limite();

-- Ejecuta las reglas que coinciden con un evento. Cada regla va en su propio bloque: si una falla, las demás siguen y el cambio original no se toca.
CREATE FUNCTION run_automations(p_tenant uuid, p_type text, p_data jsonb, p_event uuid) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
  r record;
  v_status text := COALESCE(p_data #>> '{order,status}', p_data #>> '{appointment,status}');
  v_name text := COALESCE(p_data #>> '{order,customer_name}', p_data #>> '{appointment,customer_name}', p_data #>> '{conversation,contact_name}', 'cliente');
  v_total text := CASE WHEN p_data #> '{order,total_minor}' IS NULL THEN ''
                       ELSE to_char(round(((p_data #>> '{order,total_minor}')::numeric) / 100, 2), 'FM999999999990.00') || ' ' || COALESCE(p_data #>> '{order,currency}', '') END;
  v_title text;
  v_open integer;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM automation_rules WHERE tenant_id = p_tenant AND active AND trigger_event = p_type) THEN
    RETURN;
  END IF;
  -- Freno: si ya hay muchas tareas automáticas abiertas, no se crean más (evita inundar «Hoy»).
  SELECT count(*) INTO v_open FROM work_items WHERE tenant_id = p_tenant AND source = 'sistema' AND dedupe_key LIKE 'auto:%' AND status IN ('abierto','en_proceso');
  IF v_open >= 500 THEN
    RAISE WARNING 'run_automations: demasiadas tareas automáticas abiertas para %', p_tenant;
    RETURN;
  END IF;
  FOR r IN SELECT * FROM automation_rules WHERE tenant_id = p_tenant AND active AND trigger_event = p_type
            AND (only_status IS NULL OR only_status = v_status) ORDER BY created_at, id LOOP
    BEGIN
      v_title := r.task_title;
      v_title := replace(v_title, '{cliente}', COALESCE(v_name, 'cliente'));
      v_title := replace(v_title, '{numero}', COALESCE(p_data #>> '{order,number}', ''));
      v_title := replace(v_title, '{servicio}', COALESCE(p_data #>> '{appointment,service}', ''));
      v_title := replace(v_title, '{total}', v_total);
      v_title := replace(v_title, '{estado}', COALESCE(v_status, ''));
      v_title := left(btrim(regexp_replace(v_title, '\s+', ' ', 'g')), 200);
      IF v_title = '' THEN v_title := left(r.name, 200); END IF;
      INSERT INTO work_items (tenant_id, type, priority, title, due_at, source, dedupe_key)
      VALUES (p_tenant, 'tarea', r.task_priority, v_title,
              CASE WHEN r.task_due_minutes IS NULL THEN NULL ELSE now() + make_interval(mins => r.task_due_minutes) END,
              'sistema', 'auto:' || r.id::text || ':' || p_event::text)
      ON CONFLICT DO NOTHING;
      UPDATE automation_rules SET run_count = run_count + 1, last_run_at = now() WHERE tenant_id = p_tenant AND id = r.id;
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING 'run_automations: la regla % falló: %', r.id, SQLERRM;
    END;
  END LOOP;
END
$$;

-- emit_event ahora, además de preparar los avisos, ejecuta las reglas (antes de la salida temprana «sin conexiones»).
CREATE OR REPLACE FUNCTION emit_event(p_tenant uuid, p_type text, p_data jsonb) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
  v_event uuid := gen_random_uuid();
  v_payload jsonb;
BEGIN
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
