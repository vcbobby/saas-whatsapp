-- Paso 46: avisos cuando se recibe un pago o se rechaza un comprobante.
-- Dos eventos nuevos, iguales a los demás (webhooks, apps conectadas y avisos al cliente por WhatsApp):
--   order.paid              el pedido pasa a «pagado»
--   order.payment_rejected  se rechaza un comprobante («por verificar» → «sin pago»): sirve para pedirle otro al cliente
-- Reabrir un pago («pagado» → «sin pago») NO avisa a nadie: es una corrección interna.

ALTER TABLE webhook_endpoints DROP CONSTRAINT webhook_endpoints_events_check;
ALTER TABLE webhook_endpoints ADD CONSTRAINT webhook_endpoints_events_check CHECK (
  cardinality(events) BETWEEN 1 AND 12
  AND events <@ ARRAY['order.created','order.status_changed','appointment.created','appointment.status_changed','appointment.rescheduled','conversation.handoff','contact.created','stock.low','order.paid','order.payment_rejected']::text[]);

ALTER TABLE automation_rules DROP CONSTRAINT automation_rules_trigger_event_check;
ALTER TABLE automation_rules DROP CONSTRAINT automation_rules_mensaje_check;
ALTER TABLE automation_rules
  ADD CONSTRAINT automation_rules_trigger_event_check CHECK (trigger_event IN
    ('order.created','order.status_changed','appointment.created','appointment.status_changed','appointment.rescheduled','conversation.handoff','appointment.upcoming','order.pending_stale','contact.created','stock.low','conversation.unanswered','order.paid','order.payment_rejected')),
  ADD CONSTRAINT automation_rules_mensaje_check CHECK (
    (action_type = 'tarea' AND message_template IS NULL AND target_endpoint_id IS NULL)
    OR (action_type = 'mensaje' AND message_template IS NOT NULL AND target_endpoint_id IS NULL
        AND trigger_event IN ('order.created','order.status_changed','appointment.created','appointment.status_changed','appointment.rescheduled','appointment.upcoming','order.pending_stale','order.paid','order.payment_rejected'))
    OR (action_type = 'app' AND message_template IS NOT NULL));

CREATE FUNCTION trg_order_payment() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.payment_state = 'pagado' THEN
    PERFORM emit_event(NEW.tenant_id, 'order.paid', COALESCE(order_event_data(NEW.tenant_id, NEW.id), '{}'::jsonb)
      || jsonb_build_object('payment', jsonb_build_object('method', NEW.payment_method, 'paid_at', NEW.paid_at), 'previous_payment_state', OLD.payment_state));
  ELSIF OLD.payment_state = 'por_verificar' AND NEW.payment_state = 'sin_pago' THEN
    PERFORM emit_event(NEW.tenant_id, 'order.payment_rejected', COALESCE(order_event_data(NEW.tenant_id, NEW.id), '{}'::jsonb));
  END IF;
  RETURN NULL;
END
$$;
CREATE TRIGGER orders_evento_pago AFTER UPDATE OF payment_state ON orders
  FOR EACH ROW WHEN (OLD.payment_state IS DISTINCT FROM NEW.payment_state) EXECUTE FUNCTION trg_order_payment();
