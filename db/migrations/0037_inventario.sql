-- Paso 27: inventario. Cada cambio del stock de un producto queda anotado (quién, cuándo, cuánto, por qué) y cada producto
-- puede tener su propio «avisar cuando queden X». El registro lo escribe la BASE DE DATOS con un disparador, así que ninguna
-- ruta (pedido, edición, ajuste) puede cambiar el stock sin dejar rastro.

ALTER TABLE catalog_products ADD COLUMN min_stock integer CHECK (min_stock BETWEEN 0 AND 1000000);

CREATE TABLE stock_movements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  product_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('inicial', 'entrada', 'salida', 'merma', 'ajuste', 'pedido', 'devolucion', 'edicion')),
  delta integer NOT NULL CHECK (delta <> 0),
  stock_after integer NOT NULL CHECK (stock_after BETWEEN 0 AND 1000000),
  note text CHECK (char_length(note) <= 200),
  order_id uuid,
  created_by uuid,
  -- clock_timestamp (no now): dos ajustes a la vez se ordenan por el momento real en que se anotaron, no por cuándo empezó cada transacción.
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  -- El signo siempre coincide con el tipo: una entrada suma, una salida resta.
  CHECK ((kind IN ('entrada', 'devolucion', 'inicial') AND delta > 0) OR (kind IN ('salida', 'merma', 'pedido') AND delta < 0) OR kind IN ('ajuste', 'edicion')),
  FOREIGN KEY (tenant_id, product_id) REFERENCES catalog_products (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, order_id) REFERENCES orders (tenant_id, id) ON DELETE SET NULL (order_id)
);
CREATE INDEX stock_movements_producto_idx ON stock_movements (tenant_id, product_id, created_at DESC, id);
CREATE INDEX stock_movements_recientes_idx ON stock_movements (tenant_id, created_at DESC, id);
ALTER TABLE stock_movements ENABLE ROW LEVEL SECURITY;
ALTER TABLE stock_movements FORCE ROW LEVEL SECURITY;
CREATE POLICY stock_movements_aislamiento ON stock_movements
  USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());
-- Solo se agregan registros: la aplicación no puede editarlos ni borrarlos.
REVOKE UPDATE, DELETE ON stock_movements FROM app_user;

-- La aplicación dice POR QUÉ cambia el stock con valores de la transacción (app.stock_kind, app.stock_note, app.stock_order, app.stock_user);
-- si no dice nada, el cambio se anota como «edicion». Un tipo que no cuadra con el signo también se anota como «ajuste».
CREATE FUNCTION catalog_stock_log() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  d integer;
  k text;
  n text;
  o uuid;
  u uuid;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.stock IS NULL OR NEW.stock = 0 THEN RETURN NULL; END IF;
    d := NEW.stock;
    k := 'inicial';
  ELSE
    IF NEW.stock IS NULL OR OLD.stock IS NOT DISTINCT FROM NEW.stock THEN RETURN NULL; END IF;
    IF OLD.stock IS NULL THEN
      d := NEW.stock;
      k := 'inicial';
    ELSE
      d := NEW.stock - OLD.stock;
      k := COALESCE(NULLIF(current_setting('app.stock_kind', true), ''), 'edicion');
      IF k NOT IN ('entrada', 'salida', 'merma', 'ajuste', 'pedido', 'devolucion', 'edicion') THEN k := 'edicion'; END IF;
      IF (k IN ('entrada', 'devolucion') AND d < 0) OR (k IN ('salida', 'merma', 'pedido') AND d > 0) THEN k := 'ajuste'; END IF;
    END IF;
    IF d = 0 THEN RETURN NULL; END IF;
  END IF;
  n := left(NULLIF(current_setting('app.stock_note', true), ''), 200);
  BEGIN o := NULLIF(current_setting('app.stock_order', true), '')::uuid; EXCEPTION WHEN others THEN o := NULL; END;
  BEGIN u := NULLIF(current_setting('app.stock_user', true), '')::uuid; EXCEPTION WHEN others THEN u := NULL; END;
  INSERT INTO stock_movements (tenant_id, product_id, kind, delta, stock_after, note, order_id, created_by)
  VALUES (NEW.tenant_id, NEW.id, k, d, NEW.stock, n, o, u);
  RETURN NULL;
END
$$;
CREATE TRIGGER catalog_stock_log AFTER INSERT OR UPDATE OF stock ON catalog_products
  FOR EACH ROW EXECUTE FUNCTION catalog_stock_log();

-- El stock que los productos ya tenían queda como su primer movimiento (así el historial siempre suma el stock actual).
ALTER TABLE catalog_products NO FORCE ROW LEVEL SECURITY;
ALTER TABLE stock_movements NO FORCE ROW LEVEL SECURITY;
INSERT INTO stock_movements (tenant_id, product_id, kind, delta, stock_after, note)
SELECT tenant_id, id, 'inicial', stock, stock, 'Stock que ya tenías al activar el inventario' FROM catalog_products WHERE stock > 0;
ALTER TABLE catalog_products FORCE ROW LEVEL SECURITY;
ALTER TABLE stock_movements FORCE ROW LEVEL SECURITY;
