-- Borra los datos que dejaron los tests: usuarios @example.test y los negocios
-- de prueba (los que quedaron sin ningún miembro o solo con esos usuarios).
-- Ejecutar como superusuario. No toca tu cuenta real.
BEGIN;
CREATE TEMP TABLE _basura AS
  SELECT t.id FROM tenants t
  WHERE NOT EXISTS (SELECT 1 FROM memberships m WHERE m.tenant_id = t.id)
     OR NOT EXISTS (
       SELECT 1 FROM memberships m JOIN users u ON u.id = m.user_id
       WHERE m.tenant_id = t.id AND u.email NOT LIKE '%@example.test'
     );
ALTER TABLE audit_log DISABLE TRIGGER audit_log_sin_cambios;
DELETE FROM audit_log WHERE tenant_id IN (SELECT id FROM _basura);
ALTER TABLE audit_log ENABLE TRIGGER audit_log_sin_cambios;
DELETE FROM tenants WHERE id IN (SELECT id FROM _basura);
DELETE FROM users WHERE email LIKE '%@example.test';
COMMIT;
