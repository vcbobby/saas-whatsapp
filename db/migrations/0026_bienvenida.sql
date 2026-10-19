-- Paso 19C: asistente de bienvenida.
-- Estado por negocio: pending (aún no lo hace), done (lo completó) o skipped (lo saltó; puede retomarlo).
-- Los negocios que ya existían quedan en «done»: no se les obliga a pasar por el asistente.
ALTER TABLE tenants ADD COLUMN onboarding_state text NOT NULL DEFAULT 'done'
  CHECK (onboarding_state IN ('pending', 'done', 'skipped'));
ALTER TABLE tenants ALTER COLUMN onboarding_state SET DEFAULT 'pending';

-- Endurecimiento: hasta ahora la aplicación podía actualizar CUALQUIER columna de tenants
-- (estado, fin de prueba…). Ahora solo las que de verdad cambia un usuario del negocio: su nombre y el estado del asistente.
-- (plan_id y plan_expires_at ya estaban protegidos por un trigger; el estado y la prueba, no.)
REVOKE UPDATE ON tenants FROM app_user;
GRANT UPDATE (name, onboarding_state) ON tenants TO app_user;
