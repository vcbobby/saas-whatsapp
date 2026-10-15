-- Paso 16A: avisos (webhooks) firmados hacia otros sistemas del negocio.
-- Diseño:
--  * Los eventos nacen en la base de datos (disparadores): cualquier camino que cree o cambie un pedido, una cita o una
--    conversación genera el aviso EN LA MISMA TRANSACCIÓN (si se deshace el cambio, el aviso también). Nadie puede saltárselo.
--  * Cada aviso queda como una entrega por cada conexión suscrita. El worker las envía firmadas y con reintentos.
--  * La cola entre negocios (webhook_queue) solo guarda ids; la app no la toca directamente (igual que kb_queue).

-- ------------------------------------------------------------------ conexiones
CREATE TABLE webhook_endpoints (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  url text NOT NULL CHECK (char_length(url) BETWEEN 10 AND 2000),
  description text CHECK (char_length(description) <= 120),
  events text[] NOT NULL CHECK (
    cardinality(events) BETWEEN 1 AND 10
    AND events <@ ARRAY['order.created','order.status_changed','appointment.created','appointment.status_changed','appointment.rescheduled','conversation.handoff']::text[]
  ),
  -- Secreto de firma, cifrado (AES-GCM atado al negocio y a la conexión). Solo se muestra una vez, al crearlo o rotarlo.
  secret_enc text NOT NULL,
  key_version integer NOT NULL,
  active boolean NOT NULL DEFAULT true,
  -- Entregas seguidas que se rindieron sin éxito; al llegar a 10 la conexión se desactiva sola.
  consecutive_failures integer NOT NULL DEFAULT 0 CHECK (consecutive_failures >= 0),
  disabled_reason text CHECK (char_length(disabled_reason) <= 200),
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id)
);
CREATE INDEX webhook_endpoints_negocio_idx ON webhook_endpoints (tenant_id, active);
ALTER TABLE webhook_endpoints ENABLE ROW LEVEL SECURITY;
ALTER TABLE webhook_endpoints FORCE ROW LEVEL SECURITY;
CREATE POLICY webhook_endpoints_aislamiento ON webhook_endpoints
  USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());

-- Tope por negocio: 10 conexiones (el candado evita que dos altas simultáneas lo pasen).
CREATE FUNCTION webhook_endpoints_limite() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('wh:' || NEW.tenant_id::text));
  IF (SELECT count(*) FROM webhook_endpoints WHERE tenant_id = NEW.tenant_id) >= 10 THEN
    RAISE EXCEPTION 'Se alcanzó el máximo de 10 conexiones' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER webhook_endpoints_tope BEFORE INSERT ON webhook_endpoints
  FOR EACH ROW EXECUTE FUNCTION webhook_endpoints_limite();

-- ------------------------------------------------------------------ entregas (registro visible para el negocio)
CREATE TABLE webhook_deliveries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  endpoint_id uuid NOT NULL,
  event_id uuid NOT NULL,
  event_type text NOT NULL CHECK (char_length(event_type) <= 60),
  payload jsonb NOT NULL CHECK (pg_column_size(payload) <= 32768),
  status text NOT NULL DEFAULT 'pendiente' CHECK (status IN ('pendiente', 'entregado', 'fallido')),
  attempts integer NOT NULL DEFAULT 0,
  last_status integer,
  last_error text CHECK (char_length(last_error) <= 300),
  created_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  UNIQUE (tenant_id, endpoint_id, event_id),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, endpoint_id) REFERENCES webhook_endpoints (tenant_id, id) ON DELETE CASCADE,
  CHECK ((status = 'pendiente') = (finished_at IS NULL))
);
CREATE INDEX webhook_deliveries_lista_idx ON webhook_deliveries (tenant_id, created_at DESC);
CREATE INDEX webhook_deliveries_conexion_idx ON webhook_deliveries (tenant_id, endpoint_id, created_at DESC);
ALTER TABLE webhook_deliveries ENABLE ROW LEVEL SECURITY;
ALTER TABLE webhook_deliveries FORCE ROW LEVEL SECURITY;
CREATE POLICY webhook_deliveries_aislamiento ON webhook_deliveries
  USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());

