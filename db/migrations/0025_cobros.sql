-- Paso 18C: cobro asistido. El cliente elige plan, paga (Pago Móvil con tasa BCV congelada, PayPal o Binance),
-- sube el comprobante y el súper admin lo confirma. NADA se activa solo: la confirmación es siempre de una persona.

ALTER TABLE plans ADD COLUMN price_usd_cents integer CHECK (price_usd_cents IS NULL OR price_usd_cents BETWEEN 1 AND 100000000); -- NULL = no se vende en línea
ALTER TABLE tenants ADD COLUMN plan_expires_at timestamptz;

-- El vencimiento, igual que el plan, solo lo cambian las funciones del súper admin.
CREATE OR REPLACE FUNCTION tenants_plan_guard() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF (NEW.plan_id IS DISTINCT FROM OLD.plan_id OR NEW.plan_expires_at IS DISTINCT FROM OLD.plan_expires_at)
     AND NOT (current_user = 'app_owner' AND session_user <> 'app_owner') THEN
    RAISE EXCEPTION 'el plan solo lo cambia un súper admin' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END
$$;
DROP TRIGGER tenants_plan_guard ON tenants;
CREATE TRIGGER tenants_plan_guard BEFORE UPDATE OF plan_id, plan_expires_at ON tenants
  FOR EACH ROW EXECUTE FUNCTION tenants_plan_guard();

-- Datos de cobro de la plataforma (una sola fila). Ningún negocio la lee directamente.
CREATE TABLE platform_settings (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),
  bcv_rate numeric(14,4) CHECK (bcv_rate IS NULL OR bcv_rate > 0),
  bcv_rate_at timestamptz,
  pm_bank text CHECK (char_length(pm_bank) <= 60),
  pm_phone text CHECK (char_length(pm_phone) <= 30),
  pm_holder_id text CHECK (char_length(pm_holder_id) <= 30),
  pm_holder_name text CHECK (char_length(pm_holder_name) <= 80),
  paypal_email text CHECK (char_length(paypal_email) <= 120),
  binance_id text CHECK (char_length(binance_id) <= 80),
  notes text CHECK (char_length(notes) <= 500),
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO platform_settings (id) VALUES (true);
ALTER TABLE platform_settings ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON platform_settings FROM app_user;

CREATE TABLE payments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  plan_id uuid NOT NULL REFERENCES plans (id),
  months integer NOT NULL CHECK (months BETWEEN 1 AND 12),
  method text NOT NULL CHECK (method IN ('pago_movil', 'paypal', 'binance')),
  amount_usd_cents integer NOT NULL CHECK (amount_usd_cents > 0),
  rate numeric(14,4) CHECK (rate IS NULL OR rate > 0),          -- tasa BCV congelada (solo Pago Móvil)
  amount_bs_cents bigint CHECK (amount_bs_cents IS NULL OR amount_bs_cents > 0),
  quote_expires_at timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'pendiente' CHECK (status IN ('pendiente', 'por_revisar', 'confirmado', 'rechazado', 'vencido')),
  reference text CHECK (reference IS NULL OR reference ~ '^[A-Z0-9]{4,40}$'),
  payer_bank text CHECK (char_length(payer_bank) <= 60),
  payer_phone text CHECK (char_length(payer_phone) <= 30),
  paid_on date,
  declared_cents bigint CHECK (declared_cents IS NULL OR declared_cents > 0), -- lo que dice el cliente que pagó (Bs o USD, según el método)
  proof bytea CHECK (proof IS NULL OR octet_length(proof) <= 2097152),
  proof_mime text CHECK (proof_mime IS NULL OR proof_mime IN ('image/jpeg', 'image/png', 'image/webp')),
  created_by uuid REFERENCES users (id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  submitted_at timestamptz,
  decided_at timestamptz,
  decided_by uuid REFERENCES users (id) ON DELETE SET NULL,
  reject_reason text CHECK (char_length(reject_reason) <= 300),
  CHECK (method = 'pago_movil' OR (rate IS NULL AND amount_bs_cents IS NULL)),
  CHECK (method <> 'pago_movil' OR (rate IS NOT NULL AND amount_bs_cents IS NOT NULL))
);
CREATE INDEX payments_tenant_idx ON payments (tenant_id, created_at DESC);
CREATE INDEX payments_revision_idx ON payments (status, submitted_at) WHERE status = 'por_revisar';
-- Un mismo comprobante (método + referencia) no puede usarse dos veces, ni en otro negocio.
CREATE UNIQUE INDEX payments_referencia_unica_idx ON payments (method, reference) WHERE status IN ('por_revisar', 'confirmado');
ALTER TABLE payments ENABLE ROW LEVEL SECURITY;
CREATE POLICY payments_aislamiento ON payments USING (tenant_id = app_current_tenant());
-- El negocio solo LEE sus pagos (sin la imagen) y nunca escribe: todo cambio pasa por funciones.
REVOKE ALL ON payments FROM app_user;
GRANT SELECT (id, tenant_id, plan_id, months, method, amount_usd_cents, rate, amount_bs_cents, quote_expires_at, status,
              reference, paid_on, declared_cents, created_at, submitted_at, decided_at, reject_reason) ON payments TO app_user;

