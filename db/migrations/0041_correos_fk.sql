-- Paso 30 (ajuste): los correos de un negocio se borran con el negocio (derecho de eliminación).
-- Si 0040 ya traía la llave foránea (instalaciones nuevas) no hace nada.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'email_outbox'::regclass AND contype = 'f') THEN
    DELETE FROM email_outbox WHERE tenant_id IS NOT NULL AND tenant_id NOT IN (SELECT id FROM tenants);
    ALTER TABLE email_outbox ADD CONSTRAINT email_outbox_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES tenants (id) ON DELETE CASCADE;
  END IF;
END
$$;
