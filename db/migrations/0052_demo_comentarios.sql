-- Paso 42: datos de ejemplo (modo demo) y comentarios de los testers.

-- 1) Marca de «dato de ejemplo»: permite borrarlos todos sin tocar lo real.
ALTER TABLE contacts ADD COLUMN demo boolean NOT NULL DEFAULT false;
ALTER TABLE catalog_products ADD COLUMN demo boolean NOT NULL DEFAULT false;
ALTER TABLE agenda_services ADD COLUMN demo boolean NOT NULL DEFAULT false;
ALTER TABLE orders ADD COLUMN demo boolean NOT NULL DEFAULT false;
CREATE INDEX contacts_demo_idx ON contacts (tenant_id) WHERE demo;
CREATE INDEX catalog_products_demo_idx ON catalog_products (tenant_id) WHERE demo;
CREATE INDEX agenda_services_demo_idx ON agenda_services (tenant_id) WHERE demo;
CREATE INDEX orders_demo_idx ON orders (tenant_id) WHERE demo;

-- 2) Comentarios: lo que los testers escriben desde el botón «Enviar comentario».
CREATE TABLE feedback (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  user_id uuid,
  kind text NOT NULL CHECK (kind IN ('idea', 'problema', 'otro')),
  message text NOT NULL CHECK (char_length(message) BETWEEN 3 AND 2000),
  page text CHECK (page IS NULL OR char_length(page) <= 120),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX feedback_recientes_idx ON feedback (tenant_id, created_at DESC);
ALTER TABLE feedback ENABLE ROW LEVEL SECURITY;
ALTER TABLE feedback FORCE ROW LEVEL SECURITY;
CREATE POLICY feedback_aislamiento ON feedback
  USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());
-- El súper admin los lee entre negocios solo a través de admin_feedback() (mismo patrón que admin_usage).
CREATE POLICY feedback_admin_lectura ON feedback FOR SELECT
  USING (CURRENT_USER = 'app_owner' AND SESSION_USER <> 'app_owner' AND current_setting('app.admin_read', true) = '1');
-- La aplicación solo agrega comentarios: no los edita ni los borra.
REVOKE UPDATE, DELETE ON feedback FROM app_user;

CREATE FUNCTION admin_feedback(p_token_hash bytea, p_limit integer DEFAULT 200) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE v_out jsonb;
BEGIN
  PERFORM admin_require(p_token_hash);
  PERFORM set_config('app.admin_read', '1', true);
  SELECT COALESCE(jsonb_agg(x ORDER BY x.created_at DESC), '[]'::jsonb) INTO v_out FROM (
    SELECT f.id, f.kind, f.message, f.page, f.created_at, t.name AS business, u.email AS email
      FROM feedback f
      JOIN tenants t ON t.id = f.tenant_id
      LEFT JOIN users u ON u.id = f.user_id
     ORDER BY f.created_at DESC
     LIMIT LEAST(GREATEST(COALESCE(p_limit, 200), 1), 500)
  ) x;
  RETURN v_out;
END
$$;
REVOKE ALL ON FUNCTION admin_feedback(bytea, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION admin_feedback(bytea, integer) TO app_user;
