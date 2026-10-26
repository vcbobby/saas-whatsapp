-- Paso 29: conexión de WhatsApp guiada. Se anota CÓMO se conectó cada número, a qué cuenta de WhatsApp Business (WABA) pertenece
-- (hace falta para plantillas y para la conexión con un clic) y cuándo vence el token (los temporales de Meta duran ~24 h).
ALTER TABLE tenant_integrations
  ADD COLUMN waba_id text CHECK (waba_id ~ '^\d{5,30}$'),
  ADD COLUMN connected_via text NOT NULL DEFAULT 'manual' CHECK (connected_via IN ('manual', 'embedded')),
  ADD COLUMN token_expires_at timestamptz;
