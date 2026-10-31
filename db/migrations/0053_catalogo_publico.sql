-- Paso 43: catálogo público (enlace + QR) para que los clientes vean los productos y pidan por WhatsApp.
-- Solo se publica lo que el negocio activa; el número al que se escribe lo pone el negocio (no se lee de Meta).
CREATE TABLE public_catalog (
  tenant_id uuid PRIMARY KEY REFERENCES tenants (id) ON DELETE CASCADE,
  enabled boolean NOT NULL DEFAULT false,
  phone text CHECK (phone IS NULL OR phone ~ '^[1-9][0-9]{7,14}$'),
  intro text CHECK (intro IS NULL OR char_length(intro) <= 300),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (NOT enabled OR phone IS NOT NULL)
);
ALTER TABLE public_catalog ENABLE ROW LEVEL SECURITY;
ALTER TABLE public_catalog FORCE ROW LEVEL SECURITY;
CREATE POLICY public_catalog_aislamiento ON public_catalog
  USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());
-- Lectura sin sesión SOLO a través de public_catalog_lookup() (la función activa la marca; la aplicación sola no puede).
CREATE POLICY public_catalog_busqueda ON public_catalog FOR SELECT
  USING (CURRENT_USER = 'app_owner' AND SESSION_USER <> 'app_owner' AND current_setting('app.public_lookup', true) = '1');

-- Dado el slug del negocio, devuelve su id, nombre, teléfono e introducción SOLO si el catálogo está publicado y el negocio está al día.
CREATE FUNCTION public_catalog_lookup(p_slug text) RETURNS TABLE (out_tenant_id uuid, out_name text, out_phone text, out_intro text)
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  PERFORM set_config('app.public_lookup', '1', true);
  RETURN QUERY
    SELECT t.id, t.name, p.phone, p.intro
      FROM tenants t JOIN public_catalog p ON p.tenant_id = t.id
     WHERE t.slug = lower(p_slug) AND p.enabled AND p.phone IS NOT NULL
       AND (t.status = 'active' OR (t.status = 'trial' AND (t.trial_ends_at IS NULL OR t.trial_ends_at > now())))
       AND t.deletion_requested_at IS NULL;
END
$$;
REVOKE ALL ON FUNCTION public_catalog_lookup(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public_catalog_lookup(text) TO app_user;
