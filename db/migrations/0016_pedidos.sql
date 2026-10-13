-- Paso 14B: pedidos. Cada pedido guarda una COPIA del nombre y del precio de cada producto (cambiar el catálogo después no altera pedidos viejos).
-- El total se calcula en el servidor y la base de datos verifica que coincida con la suma de las líneas.

-- Número de pedido por negocio (#1, #2, …). Se incrementa dentro de la misma transacción que crea el pedido: sin huecos ni repetidos.
CREATE TABLE order_counters (
  tenant_id uuid PRIMARY KEY REFERENCES tenants (id) ON DELETE CASCADE,
  last_number integer NOT NULL DEFAULT 0 CHECK (last_number >= 0)
);
ALTER TABLE order_counters ENABLE ROW LEVEL SECURITY;
ALTER TABLE order_counters FORCE ROW LEVEL SECURITY;
CREATE POLICY order_counters_aislamiento ON order_counters
  USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());

CREATE TABLE orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  number integer NOT NULL CHECK (number > 0),
  contact_id uuid,
  conversation_id uuid,
  customer_name text NOT NULL CHECK (char_length(customer_name) BETWEEN 1 AND 120),
  customer_phone text CHECK (char_length(customer_phone) <= 32),
  notes text CHECK (char_length(notes) <= 1000),
  delivery_note text CHECK (char_length(delivery_note) <= 300),
  status text NOT NULL DEFAULT 'pendiente' CHECK (status IN ('pendiente', 'confirmado', 'entregado', 'cancelado')),
  source text NOT NULL CHECK (source IN ('manual', 'agente')),
  currency text NOT NULL CHECK (currency IN ('USD', 'VES', 'EUR', 'COP', 'MXN', 'PEN')),
  total_minor bigint NOT NULL CHECK (total_minor BETWEEN 0 AND 1000000000000),
  request_message_id uuid,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  confirmed_at timestamptz,
  delivered_at timestamptz,
  cancelled_at timestamptz,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, number),
  FOREIGN KEY (tenant_id, contact_id) REFERENCES contacts (tenant_id, id) ON DELETE SET NULL (contact_id),
  FOREIGN KEY (tenant_id, conversation_id) REFERENCES conversations (tenant_id, id) ON DELETE SET NULL (conversation_id),
  FOREIGN KEY (tenant_id, request_message_id) REFERENCES messages (tenant_id, id) ON DELETE SET NULL (request_message_id),
  CHECK (request_message_id IS NULL OR source = 'agente'),
  CHECK ((status = 'cancelado') = (cancelled_at IS NOT NULL)),
  CHECK ((status = 'entregado') = (delivered_at IS NOT NULL)),
  CHECK (status = 'pendiente' OR status = 'cancelado' OR confirmed_at IS NOT NULL)
);
CREATE UNIQUE INDEX orders_mensaje_unico_idx ON orders (tenant_id, request_message_id) WHERE request_message_id IS NOT NULL;
CREATE INDEX orders_lista_idx ON orders (tenant_id, status, number DESC);
ALTER TABLE orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE orders FORCE ROW LEVEL SECURITY;
CREATE POLICY orders_aislamiento ON orders
  USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());

CREATE TABLE order_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  order_id uuid NOT NULL,
  product_id uuid NOT NULL,
  position smallint NOT NULL CHECK (position BETWEEN 1 AND 50),
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 120),
  unit text CHECK (char_length(unit) <= 40),
  unit_price_minor bigint NOT NULL CHECK (unit_price_minor BETWEEN 0 AND 10000000000),
  quantity integer NOT NULL CHECK (quantity BETWEEN 1 AND 9999),
  line_total_minor bigint NOT NULL,
  -- true = al confirmar se descontó stock de este producto (al cancelar se devuelve exactamente eso).
  stock_taken boolean NOT NULL DEFAULT false,
  UNIQUE (tenant_id, order_id, product_id),
  CHECK (line_total_minor = unit_price_minor * quantity),
  FOREIGN KEY (tenant_id, order_id) REFERENCES orders (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, product_id) REFERENCES catalog_products (tenant_id, id)
);
CREATE INDEX order_items_pedido_idx ON order_items (tenant_id, order_id, position);
ALTER TABLE order_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE order_items FORCE ROW LEVEL SECURITY;
CREATE POLICY order_items_aislamiento ON order_items
  USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());

-- Al terminar la transacción: todo pedido tiene al menos una línea y su total es la suma de las líneas.
CREATE FUNCTION orders_check_total() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE s bigint; n integer;
BEGIN
  SELECT COALESCE(SUM(line_total_minor), 0), COUNT(*) INTO s, n FROM order_items WHERE tenant_id = NEW.tenant_id AND order_id = NEW.id;
  IF n = 0 OR s <> NEW.total_minor THEN
    RAISE EXCEPTION 'el total del pedido no coincide con sus productos' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END
$$;
CREATE CONSTRAINT TRIGGER orders_total_check AFTER INSERT ON orders
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION orders_check_total();

-- Lo que define un pedido no cambia después de creado: solo su estado, sus fechas y las notas de seguimiento.
CREATE FUNCTION orders_immutable() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.number IS DISTINCT FROM OLD.number OR NEW.total_minor IS DISTINCT FROM OLD.total_minor OR NEW.currency IS DISTINCT FROM OLD.currency
     OR NEW.source IS DISTINCT FROM OLD.source OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id THEN
    RAISE EXCEPTION 'un pedido no puede cambiar su número, total, moneda ni origen' USING ERRCODE = '23514';
  END IF;
  -- Estados finales: un pedido entregado o cancelado ya no cambia de estado.
  IF OLD.status IN ('entregado', 'cancelado') AND NEW.status IS DISTINCT FROM OLD.status THEN
    RAISE EXCEPTION 'un pedido % no puede cambiar de estado', OLD.status USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER orders_immutable BEFORE UPDATE ON orders FOR EACH ROW EXECUTE FUNCTION orders_immutable();

CREATE FUNCTION order_items_immutable() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.order_id IS DISTINCT FROM OLD.order_id OR NEW.product_id IS DISTINCT FROM OLD.product_id OR NEW.name IS DISTINCT FROM OLD.name
     OR NEW.unit IS DISTINCT FROM OLD.unit OR NEW.unit_price_minor IS DISTINCT FROM OLD.unit_price_minor OR NEW.quantity IS DISTINCT FROM OLD.quantity
     OR NEW.line_total_minor IS DISTINCT FROM OLD.line_total_minor OR NEW.position IS DISTINCT FROM OLD.position THEN
    RAISE EXCEPTION 'las líneas de un pedido no se modifican' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER order_items_immutable BEFORE UPDATE ON order_items FOR EACH ROW EXECUTE FUNCTION order_items_immutable();
