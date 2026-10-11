-- Paso 11A: Centro de trabajo. Convierte las conversaciones en cosas por hacer (tareas),
-- con un registro de qué pasó con cada una, y permite clasificar a los contactos.

-- ------------------------------------------------------------ etiqueta de contacto
-- "personal": el asistente NO responde a ese contacto (familia, amistades, proveedores…).
ALTER TABLE contacts
  ADD COLUMN label text NOT NULL DEFAULT 'sin_clasificar'
    CHECK (label IN ('sin_clasificar', 'cliente', 'prospecto', 'personal'));

-- Para la bandeja: conversaciones de un negocio, las más recientes primero.
CREATE INDEX conversations_recientes_idx ON conversations (tenant_id, last_message_at DESC NULLS LAST);

-- ---------------------------------------------------------------------- tareas
CREATE TABLE work_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  type text NOT NULL CHECK (type IN ('atencion_humana', 'cita', 'pedido', 'pago_por_verificar', 'seguimiento', 'tarea')),
  status text NOT NULL DEFAULT 'abierto' CHECK (status IN ('abierto', 'en_proceso', 'resuelto', 'descartado')),
  priority smallint NOT NULL DEFAULT 2 CHECK (priority BETWEEN 1 AND 3), -- 1 alta, 2 normal, 3 baja
  title text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 200),
  detail text CHECK (char_length(detail) <= 2000),
  due_at timestamptz,
  conversation_id uuid,
  contact_id uuid,
  source text NOT NULL CHECK (source IN ('agente', 'sistema', 'manual')),
  -- Para que los módulos futuros (citas, pedidos…) no creen la misma tarea dos veces.
  dedupe_key text CHECK (char_length(dedupe_key) <= 200),
  assigned_to uuid,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  resolved_by uuid,
  UNIQUE (tenant_id, id),
  -- Llaves compuestas: una tarea no puede apuntar a una conversación o contacto de OTRO negocio.
  FOREIGN KEY (tenant_id, conversation_id) REFERENCES conversations (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, contact_id) REFERENCES contacts (tenant_id, id) ON DELETE CASCADE,
  CHECK ((status IN ('resuelto', 'descartado')) = (resolved_at IS NOT NULL))
);

-- Una sola tarea "atención personal" abierta por conversación (los reintentos no la duplican).
CREATE UNIQUE INDEX work_items_atencion_unica_idx
  ON work_items (tenant_id, conversation_id)
  WHERE type = 'atencion_humana' AND status IN ('abierto', 'en_proceso');
CREATE UNIQUE INDEX work_items_dedupe_idx ON work_items (tenant_id, dedupe_key) WHERE dedupe_key IS NOT NULL;
-- La cola "Hoy": lo abierto, ordenado por urgencia.
CREATE INDEX work_items_cola_idx ON work_items (tenant_id, priority, due_at NULLS LAST, created_at)
  WHERE status IN ('abierto', 'en_proceso');
CREATE INDEX work_items_conv_idx ON work_items (tenant_id, conversation_id);

ALTER TABLE work_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE work_items FORCE ROW LEVEL SECURITY;
CREATE POLICY work_items_aislamiento ON work_items
  USING (tenant_id = app_current_tenant())
  WITH CHECK (tenant_id = app_current_tenant());

-- ---------------------------------------------------------- historial de cada tarea
CREATE TABLE work_item_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  work_item_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('creado', 'estado', 'asignado')),
  from_status text,
  to_status text,
  actor_user_id uuid, -- NULL = el sistema o el asistente
  -- clock_timestamp(): dos eventos de una misma transacción (estado + responsable) deben quedar en orden.
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (tenant_id, work_item_id) REFERENCES work_items (tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX work_item_events_item_idx ON work_item_events (tenant_id, work_item_id, created_at);
ALTER TABLE work_item_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE work_item_events FORCE ROW LEVEL SECURITY;
CREATE POLICY work_item_events_aislamiento ON work_item_events
  USING (tenant_id = app_current_tenant())
  WITH CHECK (tenant_id = app_current_tenant());
REVOKE UPDATE, DELETE ON work_item_events FROM app_user; -- solo se agregan registros

-- ------------------------------------------------------ triggers de las tareas
-- Quién hizo el cambio: la API fija app.actor (id de usuario) dentro de su transacción; vacío = sistema.
CREATE FUNCTION work_actor() RETURNS uuid
LANGUAGE sql STABLE
AS $$ SELECT NULLIF(current_setting('app.actor', true), '')::uuid $$;

CREATE FUNCTION work_items_before_update() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END
$$;
CREATE TRIGGER work_items_before_update BEFORE UPDATE ON work_items
  FOR EACH ROW EXECUTE FUNCTION work_items_before_update();

-- Cada creación y cada cambio de estado o de responsable queda en el historial, pase por donde pase.
CREATE FUNCTION work_items_log() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO work_item_events (tenant_id, work_item_id, kind, to_status, actor_user_id)
      VALUES (NEW.tenant_id, NEW.id, 'creado', NEW.status, COALESCE(work_actor(), NEW.created_by));
    RETURN NEW;
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    INSERT INTO work_item_events (tenant_id, work_item_id, kind, from_status, to_status, actor_user_id)
      VALUES (NEW.tenant_id, NEW.id, 'estado', OLD.status, NEW.status, work_actor());
  END IF;
  IF NEW.assigned_to IS DISTINCT FROM OLD.assigned_to THEN
    INSERT INTO work_item_events (tenant_id, work_item_id, kind, actor_user_id)
      VALUES (NEW.tenant_id, NEW.id, 'asignado', work_actor());
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER work_items_log_ins AFTER INSERT ON work_items FOR EACH ROW EXECUTE FUNCTION work_items_log();
CREATE TRIGGER work_items_log_upd AFTER UPDATE ON work_items FOR EACH ROW EXECUTE FUNCTION work_items_log();

-- ------------------------------------------- conversación ⇄ tarea de atención personal
-- Cuando el asistente pasa la conversación a una persona se crea la tarea (alta prioridad);
-- cuando la conversación vuelve al asistente o se cierra, esa tarea se resuelve sola.
-- Si alguien "toma" la conversación a propósito (handoff_reason = tomada_por_persona) no hace falta avisarle a sí mismo.
CREATE FUNCTION conversations_work_sync() RETURNS trigger
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
CREATE TRIGGER conversations_work_sync AFTER UPDATE OF status ON conversations
  FOR EACH ROW WHEN (OLD.status IS DISTINCT FROM NEW.status) EXECUTE FUNCTION conversations_work_sync();
