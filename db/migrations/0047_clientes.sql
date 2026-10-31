-- Paso 37: ficha de cliente. Etiquetas libres y una nota interna por contacto,
-- más índices para armar el historial (chats, pedidos y citas) sin recorrer tablas enteras.
-- (La baja de avisos ya existe: contacts.notifications_off; el tipo de contacto: contacts.label.)

ALTER TABLE contacts
  ADD COLUMN tags text[] NOT NULL DEFAULT '{}' CHECK (cardinality(tags) <= 10),
  ADD COLUMN notes text CHECK (char_length(notes) <= 2000),
  ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now(),
  -- Permiso para escribirle promociones: cuándo y cómo lo dio. Las difusiones solo irán a quien lo tenga.
  ADD COLUMN promo_consent_at timestamptz,
  ADD COLUMN promo_consent_source text CHECK (promo_consent_source IN ('whatsapp', 'tienda', 'formulario', 'importado', 'otro')),
  ADD CONSTRAINT contacts_consentimiento_completo CHECK ((promo_consent_at IS NULL) = (promo_consent_source IS NULL));

CREATE INDEX contacts_tags_idx ON contacts USING gin (tags);
CREATE INDEX contacts_recientes_idx ON contacts (tenant_id, created_at DESC);
CREATE INDEX conversations_contacto_idx ON conversations (tenant_id, contact_id);
CREATE INDEX orders_contacto_idx ON orders (tenant_id, contact_id) WHERE contact_id IS NOT NULL;
CREATE INDEX appointments_contacto_idx ON appointments (tenant_id, contact_id) WHERE contact_id IS NOT NULL;
