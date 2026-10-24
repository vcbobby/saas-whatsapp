-- Paso 22B: derechos sobre los datos. El dueño de un negocio puede (1) descargar todo lo suyo y
-- (2) pedir que se elimine: hay 7 días para arrepentirse y después el worker borra todo de forma definitiva.

ALTER TABLE tenants
  ADD COLUMN deletion_requested_at timestamptz,
  ADD COLUMN deletion_scheduled_for timestamptz,
  ADD CONSTRAINT tenants_deletion_check CHECK (
    (deletion_requested_at IS NULL AND deletion_scheduled_for IS NULL)
    OR (deletion_requested_at IS NOT NULL AND deletion_scheduled_for IS NOT NULL AND deletion_scheduled_for >= deletion_requested_at));
CREATE INDEX tenants_deletion_due_idx ON tenants (deletion_scheduled_for) WHERE deletion_scheduled_for IS NOT NULL;

-- El historial de auditoría sigue siendo de solo inserción, con UNA excepción: la función que borra un negocio
-- definitivamente (corre como app_owner, lo marca con app.purge y solo borra; nunca modifica).
CREATE OR REPLACE FUNCTION audit_log_inmutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' AND TG_LEVEL = 'ROW'
     AND current_setting('app.purge', true) = '1'
     AND CURRENT_USER = 'app_owner' AND SESSION_USER <> 'app_owner' THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'audit_log es de solo inserción' USING ERRCODE = 'insufficient_privilege';
END
$$;

CREATE POLICY audit_log_funciones_borrado ON audit_log FOR DELETE
  USING (CURRENT_USER = 'app_owner' AND SESSION_USER <> 'app_owner' AND current_setting('app.purge', true) = '1');

-- Pedir la eliminación (solo el dueño). Si ya estaba pedida, devuelve la fecha ya fijada.
CREATE FUNCTION tenant_request_deletion(p_tenant uuid, p_user uuid) RETURNS timestamptz
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE v_when timestamptz;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM memberships WHERE tenant_id = p_tenant AND user_id = p_user AND role = 'owner') THEN
    RAISE EXCEPTION 'no autorizado' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT deletion_scheduled_for INTO v_when FROM tenants WHERE id = p_tenant FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'negocio no encontrado' USING ERRCODE = 'P0002'; END IF;
  IF v_when IS NOT NULL THEN RETURN v_when; END IF;
  v_when := now() + interval '7 days';
  UPDATE tenants SET deletion_requested_at = now(), deletion_scheduled_for = v_when WHERE id = p_tenant;
  INSERT INTO audit_log (tenant_id, actor_id, action, target_type, target_id, metadata)
    VALUES (p_tenant, p_user, 'tenant.deletion_requested', 'tenant', p_tenant::text, jsonb_build_object('scheduled_for', v_when));
  RETURN v_when;
END
$$;

-- Arrepentirse: solo el dueño y solo antes de que llegue la fecha.
CREATE FUNCTION tenant_cancel_deletion(p_tenant uuid, p_user uuid) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE v_n int;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM memberships WHERE tenant_id = p_tenant AND user_id = p_user AND role = 'owner') THEN
    RAISE EXCEPTION 'no autorizado' USING ERRCODE = 'insufficient_privilege';
  END IF;
  UPDATE tenants SET deletion_requested_at = NULL, deletion_scheduled_for = NULL
    WHERE id = p_tenant AND deletion_scheduled_for IS NOT NULL AND deletion_scheduled_for > now();
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n = 0 THEN RETURN false; END IF;
  INSERT INTO audit_log (tenant_id, actor_id, action, target_type, target_id)
    VALUES (p_tenant, p_user, 'tenant.deletion_cancelled', 'tenant', p_tenant::text);
  RETURN true;
END
$$;

