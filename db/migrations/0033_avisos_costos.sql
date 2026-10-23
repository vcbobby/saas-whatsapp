-- Paso 21: avisos en «Hoy» para los nuevos motivos por los que el asistente se detiene.
CREATE OR REPLACE FUNCTION conversations_work_sync() RETURNS trigger
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
      WHEN 'limite_plan' THEN 'Se llegó al tope mensual de respuestas del plan; el asistente se detuvo hasta el mes siguiente.'
      WHEN 'limite_contacto' THEN 'Este cliente escribió muchísimo en poco tiempo; el asistente se detuvo.'
      WHEN 'intentos_de_manipulacion' THEN 'El cliente intentó manipular al asistente; revisa el chat con cuidado.'
      WHEN 'envio_rechazado' THEN 'WhatsApp rechazó la respuesta del asistente.'
      WHEN 'envio_incierto' THEN 'No se pudo confirmar si la respuesta llegó al cliente.'
      WHEN 'agente_fallo' THEN 'El asistente tuvo un fallo y no pudo responder.'
      WHEN 'fuga_de_instrucciones' THEN 'El asistente iba a revelar sus instrucciones; se detuvo.'
      WHEN 'salida_bloqueada' THEN 'Se bloqueó una respuesta del asistente por seguridad.'
      WHEN 'respuesta_vacia' THEN 'El asistente no pudo generar una respuesta.'
      WHEN 'limite_tokens' THEN 'El negocio llegó a su tope de consumo de IA; el asistente se detuvo hasta que se renueve.'
      WHEN 'ia_pausada' THEN 'La IA está en pausa temporal en toda la plataforma; una persona debe atender esta conversación.'
      WHEN 'posible_bucle' THEN 'Esta conversación recibió demasiados mensajes en pocos minutos (¿otro bot?); el asistente se detuvo.'
      WHEN 'reintentos_ia' THEN 'El asistente no logró responder tras varios intentos; una persona debe atender.'
      WHEN 'pico_de_uso' THEN 'El asistente respondió demasiado en la última hora; se detuvo por seguridad.'
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
