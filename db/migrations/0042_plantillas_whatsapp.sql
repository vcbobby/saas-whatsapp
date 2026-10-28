-- Paso 31: plantillas de WhatsApp. Fuera de las 24 horas desde el último mensaje del cliente, WhatsApp solo deja escribir con una
-- plantilla aprobada por Meta. Aquí se guarda la copia local de las plantillas de cada negocio (la verdad está en Meta; «Actualizar» las sincroniza).
CREATE TABLE whatsapp_templates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  name text NOT NULL CHECK (name ~ '^[a-z0-9_]{1,100}$'),
  language text NOT NULL CHECK (language ~ '^[a-z]{2,3}(_[A-Z]{2})?$'),
  category text NOT NULL CHECK (category IN ('UTILITY', 'MARKETING', 'AUTHENTICATION')),
  body text NOT NULL CHECK (char_length(body) BETWEEN 1 AND 1024),
  examples jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(examples) = 'array' AND jsonb_array_length(examples) <= 10),
  -- ¿La app puede enviarla? Solo plantillas de texto (cuerpo, pie y botones fijos), sin encabezado ni variables en botones.
  sendable boolean NOT NULL DEFAULT true,
  status text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'APPROVED', 'REJECTED', 'PAUSED', 'DISABLED', 'IN_APPEAL', 'OTHER')),
  reason text CHECK (char_length(reason) <= 300),
  meta_id text CHECK (char_length(meta_id) <= 60),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, name, language)
);
CREATE INDEX whatsapp_templates_negocio_idx ON whatsapp_templates (tenant_id, status, name);
ALTER TABLE whatsapp_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE whatsapp_templates FORCE ROW LEVEL SECURITY;
CREATE POLICY whatsapp_templates_aislamiento ON whatsapp_templates
  USING (tenant_id = app_current_tenant())
  WITH CHECK (tenant_id = app_current_tenant());
GRANT SELECT, INSERT, UPDATE, DELETE ON whatsapp_templates TO app_user;