-- Miembros para el archivo de descarga (solo el dueño).
CREATE FUNCTION tenant_export_members(p_tenant uuid, p_user uuid)
RETURNS TABLE (m_email text, m_role text, m_since timestamptz, m_mfa boolean)
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM memberships WHERE tenant_id = p_tenant AND user_id = p_user AND role = 'owner') THEN
    RAISE EXCEPTION 'no autorizado' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN QUERY
    SELECT u.email, m.role, m.created_at, EXISTS (SELECT 1 FROM user_mfa f WHERE f.user_id = u.id AND f.enabled_at IS NOT NULL)
    FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.tenant_id = p_tenant ORDER BY m.created_at;
END
$$;

-- Pagos e invitaciones no son legibles directamente por la aplicación: se entregan por función (sin comprobantes ni claves).
CREATE FUNCTION tenant_export_restricted(p_tenant uuid, p_user uuid, p_cap int) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE v_pay jsonb; v_inv jsonb;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM memberships WHERE tenant_id = p_tenant AND user_id = p_user AND role = 'owner') THEN
    RAISE EXCEPTION 'no autorizado' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT coalesce(jsonb_agg(x), '[]'::jsonb) INTO v_pay FROM (
    SELECT to_jsonb(p) - 'proof' AS x FROM payments p WHERE p.tenant_id = p_tenant ORDER BY p.created_at, p.id LIMIT p_cap + 1) q;
  SELECT coalesce(jsonb_agg(x), '[]'::jsonb) INTO v_inv FROM (
    SELECT to_jsonb(i) - 'token_hash' AS x FROM invitations i WHERE i.tenant_id = p_tenant ORDER BY i.created_at, i.id LIMIT p_cap + 1) q;
  RETURN jsonb_build_object('payments', v_pay, 'invitations', v_inv);
END
$$;

-- Borrado definitivo de los negocios cuya fecha ya llegó (lo llama el worker). Devuelve cuántos borró.
-- Borra: el negocio y todo lo que cuelga de él (en cascada), su historial de auditoría y las personas que
-- solo pertenecían a ese negocio (salvo super administradores). Deja UNA fila sin datos personales: «tenant.purged».
CREATE FUNCTION tenant_purge_due(p_limit int DEFAULT 5) RETURNS int
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE r record; v_users uuid[]; v_deleted int := 0; v_users_n int;
BEGIN
  FOR r IN SELECT id FROM tenants WHERE deletion_scheduled_for IS NOT NULL AND deletion_scheduled_for <= now()
           ORDER BY deletion_scheduled_for LIMIT GREATEST(1, LEAST(p_limit, 50)) FOR UPDATE SKIP LOCKED
  LOOP
    SELECT coalesce(array_agg(m.user_id), '{}') INTO v_users FROM memberships m WHERE m.tenant_id = r.id;
    PERFORM set_config('app.purge', '1', true);
    DELETE FROM audit_log WHERE tenant_id = r.id;
    PERFORM set_config('app.purge', '0', true);
    DELETE FROM tenants WHERE id = r.id;
    DELETE FROM users u WHERE u.id = ANY (v_users) AND NOT u.is_super_admin
      AND NOT EXISTS (SELECT 1 FROM memberships m2 WHERE m2.user_id = u.id);
    GET DIAGNOSTICS v_users_n = ROW_COUNT;
    INSERT INTO audit_log (tenant_id, actor_id, action, target_type, target_id, metadata)
      VALUES (NULL, NULL, 'tenant.purged', 'tenant', r.id::text, jsonb_build_object('users_deleted', v_users_n));
    v_deleted := v_deleted + 1;
  END LOOP;
  RETURN v_deleted;
END
$$;

REVOKE ALL ON FUNCTION tenant_request_deletion(uuid, uuid), tenant_cancel_deletion(uuid, uuid),
  tenant_export_members(uuid, uuid), tenant_export_restricted(uuid, uuid, int), tenant_purge_due(int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION tenant_request_deletion(uuid, uuid), tenant_cancel_deletion(uuid, uuid),
  tenant_export_members(uuid, uuid), tenant_export_restricted(uuid, uuid, int), tenant_purge_due(int) TO app_user;
