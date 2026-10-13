-- Paso 14A: catálogo de productos (precios en la unidad menor, p. ej. centavos; stock opcional).
-- Los productos no se borran: se desactivan (los pedidos futuros guardarán una copia del nombre y del precio).

CREATE TABLE catalog_settings (
  tenant_id uuid PRIMARY KEY REFERENCES tenants (id) ON DELETE CASCADE,
  currency text NOT NULL DEFAULT 'USD' CHECK (currency IN ('USD', 'VES', 'EUR', 'COP', 'MXN', 'PEN')),
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid
);
ALTER TABLE catalog_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE catalog_settings FORCE ROW LEVEL SECURITY;
CREATE POLICY catalog_settings_aislamiento ON catalog_settings
  USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());

CREATE TABLE catalog_products (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 120),
  description text CHECK (char_length(description) <= 500),
  unit text CHECK (char_length(unit) <= 40),
  -- Entero en la unidad menor (2 decimales): 1050 = 10,50. Nunca decimales flotantes para dinero.
  price_minor bigint NOT NULL CHECK (price_minor BETWEEN 0 AND 10000000000),
  -- NULL = no se controla el inventario de este producto.
  stock integer CHECK (stock BETWEEN 0 AND 1000000),
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id)
);
CREATE UNIQUE INDEX catalog_products_nombre_idx ON catalog_products (tenant_id, lower(name)) WHERE active;
CREATE INDEX catalog_products_lista_idx ON catalog_products (tenant_id, active, lower(name));
ALTER TABLE catalog_products ENABLE ROW LEVEL SECURITY;
ALTER TABLE catalog_products FORCE ROW LEVEL SECURITY;
CREATE POLICY catalog_products_aislamiento ON catalog_products
  USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());
