-- Paso 44: imágenes recibidas por WhatsApp y cobro de pedidos con comprobante.
-- La imagen NO se guarda aquí: se anota el id que da Meta y se descarga al momento de verla (Meta la conserva ~30 días).
ALTER TABLE messages
  ADD COLUMN media_id text CHECK (media_id IS NULL OR media_id ~ '^[A-Za-z0-9_-]{1,200}$'),
  ADD COLUMN media_mime text CHECK (media_mime IS NULL OR media_mime IN ('image/jpeg', 'image/png', 'image/webp'));

-- Estado de pago de cada pedido (independiente de si está confirmado o entregado).
ALTER TABLE orders
  ADD COLUMN payment_state text NOT NULL DEFAULT 'sin_pago' CHECK (payment_state IN ('sin_pago', 'por_verificar', 'pagado')),
  ADD COLUMN proof_message_id uuid,
  ADD COLUMN paid_at timestamptz,
  ADD COLUMN paid_by uuid,
  ADD COLUMN payment_method text CHECK (payment_method IS NULL OR char_length(payment_method) <= 40),
  ADD CONSTRAINT orders_pago_coherente CHECK ((payment_state = 'pagado') = (paid_at IS NOT NULL));
CREATE INDEX orders_pago_idx ON orders (tenant_id, payment_state) WHERE payment_state <> 'sin_pago';