-- ------------------------------------------------------------------ cola entre negocios (solo ids)
CREATE TABLE webhook_queue (
  delivery_id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  locked_until timestamptz,
  FOREIGN KEY (tenant_id, delivery_id) REFERENCES webhook_deliveries (tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX webhook_queue_pendientes_idx ON webhook_queue (next_attempt_at);
REVOKE ALL ON webhook_queue FROM PUBLIC, app_user;

CREATE FUNCTION webhook_enqueue_trg() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  INSERT INTO webhook_queue (delivery_id, tenant_id, next_attempt_at) VALUES (NEW.id, NEW.tenant_id, now())
  ON CONFLICT (delivery_id) DO UPDATE SET next_attempt_at = now(), locked_until = NULL;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION webhook_enqueue_trg() FROM PUBLIC;
-- Al crear una entrega, o al volver a pendiente (reintento manual), entra a la cola.
CREATE TRIGGER webhook_deliveries_encolar AFTER INSERT OR UPDATE OF status ON webhook_deliveries
  FOR EACH ROW WHEN (NEW.status = 'pendiente') EXECUTE FUNCTION webhook_enqueue_trg();

-- Toma hasta p_limit entregas vencidas y las bloquea p_lock_seconds (si el worker muere, otro las retoma). Devuelve solo ids.
CREATE FUNCTION webhook_claim(p_limit integer, p_lock_seconds integer)
RETURNS TABLE (out_tenant_id uuid, out_delivery_id uuid)
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  UPDATE webhook_queue q SET locked_until = now() + make_interval(secs => LEAST(GREATEST(COALESCE(p_lock_seconds, 60), 10), 600))
   WHERE q.delivery_id IN (
     SELECT k.delivery_id FROM webhook_queue k
      WHERE k.next_attempt_at <= now() AND (k.locked_until IS NULL OR k.locked_until < now())
      ORDER BY k.next_attempt_at
      FOR UPDATE SKIP LOCKED
      LIMIT LEAST(GREATEST(COALESCE(p_limit, 1), 1), 50))
  RETURNING q.tenant_id, q.delivery_id;
$$;
REVOKE ALL ON FUNCTION webhook_claim(integer, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION webhook_claim(integer, integer) TO app_user;

-- Reprograma una entrega (p_next_at) o la saca de la cola (NULL). Solo del negocio actual.
CREATE FUNCTION webhook_queue_set(p_delivery uuid, p_next_at timestamptz) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  WITH del AS (DELETE FROM webhook_queue WHERE delivery_id = p_delivery AND tenant_id = app_current_tenant() AND p_next_at IS NULL RETURNING 1)
  UPDATE webhook_queue SET next_attempt_at = p_next_at, locked_until = NULL
   WHERE delivery_id = p_delivery AND tenant_id = app_current_tenant() AND p_next_at IS NOT NULL;
$$;
REVOKE ALL ON FUNCTION webhook_queue_set(uuid, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION webhook_queue_set(uuid, timestamptz) TO app_user;

-- ------------------------------------------------------------------ emitir un evento
-- Crea una entrega por cada conexión activa suscrita. Nunca hace fallar la operación del negocio: ante cualquier problema
-- deja un aviso en el registro del servidor y sigue. Tope de seguridad: 5000 entregas pendientes por negocio.
CREATE FUNCTION emit_event(p_tenant uuid, p_type text, p_data jsonb) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
  v_event uuid := gen_random_uuid();
  v_payload jsonb;
BEGIN
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

-- ------------------------------------------------------------------ disparadores de eventos
CREATE FUNCTION order_event_data(p_tenant uuid, p_order uuid) RETURNS jsonb
LANGUAGE sql STABLE AS $$
  SELECT jsonb_build_object('order', jsonb_build_object(
    'id', o.id, 'number', o.number, 'status', o.status, 'source', o.source, 'currency', o.currency, 'total_minor', o.total_minor,
    'customer_name', o.customer_name, 'customer_phone', o.customer_phone, 'delivery_note', o.delivery_note, 'created_at', o.created_at,
    'items', COALESCE((SELECT jsonb_agg(jsonb_build_object('name', i.name, 'quantity', i.quantity, 'unit_price_minor', i.unit_price_minor) ORDER BY i.position)
                         FROM order_items i WHERE i.tenant_id = o.tenant_id AND i.order_id = o.id), '[]'::jsonb)))
    FROM orders o WHERE o.tenant_id = p_tenant AND o.id = p_order;
$$;

CREATE FUNCTION trg_order_created() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM emit_event(NEW.tenant_id, 'order.created', COALESCE(order_event_data(NEW.tenant_id, NEW.id), '{}'::jsonb));
  RETURN NULL;
END
$$;
-- Diferido: se dispara al final de la transacción, cuando ya existen las líneas del pedido.
CREATE CONSTRAINT TRIGGER orders_evento_creado AFTER INSERT ON orders
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION trg_order_created();

CREATE FUNCTION trg_order_status() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM emit_event(NEW.tenant_id, 'order.status_changed', COALESCE(order_event_data(NEW.tenant_id, NEW.id), '{}'::jsonb) || jsonb_build_object('previous_status', OLD.status));
  RETURN NULL;
END
$$;
CREATE TRIGGER orders_evento_estado AFTER UPDATE OF status ON orders
  FOR EACH ROW WHEN (OLD.status IS DISTINCT FROM NEW.status) EXECUTE FUNCTION trg_order_status();

CREATE FUNCTION appointment_event_data(p_tenant uuid, p_appt uuid) RETURNS jsonb
LANGUAGE sql STABLE AS $$
  SELECT jsonb_build_object('appointment', jsonb_build_object(
    'id', a.id, 'status', a.status, 'source', a.source, 'service', s.name, 'customer_name', a.customer_name,
    'customer_phone', a.customer_phone, 'starts_at', a.starts_at, 'ends_at', a.ends_at))
    FROM appointments a JOIN agenda_services s ON s.tenant_id = a.tenant_id AND s.id = a.service_id
   WHERE a.tenant_id = p_tenant AND a.id = p_appt;
$$;

CREATE FUNCTION trg_appointment_created() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM emit_event(NEW.tenant_id, 'appointment.created', COALESCE(appointment_event_data(NEW.tenant_id, NEW.id), '{}'::jsonb));
  RETURN NULL;
END
$$;
CREATE TRIGGER appointments_evento_creada AFTER INSERT ON appointments FOR EACH ROW EXECUTE FUNCTION trg_appointment_created();

CREATE FUNCTION trg_appointment_status() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM emit_event(NEW.tenant_id, 'appointment.status_changed', COALESCE(appointment_event_data(NEW.tenant_id, NEW.id), '{}'::jsonb) || jsonb_build_object('previous_status', OLD.status));
  RETURN NULL;
END
$$;
CREATE TRIGGER appointments_evento_estado AFTER UPDATE OF status ON appointments
  FOR EACH ROW WHEN (OLD.status IS DISTINCT FROM NEW.status) EXECUTE FUNCTION trg_appointment_status();

CREATE FUNCTION trg_appointment_moved() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM emit_event(NEW.tenant_id, 'appointment.rescheduled', COALESCE(appointment_event_data(NEW.tenant_id, NEW.id), '{}'::jsonb) || jsonb_build_object('previous_starts_at', OLD.starts_at));
  RETURN NULL;
END
$$;
CREATE TRIGGER appointments_evento_movida AFTER UPDATE OF starts_at ON appointments
  FOR EACH ROW WHEN (OLD.starts_at IS DISTINCT FROM NEW.starts_at) EXECUTE FUNCTION trg_appointment_moved();

CREATE FUNCTION trg_conversation_handoff() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM emit_event(NEW.tenant_id, 'conversation.handoff', jsonb_build_object('conversation', jsonb_build_object(
    'id', NEW.id, 'reason', NEW.handoff_reason,
    'contact_name', (SELECT c.display_name FROM contacts c WHERE c.tenant_id = NEW.tenant_id AND c.id = NEW.contact_id),
    'contact_phone', (SELECT '+' || c.wa_id FROM contacts c WHERE c.tenant_id = NEW.tenant_id AND c.id = NEW.contact_id))));
  RETURN NULL;
END
$$;
CREATE TRIGGER conversations_evento_persona AFTER UPDATE OF status ON conversations
  FOR EACH ROW WHEN (OLD.status = 'bot' AND NEW.status = 'human' AND NEW.handoff_reason IS DISTINCT FROM 'tomada_por_persona') EXECUTE FUNCTION trg_conversation_handoff();
