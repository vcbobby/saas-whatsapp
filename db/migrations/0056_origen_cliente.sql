-- Paso 49: de dónde llegó cada cliente.
-- Meta manda un «referral» en el PRIMER mensaje de quien te escribe desde un anuncio de «Click to WhatsApp» o desde una publicación.
-- Se guarda el primer origen de cada contacto (no se pisa si luego llega por otro lado).
ALTER TABLE contacts
  ADD COLUMN origin_type text CHECK (origin_type IN ('anuncio', 'publicacion')),
  ADD COLUMN origin_source_id text CHECK (origin_source_id IS NULL OR char_length(origin_source_id) BETWEEN 1 AND 100),
  ADD COLUMN origin_url text CHECK (origin_url IS NULL OR (char_length(origin_url) <= 500 AND origin_url ~ '^https://')),
  ADD COLUMN origin_headline text CHECK (origin_headline IS NULL OR char_length(origin_headline) <= 200),
  ADD COLUMN origin_at timestamptz,
  ADD CONSTRAINT contacts_origen_coherente CHECK ((origin_type IS NULL) = (origin_at IS NULL));
CREATE INDEX contacts_origen_idx ON contacts (tenant_id, created_at) WHERE origin_type IS NOT NULL;