-- ---- Súper admin: precios y datos de cobro
CREATE FUNCTION admin_set_plan_price(p_token_hash bytea, p_plan_id uuid, p_price_cents integer) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
BEGIN
  PERFORM admin_require(p_token_hash);
  IF p_price_cents IS NOT NULL AND p_price_cents NOT BETWEEN 1 AND 100000000 THEN
    RAISE EXCEPTION 'precio inválido' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  UPDATE plans SET price_usd_cents = p_price_cents, updated_at = now() WHERE id = p_plan_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'plan inexistente' USING ERRCODE = 'no_data_found'; END IF;
END
$$;

CREATE FUNCTION admin_get_payment_settings(p_token_hash bytea) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$
BEGIN
  PERFORM admin_require(p_token_hash);
  RETURN (SELECT (to_jsonb(s) - 'id') || jsonb_build_object('rate_age_hours', EXTRACT(EPOCH FROM (now() - s.bcv_rate_at)) / 3600) FROM platform_settings s);
END
$$;

CREATE FUNCTION admin_set_payment_settings(
  p_token_hash bytea, p_rate numeric, p_pm_bank text, p_pm_phone text, p_pm_holder_id text, p_pm_holder_name text,
  p_paypal text, p_binance text, p_notes text
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
BEGIN
  PERFORM admin_require(p_token_hash);
  IF p_rate IS NOT NULL AND (p_rate <= 0 OR p_rate > 100000000) THEN
    RAISE EXCEPTION 'tasa inválida' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  UPDATE platform_settings SET
    bcv_rate = p_rate,
    -- la fecha de la tasa solo se renueva cuando el admin la guarda (aunque repita el mismo valor: confirma que sigue vigente)
    bcv_rate_at = CASE WHEN p_rate IS NULL THEN NULL ELSE now() END,
    pm_bank = NULLIF(btrim(p_pm_bank), ''), pm_phone = NULLIF(btrim(p_pm_phone), ''),
    pm_holder_id = NULLIF(btrim(p_pm_holder_id), ''), pm_holder_name = NULLIF(btrim(p_pm_holder_name), ''),
    paypal_email = NULLIF(btrim(p_paypal), ''), binance_id = NULLIF(btrim(p_binance), ''),
    notes = NULLIF(btrim(p_notes), ''), updated_at = now();
END
$$;

-- ---- Negocio: datos para pagar (solo el dueño)
CREATE FUNCTION payment_payee(p_token_hash bytea, p_tenant_id uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$
BEGIN
  IF COALESCE(auth_tenant_role(p_token_hash, p_tenant_id), '') <> 'owner' THEN
    RAISE EXCEPTION 'no autorizado' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN (SELECT jsonb_build_object(
    'pagoMovil', CASE WHEN pm_phone IS NOT NULL AND pm_bank IS NOT NULL AND pm_holder_id IS NOT NULL
                 THEN jsonb_build_object('banco', pm_bank, 'telefono', pm_phone, 'documento', pm_holder_id, 'titular', pm_holder_name) END,
    'paypal', paypal_email, 'binance', binance_id, 'notas', notes,
    'rate', bcv_rate, 'rateAt', bcv_rate_at,
    'rateFresh', bcv_rate IS NOT NULL AND bcv_rate_at > now() - interval '36 hours')
    FROM platform_settings);
END
$$;

CREATE FUNCTION payment_create(p_token_hash bytea, p_tenant_id uuid, p_plan_id uuid, p_months integer, p_method text) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
  v_user uuid; v_price integer; v_active boolean; s platform_settings%ROWTYPE;
  v_usd bigint; v_rate numeric; v_bs bigint; v_exp timestamptz; v_id uuid;
BEGIN
  IF COALESCE(auth_tenant_role(p_token_hash, p_tenant_id), '') <> 'owner' THEN
    RAISE EXCEPTION 'no autorizado' USING ERRCODE = 'insufficient_privilege';
  END IF;
  v_user := auth_session_user(p_token_hash);
  IF p_months NOT BETWEEN 1 AND 12 OR p_method NOT IN ('pago_movil', 'paypal', 'binance') THEN
    RAISE EXCEPTION 'datos inválidos' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  SELECT price_usd_cents, active INTO v_price, v_active FROM plans WHERE id = p_plan_id;
  IF NOT FOUND OR v_active IS NOT TRUE OR v_price IS NULL THEN
    RAISE EXCEPTION 'plan no disponible' USING ERRCODE = 'no_data_found';
  END IF;
  SELECT * INTO s FROM platform_settings;
  -- Se cierran las cotizaciones viejas sin comprobante antes de contar cuántas hay abiertas.
  UPDATE payments SET status = 'vencido'
   WHERE tenant_id = p_tenant_id AND status = 'pendiente' AND quote_expires_at + interval '6 hours' < now();
  IF (SELECT count(*) FROM payments WHERE tenant_id = p_tenant_id AND status IN ('pendiente', 'por_revisar')) >= 3 THEN
    RAISE EXCEPTION 'demasiados pagos abiertos' USING ERRCODE = 'program_limit_exceeded';
  END IF;
  v_usd := v_price::bigint * p_months;
  IF v_usd > 2147483647 THEN RAISE EXCEPTION 'datos inválidos' USING ERRCODE = 'invalid_parameter_value'; END IF;
  IF p_method = 'pago_movil' THEN
    IF s.pm_phone IS NULL OR s.pm_bank IS NULL OR s.pm_holder_id IS NULL THEN
      RAISE EXCEPTION 'método no disponible' USING ERRCODE = 'feature_not_supported';
    END IF;
    -- Nunca se cobra con una tasa vieja: si el admin no la renovó en 36 h, no se cotiza.
    IF s.bcv_rate IS NULL OR s.bcv_rate_at < now() - interval '36 hours' THEN
      RAISE EXCEPTION 'tasa desactualizada' USING ERRCODE = 'object_not_in_prerequisite_state';
    END IF;
    v_rate := s.bcv_rate;
    v_bs := round(v_usd * v_rate);          -- USD en centavos × (Bs por USD) = Bs en céntimos
    v_exp := now() + interval '30 minutes';
  ELSE
    IF (p_method = 'paypal' AND s.paypal_email IS NULL) OR (p_method = 'binance' AND s.binance_id IS NULL) THEN
      RAISE EXCEPTION 'método no disponible' USING ERRCODE = 'feature_not_supported';
    END IF;
    v_exp := now() + interval '24 hours';
  END IF;
  INSERT INTO payments (tenant_id, plan_id, months, method, amount_usd_cents, rate, amount_bs_cents, quote_expires_at, created_by)
    VALUES (p_tenant_id, p_plan_id, p_months, p_method, v_usd, v_rate, v_bs, v_exp, v_user) RETURNING id INTO v_id;
  RETURN v_id;
END
$$;

CREATE FUNCTION payment_submit(
  p_token_hash bytea, p_tenant_id uuid, p_id uuid, p_reference text, p_bank text, p_phone text,
  p_paid_on date, p_declared_cents bigint, p_proof bytea, p_mime text
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE v_method text; v_status text; v_exp timestamptz; v_ref text;
BEGIN
  IF COALESCE(auth_tenant_role(p_token_hash, p_tenant_id), '') <> 'owner' THEN
    RAISE EXCEPTION 'no autorizado' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT method, status, quote_expires_at INTO v_method, v_status, v_exp FROM payments WHERE id = p_id AND tenant_id = p_tenant_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'pago inexistente' USING ERRCODE = 'no_data_found'; END IF;
  IF v_status <> 'pendiente' THEN RAISE EXCEPTION 'pago ya enviado' USING ERRCODE = 'object_not_in_prerequisite_state'; END IF;
  -- Se puede subir el comprobante hasta 6 h después de vencida la cotización (por si pagó justo al final).
  IF v_exp + interval '6 hours' < now() THEN
    RAISE EXCEPTION 'cotización vencida' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  v_ref := upper(regexp_replace(COALESCE(p_reference, ''), '[^A-Za-z0-9]', '', 'g'));
  IF v_ref !~ '^[A-Z0-9]{4,40}$' OR p_declared_cents IS NULL OR p_declared_cents <= 0 OR p_paid_on IS NULL
     OR p_paid_on > (now() AT TIME ZONE 'utc')::date + 1 OR p_paid_on < (now() AT TIME ZONE 'utc')::date - 3
     OR p_proof IS NULL OR octet_length(p_proof) > 2097152 OR p_mime NOT IN ('image/jpeg', 'image/png', 'image/webp')
     OR (v_method = 'pago_movil' AND (btrim(COALESCE(p_bank, '')) = '' OR btrim(COALESCE(p_phone, '')) = '')) THEN
    RAISE EXCEPTION 'datos inválidos' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF EXISTS (SELECT 1 FROM payments WHERE method = v_method AND reference = v_ref AND status IN ('por_revisar', 'confirmado')) THEN
    RAISE EXCEPTION 'referencia repetida' USING ERRCODE = 'unique_violation';
  END IF;
  UPDATE payments SET status = 'por_revisar', reference = v_ref, payer_bank = NULLIF(btrim(p_bank), ''), payer_phone = NULLIF(btrim(p_phone), ''),
         paid_on = p_paid_on, declared_cents = p_declared_cents, proof = p_proof, proof_mime = p_mime, submitted_at = now()
   WHERE id = p_id;
END
$$;

-- ---- Súper admin: cola de revisión
CREATE FUNCTION admin_list_payments(p_token_hash bytea, p_status text)
RETURNS TABLE (
  o_id uuid, o_tenant_id uuid, o_tenant_name text, o_plan_name text, o_months integer, o_method text,
  o_amount_usd_cents integer, o_rate numeric, o_amount_bs_cents bigint, o_status text, o_reference text,
  o_payer_bank text, o_payer_phone text, o_paid_on date, o_declared_cents bigint, o_has_proof boolean,
  o_created_at timestamptz, o_submitted_at timestamptz, o_decided_at timestamptz, o_reject_reason text
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$
BEGIN
  PERFORM admin_require(p_token_hash);
  RETURN QUERY
    SELECT x.id, x.tenant_id, t.name, pl.name, x.months, x.method, x.amount_usd_cents, x.rate, x.amount_bs_cents, x.status, x.reference,
           x.payer_bank, x.payer_phone, x.paid_on, x.declared_cents, x.proof IS NOT NULL, x.created_at, x.submitted_at, x.decided_at, x.reject_reason
      FROM payments x JOIN tenants t ON t.id = x.tenant_id JOIN plans pl ON pl.id = x.plan_id
     WHERE (p_status IS NULL OR x.status = p_status)
     ORDER BY COALESCE(x.submitted_at, x.created_at) DESC LIMIT 100;
END
$$;

CREATE FUNCTION admin_payment_proof(p_token_hash bytea, p_id uuid) RETURNS TABLE (o_proof bytea, o_mime text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$
BEGIN
  PERFORM admin_require(p_token_hash);
  RETURN QUERY SELECT x.proof, x.proof_mime FROM payments x WHERE x.id = p_id AND x.proof IS NOT NULL;
END
$$;

CREATE FUNCTION admin_payment_decide(p_token_hash bytea, p_id uuid, p_approve boolean, p_reason text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
  v_user uuid; x payments%ROWTYPE; v_cur_plan uuid; v_cur_exp timestamptz; v_base timestamptz; v_new timestamptz; v_tstatus text;
BEGIN
  v_user := admin_require(p_token_hash);
  SELECT * INTO x FROM payments WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'pago inexistente' USING ERRCODE = 'no_data_found'; END IF;
  IF x.status <> 'por_revisar' THEN RAISE EXCEPTION 'pago no está por revisar' USING ERRCODE = 'object_not_in_prerequisite_state'; END IF;
  IF NOT p_approve THEN
    IF btrim(COALESCE(p_reason, '')) = '' THEN RAISE EXCEPTION 'falta el motivo' USING ERRCODE = 'invalid_parameter_value'; END IF;
    UPDATE payments SET status = 'rechazado', reject_reason = left(btrim(p_reason), 300), decided_at = now(), decided_by = v_user WHERE id = p_id;
    INSERT INTO audit_log (tenant_id, actor_id, action, target_type, target_id, metadata)
      VALUES (x.tenant_id, v_user, 'billing.payment.reject', 'payment', p_id::text, jsonb_build_object('method', x.method));
    RETURN;
  END IF;
  SELECT plan_id, plan_expires_at, status INTO v_cur_plan, v_cur_exp, v_tstatus FROM tenants WHERE id = x.tenant_id FOR UPDATE;
  -- Renovar el mismo plan suma sobre lo que le queda; cambiar de plan empieza hoy.
  v_base := CASE WHEN v_cur_plan = x.plan_id AND v_cur_exp IS NOT NULL AND v_cur_exp > now() THEN v_cur_exp ELSE now() END;
  v_new := v_base + (x.months * 30) * interval '1 day';
  UPDATE tenants SET plan_id = x.plan_id, plan_expires_at = v_new,
         status = CASE WHEN status = 'suspended' THEN status ELSE 'active' END
   WHERE id = x.tenant_id;
  UPDATE payments SET status = 'confirmado', decided_at = now(), decided_by = v_user WHERE id = p_id;
  INSERT INTO audit_log (tenant_id, actor_id, action, target_type, target_id, metadata)
    VALUES (x.tenant_id, v_user, 'billing.payment.confirm', 'payment', p_id::text,
            jsonb_build_object('method', x.method, 'plan', x.plan_id, 'months', x.months, 'until', v_new));
END
$$;

-- Marca como «pago pendiente» a los negocios cuyo período pagado terminó (los de prueba o activados a mano no tienen fecha y no se tocan).
CREATE FUNCTION expire_subscriptions() RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE n integer;
BEGIN
  WITH e AS (
    UPDATE tenants SET status = 'past_due' WHERE status = 'active' AND plan_expires_at IS NOT NULL AND plan_expires_at < now() RETURNING id
  ), a AS (
    INSERT INTO audit_log (tenant_id, actor_id, action, target_type, target_id)
      SELECT id, NULL, 'billing.expired', 'tenant', id::text FROM e
  )
  SELECT count(*) INTO n FROM e;
  UPDATE payments SET status = 'vencido' WHERE status = 'pendiente' AND quote_expires_at + interval '6 hours' < now();
  RETURN n;
END
$$;

REVOKE ALL ON FUNCTION admin_set_plan_price(bytea, uuid, integer), admin_get_payment_settings(bytea),
  admin_set_payment_settings(bytea, numeric, text, text, text, text, text, text, text),
  payment_payee(bytea, uuid), payment_create(bytea, uuid, uuid, integer, text),
  payment_submit(bytea, uuid, uuid, text, text, text, date, bigint, bytea, text),
  admin_list_payments(bytea, text), admin_payment_proof(bytea, uuid), admin_payment_decide(bytea, uuid, boolean, text),
  expire_subscriptions() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION admin_set_plan_price(bytea, uuid, integer), admin_get_payment_settings(bytea),
  admin_set_payment_settings(bytea, numeric, text, text, text, text, text, text, text),
  payment_payee(bytea, uuid), payment_create(bytea, uuid, uuid, integer, text),
  payment_submit(bytea, uuid, uuid, text, text, text, date, bigint, bytea, text),
  admin_list_payments(bytea, text), admin_payment_proof(bytea, uuid), admin_payment_decide(bytea, uuid, boolean, text),
  expire_subscriptions() TO app_user;
