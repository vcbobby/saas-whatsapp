-- 0004: WhatsApp (webhook entrante).

-- Estado de entrega de los mensajes que enviamos (Meta lo informa por webhook).
ALTER TABLE messages
  ADD COLUMN delivery_status text CHECK (delivery_status IN ('sent', 'delivered', 'read', 'failed')),
  ADD COLUMN status_at timestamptz;

-- Una sola conversación abierta por contacto. Evita duplicados cuando llegan
-- dos mensajes del mismo cliente al mismo tiempo.
CREATE UNIQUE INDEX conversations_una_abierta_idx
  ON conversations (tenant_id, contact_id) WHERE status <> 'closed';

-- Por ahora, un número de WhatsApp por negocio (luego lo fijará el plan).
CREATE UNIQUE INDEX tenant_integrations_uno_por_negocio_idx
  ON tenant_integrations (tenant_id, provider);
