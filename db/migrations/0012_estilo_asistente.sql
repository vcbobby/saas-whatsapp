-- Paso 12: tipo de negocio y estilo del asistente.
-- Son opciones cerradas (no texto libre): así nunca pueden usarse para colar instrucciones en el prompt.
ALTER TABLE tenant_agents
  ADD COLUMN business_type text NOT NULL DEFAULT 'atencion'
    CHECK (business_type IN ('citas', 'catalogo', 'atencion')),
  ADD COLUMN country text NOT NULL DEFAULT 'VE'
    CHECK (country IN ('VE', 'CO', 'MX', 'AR', 'CL', 'PE', 'EC', 'ES', 'US', 'XX')),
  ADD COLUMN tone text NOT NULL DEFAULT 'cercano'
    CHECK (tone IN ('cercano', 'formal')),
  ADD COLUMN emoji_level text NOT NULL DEFAULT 'pocos'
    CHECK (emoji_level IN ('ninguno', 'pocos', 'varios')),
  ADD COLUMN reply_length text NOT NULL DEFAULT 'corta'
    CHECK (reply_length IN ('corta', 'media'));
