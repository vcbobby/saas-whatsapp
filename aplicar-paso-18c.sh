#!/usr/bin/env bash
# Paso 18C: cobro asistido (Pago Móvil con tasa BCV, PayPal, Binance), comprobantes y vencimientos.
# Ejecútalo desde la raíz del proyecto:  bash aplicar-paso-18c.sh
set -euo pipefail

[ -f package.json ] && grep -q '"name": "saas-whatsapp"' package.json || { echo "✖ Ejecuta esto dentro de ~/proyectos/saas-whatsapp"; exit 1; }
[ -f db/migrations/0016_pedidos.sql ] || { echo "✖ Falta el Paso 14B (migración 0016). Aplícalo primero."; exit 1; }
[ -f db/migrations/0020_automatizaciones.sql ] || { echo "✖ Falta el Paso 16B (migración 0020). Aplícalo primero."; exit 1; }
[ -f src/lib/automations/rules.ts ] || { echo "✖ Falta el Paso 16B (automatizaciones). Aplícalo primero."; exit 1; }
[ -f db/migrations/0022_recordatorios.sql ] || { echo "✖ Falta el Paso 16D (migración 0022). Aplícalo primero."; exit 1; }
[ -f db/migrations/0024_modulos_plan.sql ] || { echo "✖ Falta el Paso 18B (migración 0024). Aplícalo primero."; exit 1; }
[ -f db/migrations/0023_planes.sql ] || { echo "✖ Falta el Paso 18A (migración 0023). Aplícalo primero."; exit 1; }
[ -f src/lib/modules.ts ] || { echo "✖ Falta el Paso 17A (src/lib/modules.ts). Aplícalo primero."; exit 1; }
command -v npm >/dev/null || { echo "✖ No encuentro npm"; exit 1; }

if [ "$(git rev-parse --abbrev-ref HEAD 2>/dev/null)" = "main" ]; then
  git checkout -b paso-18c 2>/dev/null || git checkout paso-18c
  echo "✔ Rama paso-18c lista"
fi

BK=".paso18c-backup"
mkdir -p "$BK"
backup() { if [ -f "$1" ]; then mkdir -p "$BK/$(dirname "$1")"; cp "$1" "$BK/$1"; fi; }
grep -q "^.paso18c-backup" .gitignore 2>/dev/null || printf "\n.paso18c-backup/\n" >> .gitignore
backup db/migrations/0025_cobros.sql
backup src/lib/billing/money.ts
backup src/lib/billing/proof.ts
backup src/lib/billing/errors.ts
backup src/lib/billing/data.ts
backup src/lib/billing/image.ts
backup src/lib/auth/validation.ts
backup src/app/api/billing/route.ts
backup src/app/api/billing/pay/route.ts
backup src/app/api/billing/submit/route.ts
backup src/app/api/admin/payments/route.ts
backup src/app/api/admin/payments/proof/route.ts
backup src/app/api/admin/payments/decide/route.ts
backup src/app/api/admin/billing-settings/route.ts
backup src/app/api/admin/plan-price/route.ts
backup src/app/api/plan/route.ts
backup src/components/BillingPanel.tsx
backup src/components/AdminBilling.tsx
backup src/components/PlanCard.tsx
backup src/app/plan/page.tsx
backup src/app/admin/page.tsx
backup src/worker/index.ts
backup tests/billing.test.ts

mkdir -p db/migrations
cat > db/migrations/0025_cobros.sql <<'EOF_DB_MIGRATIONS_0025_COBROS_SQL'
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
EOF_DB_MIGRATIONS_0025_COBROS_SQL
echo "✔ db/migrations/0025_cobros.sql"
mkdir -p src/lib/billing
cat > src/lib/billing/money.ts <<'EOF_SRC_LIB_BILLING_MONEY_TS'
/** Dólares: de centavos a «$12,50». */
export function formatUsd(cents: number): string {
  return `$${(cents / 100).toLocaleString("es-VE", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
/** Bolívares: de céntimos a «Bs. 1.234,56». */
export function formatBs(cents: number): string {
  return `Bs. ${(cents / 100).toLocaleString("es-VE", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/**
 * Lee un monto escrito por una persona («1.234,56», «1234.56», «12,5») y lo devuelve en céntimos enteros.
 * null si no es un monto claro. Sin decimales flotantes: se trabaja con texto.
 */
export function parseAmountToCents(input: string): number | null {
  const s = input.trim().replace(/\s/g, "").replace(/^(bs\.?|\$|usd)/i, "");
  if (!/^\d[\d.,]*$/.test(s)) return null;
  const lastComma = s.lastIndexOf(",");
  const lastDot = s.lastIndexOf(".");
  const sepPos = Math.max(lastComma, lastDot);
  let intPart = s, frac = "";
  if (sepPos >= 0) {
    const after = s.length - sepPos - 1;
    // «1.234» (3 dígitos tras un solo punto/coma) es un millar, no un decimal.
    const isThousands = after === 3 && (s.match(/[.,]/g) ?? []).length === 1 && s[sepPos] === ".";
    if (!isThousands && after >= 1 && after <= 2) { intPart = s.slice(0, sepPos); frac = s.slice(sepPos + 1); }
    else if (!isThousands && after !== 0) return null;
  }
  // La parte entera solo puede llevar separadores de millar bien puestos (1.234.567), nunca sueltos.
  if (!/^(\d{1,3}([.,]\d{3})+|\d+)$/.test(intPart)) return null;
  const digits = intPart.replace(/[.,]/g, "");
  if (!/^\d+$/.test(digits) || digits.length > 12) return null;
  const cents = Number(digits) * 100 + Number((frac + "00").slice(0, 2));
  return cents > 0 && Number.isSafeInteger(cents) ? cents : null;
}

/** ¿Lo declarado coincide con lo esperado? Tolera 1 % (redondeos de comisión/tasa). */
export function amountMatches(declaredCents: number, expectedCents: number): boolean {
  return Math.abs(declaredCents - expectedCents) <= Math.max(1, Math.round(expectedCents * 0.01));
}
EOF_SRC_LIB_BILLING_MONEY_TS
echo "✔ src/lib/billing/money.ts"
mkdir -p src/lib/billing
cat > src/lib/billing/proof.ts <<'EOF_SRC_LIB_BILLING_PROOF_TS'
export const MAX_PROOF_BYTES = 2 * 1024 * 1024;
export type ProofMime = "image/jpeg" | "image/png" | "image/webp";

/** Qué tipo de imagen es, mirando los primeros bytes (no se confía en lo que diga el navegador). */
export function sniffImage(b: Uint8Array): ProofMime | null {
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 && b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a) return "image/png";
  if (b.length >= 12 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return "image/webp";
  return null;
}
EOF_SRC_LIB_BILLING_PROOF_TS
echo "✔ src/lib/billing/proof.ts"
mkdir -p src/lib/billing
cat > src/lib/billing/errors.ts <<'EOF_SRC_LIB_BILLING_ERRORS_TS'
import { errorResponse } from "@/lib/auth/http";

/** Errores de las funciones de cobro -> respuestas claras. null = no es de cobro. */
export function billingErrorResponse(err: unknown): Response | null {
  const e = err as { code?: string };
  switch (e.code) {
    case "42501": return errorResponse(403, "sin_permiso", "Solo el dueño del negocio puede pagar o cambiar de plan.");
    case "P0002": return errorResponse(404, "no_encontrado", "No encontrado, o el plan no está disponible.");
    case "22023": return errorResponse(400, "datos_invalidos", "Revisa los datos: referencia, fecha (de los últimos 3 días), monto y la imagen del comprobante.");
    case "54000": return errorResponse(409, "demasiados_pagos", "Ya tienes 3 pagos abiertos. Termina o espera a que venzan antes de crear otro.");
    case "0A000": return errorResponse(409, "metodo_no_disponible", "Ese método de pago no está disponible por ahora. Elige otro o escríbenos.");
    case "55000": return errorResponse(409, "estado_invalido", "Ese pago ya no está en un estado que lo permita (quizá ya se envió o se resolvió).");
    case "23505": return errorResponse(409, "referencia_repetida", "Esa referencia ya fue usada en otro pago.");
    default: return null;
  }
}
/** Mensaje específico cuando la tasa no está al día (misma code 55000 que «estado inválido», se distingue por texto). */
export function isStaleRate(err: unknown): boolean {
  return /tasa desactualizada/.test((err as { message?: string }).message ?? "");
}
EOF_SRC_LIB_BILLING_ERRORS_TS
echo "✔ src/lib/billing/errors.ts"
mkdir -p src/lib/billing
cat > src/lib/billing/data.ts <<'EOF_SRC_LIB_BILLING_DATA_TS'
import type { PoolClient } from "pg";

type Db = Pick<PoolClient, "query">;

export interface PlanOffer { id: string; slug: string; name: string; priceUsdCents: number; maxRepliesMonth: number | null; maxMembers: number; modules: string[] }
export interface PaymentRow {
  id: string; planId: string; months: number; method: "pago_movil" | "paypal" | "binance"; amountUsdCents: number;
  rate: number | null; amountBsCents: number | null; quoteExpiresAt: string; status: "pendiente" | "por_revisar" | "confirmado" | "rechazado" | "vencido";
  reference: string | null; paidOn: string | null; declaredCents: number | null; createdAt: string; submittedAt: string | null; rejectReason: string | null;
}
export interface Subscription { status: string; planName: string; expiresAt: string | null; daysLeft: number | null }

/** Planes que se pueden comprar (activos y con precio). */
export async function loadOffers(db: Db): Promise<PlanOffer[]> {
  const r = await db.query("SELECT id, slug, name, price_usd_cents, max_replies_month, max_members, modules FROM plans WHERE active AND price_usd_cents IS NOT NULL ORDER BY position, name");
  return r.rows.map((x) => ({ id: x.id, slug: x.slug, name: x.name, priceUsdCents: Number(x.price_usd_cents), maxRepliesMonth: x.max_replies_month === null ? null : Number(x.max_replies_month), maxMembers: Number(x.max_members), modules: x.modules }));
}

export async function loadPayments(db: Db, tenantId: string): Promise<PaymentRow[]> {
  const r = await db.query(
    `SELECT id, plan_id, months, method, amount_usd_cents, rate, amount_bs_cents, quote_expires_at, status, reference, to_char(paid_on, 'YYYY-MM-DD') AS paid_on, declared_cents, created_at, submitted_at, reject_reason
       FROM payments WHERE tenant_id = $1 ORDER BY created_at DESC LIMIT 20`, [tenantId]);
  return r.rows.map((x) => ({
    id: x.id, planId: x.plan_id, months: x.months, method: x.method, amountUsdCents: Number(x.amount_usd_cents),
    rate: x.rate === null ? null : Number(x.rate), amountBsCents: x.amount_bs_cents === null ? null : Number(x.amount_bs_cents),
    quoteExpiresAt: new Date(x.quote_expires_at).toISOString(), status: x.status, reference: x.reference,
    paidOn: x.paid_on,
    declaredCents: x.declared_cents === null ? null : Number(x.declared_cents),
    createdAt: new Date(x.created_at).toISOString(), submittedAt: x.submitted_at ? new Date(x.submitted_at).toISOString() : null, rejectReason: x.reject_reason,
  }));
}

export async function loadSubscription(db: Db, tenantId: string): Promise<Subscription | null> {
  const r = await db.query(
    `SELECT t.status, p.name, t.plan_expires_at,
            CASE WHEN t.plan_expires_at IS NULL THEN NULL ELSE CEIL(EXTRACT(EPOCH FROM (t.plan_expires_at - now())) / 86400)::int END AS days_left
       FROM tenants t JOIN plans p ON p.id = t.plan_id WHERE t.id = $1`, [tenantId]);
  const x = r.rows[0];
  if (!x) return null;
  return { status: x.status, planName: x.name, expiresAt: x.plan_expires_at ? new Date(x.plan_expires_at).toISOString() : null, daysLeft: x.days_left === null ? null : Number(x.days_left) };
}
EOF_SRC_LIB_BILLING_DATA_TS
echo "✔ src/lib/billing/data.ts"
mkdir -p src/lib/billing
cat > src/lib/billing/image.ts <<'EOF_SRC_LIB_BILLING_IMAGE_TS'
/**
 * Reduce una foto o captura del comprobante en el navegador: JPG de máx. 1600 px de lado y menos de 1,5 MB.
 * Devuelve el base64 sin prefijo. Lanza un Error con un mensaje para la persona si no se puede leer.
 */
export async function compressProof(file: File): Promise<string> {
  if (!file.type.startsWith("image/")) throw new Error("El comprobante debe ser una imagen (JPG, PNG o captura de pantalla).");
  if (file.size > 25 * 1024 * 1024) throw new Error("La imagen es demasiado grande.");
  let bmp: ImageBitmap;
  try { bmp = await createImageBitmap(file); } catch { throw new Error("No pude leer esa imagen. Prueba con una captura en JPG o PNG."); }
  const scale = Math.min(1, 1600 / Math.max(bmp.width, bmp.height));
  const w = Math.max(1, Math.round(bmp.width * scale)), h = Math.max(1, Math.round(bmp.height * scale));
  const canvas = document.createElement("canvas");
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Tu navegador no pudo preparar la imagen.");
  ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, w, h); // fondo blanco por si la captura es transparente
  ctx.drawImage(bmp, 0, 0, w, h);
  bmp.close();
  for (const q of [0.85, 0.7, 0.55, 0.4]) {
    const blob = await new Promise<Blob | null>((res) => canvas.toBlob(res, "image/jpeg", q));
    if (blob && blob.size <= 1_500_000) {
      const buf = new Uint8Array(await blob.arrayBuffer());
      let bin = "";
      for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
      return btoa(bin);
    }
  }
  throw new Error("No logré reducir la imagen lo suficiente. Recórtala o envía una captura más pequeña.");
}
EOF_SRC_LIB_BILLING_IMAGE_TS
echo "✔ src/lib/billing/image.ts"
mkdir -p src/lib/auth
cat > src/lib/auth/validation.ts <<'EOF_SRC_LIB_AUTH_VALIDATION_TS'
import { z } from "zod";
import { BUSINESS_TYPES, COUNTRY_CODES, EMOJI_LEVELS, REPLY_LENGTHS, TONES } from "@/lib/agent/style";

export const emailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .pipe(z.email().max(254));

export const passwordSchema = z
  .string()
  .min(10, "La contraseña debe tener al menos 10 caracteres")
  .max(128, "La contraseña es demasiado larga")
  .refine((p) => new Set(p).size > 3, "La contraseña es demasiado repetitiva");

export const signupSchema = z
  .object({
    email: emailSchema,
    password: passwordSchema,
    businessName: z.string().trim().min(2).max(120),
  })
  .refine(
    (d) => {
      const local = d.email.split("@")[0] ?? "";
      return local.length < 4 || !d.password.toLowerCase().includes(local);
    },
    { path: ["password"], message: "La contraseña no puede contener tu correo" },
  );

export const loginSchema = z.object({
  email: emailSchema,
  password: z.string().min(1).max(128),
});

export const impersonationSchema = z.object({
  tenantId: z.uuid(),
  reason: z.string().trim().min(10).max(500),
});

export const tenantStatusSchema = z.object({
  tenantId: z.uuid(),
  status: z.enum(["trial", "active", "past_due", "suspended"]),
});

export const tenantPlanSchema = z.object({ tenantId: z.uuid(), planId: z.uuid() });

export const planUpdateSchema = z.object({
  planId: z.uuid(),
  name: z.string().trim().min(1, "Ponle un nombre").max(60),
  maxRepliesMonth: z.number().int().min(0).max(10_000_000).nullable(),
  maxMembers: z.number().int().min(1).max(1000),
  modules: z.array(z.enum(["agenda", "catalogo", "copiloto", "automatizaciones"])).max(4),
  active: z.boolean(),
});

// "Panadería La Esquina" -> "panaderia-la-esquina-a1b2c3"
export function makeSlug(name: string, randomSuffix: string): string {
  const base = name
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "");
  return `${base || "negocio"}-${randomSuffix}`;
}

// ---------------------------------------------------------------- 2FA y equipo
export const totpCodeSchema = z.string().trim().regex(/^\d{3}\s?\d{3}$/, "El código tiene 6 dígitos");

export const mfaVerifySchema = z.union([
  z.object({ code: totpCodeSchema }),
  z.object({ recoveryCode: z.string().trim().min(15).max(24) }),
]);

export const mfaConfirmSchema = z.object({ code: totpCodeSchema });

export const mfaSensitiveSchema = z.object({
  password: z.string().min(1).max(128),
  code: totpCodeSchema,
});

export const inviteSchema = z.object({
  email: emailSchema,
  role: z.enum(["admin", "agent"]),
});

export const invitationIdSchema = z.object({ invitationId: z.uuid() });

export const roleChangeSchema = z.object({
  userId: z.uuid(),
  role: z.enum(["admin", "agent"]),
});

export const removeMemberSchema = z.object({ userId: z.uuid() });

export const inviteTokenSchema = z.object({ token: z.string().regex(/^[A-Za-z0-9_-]{43}$/) });

export const inviteSignupSchema = z.object({
  token: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  password: passwordSchema,
});

// ---------------------------------------------------------------- WhatsApp
export const whatsappConnectSchema = z.object({
  phoneNumberId: z.string().trim().regex(/^\d{5,30}$/, "El ID del número son solo dígitos"),
  accessToken: z
    .string()
    .trim()
    .min(20, "El token es demasiado corto")
    .max(1000)
    .regex(/^\S+$/, "El token no debe llevar espacios"),
});

// ------------------------------------------------------------------ agente
export const agentSettingsSchema = z.object({
  enabled: z.boolean(),
  assistantName: z.string().trim().min(1, "Ponle un nombre al asistente").max(60, "Máximo 60 caracteres"),
  instructions: z.string().max(4000, "Máximo 4000 caracteres"),
  // Estilo (opcional: si no viene, se conserva el que ya tiene el negocio).
  businessType: z.enum(BUSINESS_TYPES).optional(),
  country: z.enum(COUNTRY_CODES).optional(),
  tone: z.enum(TONES).optional(),
  emojiLevel: z.enum(EMOJI_LEVELS).optional(),
  replyLength: z.enum(REPLY_LENGTHS).optional(),
});

// ---- Cobros (Paso 18C)
export const payCreateSchema = z.object({
  planId: z.uuid(),
  months: z.number().int().min(1).max(12),
  method: z.enum(["pago_movil", "paypal", "binance"]),
});
export const paySubmitSchema = z.object({
  paymentId: z.uuid(),
  reference: z.string().trim().min(4, "La referencia es muy corta").max(60),
  bank: z.string().trim().max(60).default(""),
  phone: z.string().trim().max(30).default(""),
  paidOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Fecha inválida"),
  declared: z.string().trim().min(1, "Escribe el monto que pagaste").max(30),
  proof: z.string().min(100, "Falta la imagen del comprobante").max(3_000_000),
});
export const planPriceSchema = z.object({ planId: z.uuid(), priceCents: z.number().int().min(1).max(100_000_000).nullable() });
export const billingSettingsSchema = z.object({
  rate: z.number().positive().max(100_000_000).nullable(),
  pmBank: z.string().trim().max(60), pmPhone: z.string().trim().max(30), pmHolderId: z.string().trim().max(30), pmHolderName: z.string().trim().max(80),
  paypal: z.string().trim().max(120), binance: z.string().trim().max(80), notes: z.string().trim().max(500),
});
export const paymentDecideSchema = z.object({ paymentId: z.uuid(), approve: z.boolean(), reason: z.string().trim().max(300).optional() });
EOF_SRC_LIB_AUTH_VALIDATION_TS
echo "✔ src/lib/auth/validation.ts"
mkdir -p src/app/api/billing
cat > src/app/api/billing/route.ts <<'EOF_SRC_APP_API_BILLING_ROUTE_TS'
import { getPool, withTenant } from "@/lib/db";
import { requireTenant } from "@/lib/auth/guard";
import { jsonResponse, route } from "@/lib/auth/http";
import { tokenHashOf } from "@/lib/auth/session";
import { loadOffers, loadPayments, loadSubscription } from "@/lib/billing/data";

/** Planes a la venta, pagos del negocio, vencimiento y datos para pagar. Solo el dueño. */
export const GET = route(async (req) => {
  const auth = await requireTenant(req, "billing:manage");
  if (!auth.ok) return auth.response;
  const t = auth.ctx.tenantId;
  const [offers, payments, subscription] = await withTenant(t, async (db) => [await loadOffers(db), await loadPayments(db, t), await loadSubscription(db, t)] as const);
  const payee = (await getPool().query("SELECT payment_payee($1, $2) AS p", [tokenHashOf(req)!, t])).rows[0].p as Record<string, unknown>;
  return jsonResponse({ offers, payments, subscription, payee });
});
EOF_SRC_APP_API_BILLING_ROUTE_TS
echo "✔ src/app/api/billing/route.ts"
mkdir -p src/app/api/billing/pay
cat > src/app/api/billing/pay/route.ts <<'EOF_SRC_APP_API_BILLING_PAY_ROUTE_TS'
import { getPool } from "@/lib/db";
import { requireTenant } from "@/lib/auth/guard";
import { checkOrigin, errorResponse, jsonResponse, readJson, route } from "@/lib/auth/http";
import { tokenHashOf } from "@/lib/auth/session";
import { billingErrorResponse, isStaleRate } from "@/lib/billing/errors";
import { payCreateSchema } from "@/lib/auth/validation";

/** Crea una cotización: plan + meses + método. Pago Móvil congela la tasa BCV 30 minutos. */
export const POST = route(async (req) => {
  const blocked = checkOrigin(req);
  if (blocked) return blocked;
  const auth = await requireTenant(req, "billing:manage");
  if (!auth.ok) return auth.response;
  const body = await readJson(req, payCreateSchema);
  if (!body.ok) return body.response;
  try {
    const r = await getPool().query("SELECT payment_create($1, $2, $3, $4, $5) AS id", [tokenHashOf(req)!, auth.ctx.tenantId, body.data.planId, body.data.months, body.data.method]);
    return jsonResponse({ ok: true, paymentId: r.rows[0].id }, 201);
  } catch (e) {
    if (isStaleRate(e)) return errorResponse(409, "tasa_desactualizada", "La tasa del día aún no está actualizada. Intenta en un rato o elige otro método.");
    const r = billingErrorResponse(e);
    if (r) return r;
    throw e;
  }
});
EOF_SRC_APP_API_BILLING_PAY_ROUTE_TS
echo "✔ src/app/api/billing/pay/route.ts"
mkdir -p src/app/api/billing/submit
cat > src/app/api/billing/submit/route.ts <<'EOF_SRC_APP_API_BILLING_SUBMIT_ROUTE_TS'
import { getPool } from "@/lib/db";
import { requireTenant } from "@/lib/auth/guard";
import { checkOrigin, errorResponse, jsonResponse, readJson, route } from "@/lib/auth/http";
import { tokenHashOf } from "@/lib/auth/session";
import { parseAmountToCents } from "@/lib/billing/money";
import { MAX_PROOF_BYTES, sniffImage } from "@/lib/billing/proof";
import { billingErrorResponse } from "@/lib/billing/errors";
import { paySubmitSchema } from "@/lib/auth/validation";

/** Envía el comprobante de un pago para que una persona lo confirme. */
export const POST = route(async (req) => {
  const blocked = checkOrigin(req);
  if (blocked) return blocked;
  const auth = await requireTenant(req, "billing:manage");
  if (!auth.ok) return auth.response;
  const body = await readJson(req, paySubmitSchema, { maxChars: 3_000_000 });
  if (!body.ok) return body.response;
  const d = body.data;
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(d.proof)) return errorResponse(400, "imagen_invalida", "La imagen del comprobante no es válida.");
  const bytes = Buffer.from(d.proof, "base64");
  if (bytes.length > MAX_PROOF_BYTES) return errorResponse(413, "imagen_grande", "La imagen pesa más de 2 MB.");
  const mime = sniffImage(bytes);
  if (!mime) return errorResponse(400, "imagen_invalida", "El comprobante debe ser una imagen JPG, PNG o WebP.");
  const cents = parseAmountToCents(d.declared);
  if (cents === null) return errorResponse(400, "monto_invalido", "No entendí el monto. Escríbelo como 1.234,56.");
  try {
    await getPool().query("SELECT payment_submit($1, $2, $3, $4, $5, $6, $7::date, $8, $9, $10)", [
      tokenHashOf(req)!, auth.ctx.tenantId, d.paymentId, d.reference, d.bank, d.phone, d.paidOn, cents, bytes, mime,
    ]);
  } catch (e) {
    const r = billingErrorResponse(e);
    if (r) return r;
    throw e;
  }
  return jsonResponse({ ok: true });
});
EOF_SRC_APP_API_BILLING_SUBMIT_ROUTE_TS
echo "✔ src/app/api/billing/submit/route.ts"
mkdir -p src/app/api/admin/payments
cat > src/app/api/admin/payments/route.ts <<'EOF_SRC_APP_API_ADMIN_PAYMENTS_ROUTE_TS'
import { getPool } from "@/lib/db";
import { requireSuperAdmin } from "@/lib/auth/guard";
import { jsonResponse, route } from "@/lib/auth/http";

const STATUSES = ["pendiente", "por_revisar", "confirmado", "rechazado", "vencido"];

/** Cola de pagos. ?status=por_revisar (por defecto). Solo súper admin. */
export const GET = route(async (req) => {
  const auth = await requireSuperAdmin(req);
  if (!auth.ok) return auth.response;
  const s = new URL(req.url).searchParams.get("status") ?? "por_revisar";
  const status = STATUSES.includes(s) ? s : "por_revisar";
  const r = await getPool().query("SELECT * FROM admin_list_payments($1, $2)", [auth.tokenHash, status]);
  return jsonResponse({
    payments: r.rows.map((x) => ({
      id: x.o_id, tenantId: x.o_tenant_id, tenantName: x.o_tenant_name, planName: x.o_plan_name, months: x.o_months, method: x.o_method,
      amountUsdCents: Number(x.o_amount_usd_cents), rate: x.o_rate === null ? null : Number(x.o_rate), amountBsCents: x.o_amount_bs_cents === null ? null : Number(x.o_amount_bs_cents),
      status: x.o_status, reference: x.o_reference, payerBank: x.o_payer_bank, payerPhone: x.o_payer_phone,
      paidOn: x.o_paid_on ? `${x.o_paid_on.getFullYear()}-${String(x.o_paid_on.getMonth() + 1).padStart(2, "0")}-${String(x.o_paid_on.getDate()).padStart(2, "0")}` : null,
      declaredCents: x.o_declared_cents === null ? null : Number(x.o_declared_cents), hasProof: x.o_has_proof,
      submittedAt: x.o_submitted_at, decidedAt: x.o_decided_at, rejectReason: x.o_reject_reason,
    })),
  });
});
EOF_SRC_APP_API_ADMIN_PAYMENTS_ROUTE_TS
echo "✔ src/app/api/admin/payments/route.ts"
mkdir -p src/app/api/admin/payments/proof
cat > src/app/api/admin/payments/proof/route.ts <<'EOF_SRC_APP_API_ADMIN_PAYMENTS_PROOF_ROUTE_TS'
import { getPool } from "@/lib/db";
import { requireSuperAdmin } from "@/lib/auth/guard";
import { errorResponse, route } from "@/lib/auth/http";

/** Imagen del comprobante. Solo súper admin. Se sirve como imagen y nada más (sin ejecutar nada). */
export const GET = route(async (req) => {
  const auth = await requireSuperAdmin(req);
  if (!auth.ok) return auth.response;
  const id = new URL(req.url).searchParams.get("id") ?? "";
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) return errorResponse(404, "no_encontrado", "No encontrado.");
  const r = await getPool().query("SELECT * FROM admin_payment_proof($1, $2)", [auth.tokenHash, id]);
  const row = r.rows[0];
  if (!row) return errorResponse(404, "no_encontrado", "No encontrado.");
  return new Response(new Uint8Array(row.o_proof as Buffer), {
    headers: {
      "content-type": row.o_mime as string,
      "x-content-type-options": "nosniff",
      "content-security-policy": "default-src 'none'; sandbox",
      "cache-control": "private, no-store",
      "content-disposition": "inline",
    },
  });
});
EOF_SRC_APP_API_ADMIN_PAYMENTS_PROOF_ROUTE_TS
echo "✔ src/app/api/admin/payments/proof/route.ts"
mkdir -p src/app/api/admin/payments/decide
cat > src/app/api/admin/payments/decide/route.ts <<'EOF_SRC_APP_API_ADMIN_PAYMENTS_DECIDE_ROUTE_TS'
import { getPool } from "@/lib/db";
import { requireSuperAdmin } from "@/lib/auth/guard";
import { checkOrigin, errorResponse, jsonResponse, readJson, route } from "@/lib/auth/http";
import { billingErrorResponse } from "@/lib/billing/errors";
import { paymentDecideSchema } from "@/lib/auth/validation";

/** Confirma o rechaza un pago por revisar. Confirmar activa el plan y suma 30 días por mes pagado. */
export const POST = route(async (req) => {
  const blocked = checkOrigin(req);
  if (blocked) return blocked;
  const auth = await requireSuperAdmin(req);
  if (!auth.ok) return auth.response;
  const body = await readJson(req, paymentDecideSchema);
  if (!body.ok) return body.response;
  const d = body.data;
  if (!d.approve && !d.reason) return errorResponse(400, "datos_invalidos", "Escribe el motivo del rechazo.");
  try {
    await getPool().query("SELECT admin_payment_decide($1, $2, $3, $4)", [auth.tokenHash, d.paymentId, d.approve, d.reason ?? null]);
  } catch (e) {
    const r = billingErrorResponse(e);
    if (r) return r;
    throw e;
  }
  return jsonResponse({ ok: true });
});
EOF_SRC_APP_API_ADMIN_PAYMENTS_DECIDE_ROUTE_TS
echo "✔ src/app/api/admin/payments/decide/route.ts"
mkdir -p src/app/api/admin/billing-settings
cat > src/app/api/admin/billing-settings/route.ts <<'EOF_SRC_APP_API_ADMIN_BILLING-SETTINGS_ROUTE_TS'
import { getPool } from "@/lib/db";
import { requireSuperAdmin } from "@/lib/auth/guard";
import { checkOrigin, errorResponse, jsonResponse, readJson, route } from "@/lib/auth/http";
import { billingSettingsSchema } from "@/lib/auth/validation";

/** Tasa BCV y datos de cobro de la plataforma. Solo súper admin. */
export const GET = route(async (req) => {
  const auth = await requireSuperAdmin(req);
  if (!auth.ok) return auth.response;
  const r = await getPool().query("SELECT admin_get_payment_settings($1) AS s", [auth.tokenHash]);
  return jsonResponse({ settings: r.rows[0].s });
});

export const POST = route(async (req) => {
  const blocked = checkOrigin(req);
  if (blocked) return blocked;
  const auth = await requireSuperAdmin(req);
  if (!auth.ok) return auth.response;
  const body = await readJson(req, billingSettingsSchema);
  if (!body.ok) return body.response;
  const d = body.data;
  try {
    await getPool().query("SELECT admin_set_payment_settings($1,$2,$3,$4,$5,$6,$7,$8,$9)", [auth.tokenHash, d.rate, d.pmBank, d.pmPhone, d.pmHolderId, d.pmHolderName, d.paypal, d.binance, d.notes]);
  } catch (e) {
    if ((e as { code?: string }).code === "22023") return errorResponse(400, "datos_invalidos", "Tasa inválida.");
    throw e;
  }
  return jsonResponse({ ok: true });
});
EOF_SRC_APP_API_ADMIN_BILLING-SETTINGS_ROUTE_TS
echo "✔ src/app/api/admin/billing-settings/route.ts"
mkdir -p src/app/api/admin/plan-price
cat > src/app/api/admin/plan-price/route.ts <<'EOF_SRC_APP_API_ADMIN_PLAN-PRICE_ROUTE_TS'
import { getPool } from "@/lib/db";
import { requireSuperAdmin } from "@/lib/auth/guard";
import { checkOrigin, errorResponse, jsonResponse, readJson, route } from "@/lib/auth/http";
import { planPriceSchema } from "@/lib/auth/validation";

/** Precio mensual en USD de un plan (null = no se vende en línea). Solo súper admin. */
export const POST = route(async (req) => {
  const blocked = checkOrigin(req);
  if (blocked) return blocked;
  const auth = await requireSuperAdmin(req);
  if (!auth.ok) return auth.response;
  const body = await readJson(req, planPriceSchema);
  if (!body.ok) return body.response;
  try {
    await getPool().query("SELECT admin_set_plan_price($1, $2, $3)", [auth.tokenHash, body.data.planId, body.data.priceCents]);
  } catch (e) {
    if ((e as { code?: string }).code === "P0002") return errorResponse(404, "no_encontrado", "Plan no encontrado.");
    throw e;
  }
  return jsonResponse({ ok: true });
});
EOF_SRC_APP_API_ADMIN_PLAN-PRICE_ROUTE_TS
echo "✔ src/app/api/admin/plan-price/route.ts"
mkdir -p src/app/api/plan
cat > src/app/api/plan/route.ts <<'EOF_SRC_APP_API_PLAN_ROUTE_TS'
import { requireTenant } from "@/lib/auth/guard";
import { jsonResponse, route } from "@/lib/auth/http";
import { withTenant } from "@/lib/db";
import { can } from "@/lib/auth/permissions";
import { loadPlanUsage, quotaState } from "@/lib/plans/usage";

/** Plan del negocio y cuánto lleva usado. Lo puede ver cualquier persona del equipo. */
export const GET = route(async (req) => {
  const auth = await requireTenant(req);
  if (!auth.ok) return auth.response;
  const u = await withTenant(auth.ctx.tenantId, (db) => loadPlanUsage(db, auth.ctx.tenantId));
  if (!u) return jsonResponse({ plan: null });
  return jsonResponse({
    ...u,
    canPay: can(auth.ctx.role, "billing:manage") && !auth.ctx.impersonating,
    repliesState: quotaState(u.repliesThisMonth, u.plan.maxRepliesMonth),
    membersState: quotaState(u.members + u.pendingInvitations, u.plan.maxMembers),
  });
});
EOF_SRC_APP_API_PLAN_ROUTE_TS
echo "✔ src/app/api/plan/route.ts"
mkdir -p src/components
cat > src/components/BillingPanel.tsx <<'EOF_SRC_COMPONENTS_BILLINGPANEL_TSX'
"use client";

import { useCallback, useEffect, useId, useState, type FormEvent } from "react";
import { compressProof } from "@/lib/billing/image";
import { formatBs, formatUsd } from "@/lib/billing/money";
import type { PaymentRow, PlanOffer, Subscription } from "@/lib/billing/data";
import { PLAN_MODULE_LABEL, type PlanModule } from "@/lib/plans/usage";

type Method = "pago_movil" | "paypal" | "binance";
interface Payee {
  pagoMovil: { banco: string; telefono: string; documento: string; titular: string | null } | null;
  paypal: string | null; binance: string | null; notas: string | null; rate: number | null; rateAt: string | null; rateFresh: boolean;
}
interface Data { offers: PlanOffer[]; payments: PaymentRow[]; subscription: Subscription | null; payee: Payee }

const METHOD_LABEL: Record<Method, string> = { pago_movil: "Pago Móvil (Bs.)", paypal: "PayPal (USD)", binance: "Binance Pay (USD)" };
const STATUS_LABEL: Record<PaymentRow["status"], string> = { pendiente: "Esperando tu pago", por_revisar: "En revisión", confirmado: "Confirmado", rechazado: "Rechazado", vencido: "Vencido" };
const SUB_LABEL: Record<string, string> = { trial: "Prueba gratis", active: "Activa", past_due: "Pago pendiente", suspended: "Suspendida" };
const fmtDate = (iso: string) => new Intl.DateTimeFormat("es-VE", { dateStyle: "medium" }).format(new Date(iso));

function Countdown({ until }: { until: string }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(t); }, []);
  const left = Math.max(0, Math.floor((new Date(until).getTime() - now) / 1000));
  if (left === 0) return <span>La cotización venció. Si ya pagaste, sube el comprobante (hay 6 horas de margen).</span>;
  const m = Math.floor(left / 60), s = left % 60;
  return <span>Paga dentro de <strong>{m}:{String(s).padStart(2, "0")}</strong> para mantener esta tasa.</span>;
}

function SubmitForm({ p, onDone }: { p: PaymentRow; onDone: () => void }) {
  const uid = useId();
  const today = new Date().toLocaleDateString("en-CA");
  const [reference, setReference] = useState("");
  const [paidOn, setPaidOn] = useState(today);
  const [bank, setBank] = useState("");
  const [phone, setPhone] = useState("");
  const [declared, setDeclared] = useState(p.method === "pago_movil" && p.amountBsCents ? (p.amountBsCents / 100).toFixed(2).replace(".", ",") : (p.amountUsdCents / 100).toFixed(2).replace(".", ","));
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function send(e: FormEvent) {
    e.preventDefault();
    if (!file) { setErr("Sube la captura o foto del comprobante."); return; }
    setBusy(true); setErr(null);
    try {
      const proof = await compressProof(file);
      const res = await fetch("/api/billing/submit", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ paymentId: p.id, reference, bank, phone, paidOn, declared, proof }) });
      const d = (await res.json().catch(() => ({}))) as { message?: string };
      if (!res.ok) { setErr(d.message ?? "No se pudo enviar."); return; }
      onDone();
    } catch (x) {
      setErr(x instanceof Error ? x.message : "Sin conexión.");
    } finally { setBusy(false); }
  }
  const pm = p.method === "pago_movil";
  return (
    <form onSubmit={send} className="mt-4 grid gap-4 md:grid-cols-2" aria-label="Enviar comprobante">
      <div className="field">
        <label htmlFor={`${uid}-ref`}>Número de referencia</label>
        <input id={`${uid}-ref`} className="input" value={reference} onChange={(e) => setReference(e.target.value)} required minLength={4} maxLength={60} autoComplete="off" />
        <span className="hint">Es el número que aparece en el comprobante de tu banco o app.</span>
      </div>
      <div className="field">
        <label htmlFor={`${uid}-date`}>Fecha del pago</label>
        <input id={`${uid}-date`} className="input" type="date" value={paidOn} max={today} onChange={(e) => setPaidOn(e.target.value)} required />
      </div>
      {pm && (
        <>
          <div className="field">
            <label htmlFor={`${uid}-bank`}>Banco desde el que pagaste</label>
            <input id={`${uid}-bank`} className="input" value={bank} onChange={(e) => setBank(e.target.value)} required maxLength={60} />
          </div>
          <div className="field">
            <label htmlFor={`${uid}-phone`}>Teléfono desde el que pagaste</label>
            <input id={`${uid}-phone`} className="input" inputMode="tel" value={phone} onChange={(e) => setPhone(e.target.value)} required maxLength={30} />
          </div>
        </>
      )}
      <div className="field">
        <label htmlFor={`${uid}-amt`}>Monto que pagaste ({pm ? "Bs." : "USD"})</label>
        <input id={`${uid}-amt`} className="input" inputMode="decimal" value={declared} onChange={(e) => setDeclared(e.target.value)} required />
      </div>
      <div className="field">
        <label htmlFor={`${uid}-file`}>Comprobante (imagen)</label>
        <input id={`${uid}-file`} className="input" type="file" accept="image/*" onChange={(e) => setFile(e.target.files?.[0] ?? null)} required />
        <span className="hint">Captura de pantalla o foto. Se reduce sola antes de enviarse.</span>
      </div>
      <div className="md:col-span-2">
        {err && <p className="alert-error mb-3" role="alert">{err}</p>}
        <button type="submit" className="btn btn-primary" disabled={busy}>{busy ? "Enviando…" : "Enviar comprobante"}</button>
      </div>
    </form>
  );
}

function PaymentCard({ p, planName, payee, onChange }: { p: PaymentRow; planName: string; payee: Payee; onChange: () => void }) {
  const pm = p.method === "pago_movil";
  return (
    <li className="card-light" aria-label={`Pago ${planName}`}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-lg">{planName} · {p.months} {p.months === 1 ? "mes" : "meses"}</h3>
        <span className="badge">{STATUS_LABEL[p.status]}</span>
      </div>
      <p className="muted mt-1 text-sm">{METHOD_LABEL[p.method]} · creado {fmtDate(p.createdAt)}</p>
      {p.status === "pendiente" && (
        <div className="mt-4">
          <p className="text-lg">
            Total a pagar: <strong>{pm && p.amountBsCents ? formatBs(p.amountBsCents) : formatUsd(p.amountUsdCents)}</strong>
            {pm && p.rate && <span className="muted text-sm"> ({formatUsd(p.amountUsdCents)} a Bs. {p.rate.toLocaleString("es-VE")} por dólar, tasa BCV)</span>}
          </p>
          <p className="muted mt-1 text-sm" role="status"><Countdown until={p.quoteExpiresAt} /></p>
          <dl className="mt-3 grid gap-1 text-sm">
            {pm && payee.pagoMovil && (
              <>
                <div><dt className="inline muted">Banco: </dt><dd className="inline"><strong>{payee.pagoMovil.banco}</strong></dd></div>
                <div><dt className="inline muted">Teléfono: </dt><dd className="inline"><strong>{payee.pagoMovil.telefono}</strong></dd></div>
                <div><dt className="inline muted">Cédula / RIF: </dt><dd className="inline"><strong>{payee.pagoMovil.documento}</strong></dd></div>
                {payee.pagoMovil.titular && <div><dt className="inline muted">Titular: </dt><dd className="inline">{payee.pagoMovil.titular}</dd></div>}
              </>
            )}
            {p.method === "paypal" && <div><dt className="inline muted">Enviar a (PayPal): </dt><dd className="inline"><strong>{payee.paypal}</strong></dd></div>}
            {p.method === "binance" && <div><dt className="inline muted">Binance Pay ID: </dt><dd className="inline"><strong>{payee.binance}</strong></dd></div>}
          </dl>
          {payee.notas && <p className="muted mt-2 text-sm">{payee.notas}</p>}
          <SubmitForm p={p} onDone={onChange} />
        </div>
      )}
      {p.status === "por_revisar" && (
        <p className="mt-3 text-sm">Recibimos tu comprobante (ref. <strong>{p.reference}</strong>). Una persona lo revisa y activa tu plan; verás el cambio aquí mismo.</p>
      )}
      {p.status === "confirmado" && <p className="mt-3 text-sm">Pago confirmado. Gracias.</p>}
      {p.status === "rechazado" && <p className="alert-warn mt-3" role="status">No pudimos confirmar este pago: {p.rejectReason}. Si ya pagaste, escríbenos con tu comprobante.</p>}
      {p.status === "vencido" && <p className="muted mt-3 text-sm">Esta cotización venció sin comprobante. Crea una nueva si quieres pagar.</p>}
    </li>
  );
}

/** Pantalla del dueño: suscripción, elegir plan, pagar y enviar comprobante. */
export function BillingPanel() {
  const uid = useId();
  const [data, setData] = useState<Data | null | undefined>(undefined);
  const [planId, setPlanId] = useState("");
  const [months, setMonths] = useState(1);
  const [method, setMethod] = useState<Method>("pago_movil");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await fetch("/api/billing", { cache: "no-store" });
      setData(r.ok ? ((await r.json()) as Data) : null);
    } catch { setData(null); }
  }, []);
  useEffect(() => {
    let off = false;
    fetch("/api/billing", { cache: "no-store" })
      .then((r) => (r.ok ? (r.json() as Promise<Data>) : null))
      .then((j) => { if (!off) setData(j); })
      .catch(() => { if (!off) setData(null); });
    return () => { off = true; };
  }, []);

  if (data === undefined) return <p className="muted-dark mt-10" role="status">Cargando…</p>;
  if (data === null) return <p className="alert-error mt-10" role="alert">No se pudo cargar. Solo el dueño del negocio puede ver esta pantalla.</p>;

  const { offers, payments, subscription, payee } = data;
  const available: Record<Method, boolean> = { pago_movil: !!payee.pagoMovil && payee.rateFresh, paypal: !!payee.paypal, binance: !!payee.binance };
  const chosenMethod: Method = available[method] ? method : (["pago_movil", "paypal", "binance"] as Method[]).find((m) => available[m]) ?? method;
  const offer = offers.find((o) => o.id === planId) ?? offers[0];
  const planNames = new Map(offers.map((o) => [o.id, o.name]));
  const usd = offer ? offer.priceUsdCents * months : 0;
  const bsPreview = payee.rate && offer ? Math.round(usd * payee.rate) : null;

  async function create(e: FormEvent) {
    e.preventDefault();
    if (!offer) return;
    setBusy(true); setErr(null);
    try {
      const res = await fetch("/api/billing/pay", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ planId: offer.id, months, method: chosenMethod }) });
      const d = (await res.json().catch(() => ({}))) as { message?: string };
      if (!res.ok) setErr(d.message ?? "No se pudo crear el pago."); else await load();
    } catch { setErr("Sin conexión."); } finally { setBusy(false); }
  }

  return (
    <div className="mt-8 grid gap-8" style={{ maxWidth: 820 }}>
      {subscription && (
        <section className="card-dark" aria-label="Tu suscripción">
          <p className="eyebrow eyebrow--dark">Tu suscripción</p>
          <h2 className="mt-2 text-xl">{subscription.planName}</h2>
          <p className="mt-2"><span className="badge">{SUB_LABEL[subscription.status] ?? subscription.status}</span></p>
          <p className="muted-dark mt-3 text-sm">
            {subscription.expiresAt
              ? subscription.daysLeft !== null && subscription.daysLeft > 0
                ? `Vence el ${fmtDate(subscription.expiresAt)} (quedan ${subscription.daysLeft} ${subscription.daysLeft === 1 ? "día" : "días"}).`
                : `Venció el ${fmtDate(subscription.expiresAt)}. Renueva para que el asistente vuelva a responder.`
              : "Sin fecha de vencimiento."}
          </p>
        </section>
      )}

      <section aria-label="Elegir plan">
        <h2 className="text-2xl">Pagar o cambiar de plan</h2>
        {offers.length === 0 ? (
          <p className="card-dark muted-dark mt-4">Todavía no hay planes a la venta. Escríbenos y lo resolvemos.</p>
        ) : (
          <form onSubmit={create} className="card-light mt-4 grid gap-5" aria-label="Nueva cotización">
            <fieldset>
              <legend className="text-sm">Plan</legend>
              <div className="mt-2 grid gap-3 md:grid-cols-2">
                {offers.map((o) => (
                  <label key={o.id} className="flex cursor-pointer gap-3 rounded-xl border p-4" style={{ borderColor: offer?.id === o.id ? "var(--color-ink)" : "rgba(19,35,34,0.2)" }}>
                    <input type="radio" name={`${uid}-plan`} checked={offer?.id === o.id} onChange={() => setPlanId(o.id)} />
                    <span>
                      <strong>{o.name}</strong> · {formatUsd(o.priceUsdCents)}/mes<br />
                      <span className="muted text-sm">
                        {o.maxRepliesMonth === null ? "Respuestas sin tope" : `${o.maxRepliesMonth.toLocaleString("es")} respuestas al mes`} · {o.maxMembers} {o.maxMembers === 1 ? "persona" : "personas"}
                        {o.modules.length > 0 && <> · {o.modules.map((m) => PLAN_MODULE_LABEL[m as PlanModule] ?? m).join(", ")}</>}
                      </span>
                    </span>
                  </label>
                ))}
              </div>
            </fieldset>
            <div className="grid gap-5 md:grid-cols-2">
              <div className="field">
                <label htmlFor={`${uid}-m`}>Meses a pagar</label>
                <select id={`${uid}-m`} className="input" value={months} onChange={(e) => setMonths(Number(e.target.value))}>
                  {[1, 2, 3, 6, 12].map((m) => <option key={m} value={m}>{m} {m === 1 ? "mes" : "meses"}</option>)}
                </select>
              </div>
              <fieldset>
                <legend className="text-sm">Método de pago</legend>
                <div className="mt-2 flex flex-col gap-2">
                  {(Object.keys(METHOD_LABEL) as Method[]).map((m) => (
                    <label key={m} className="flex items-center gap-2 text-sm" style={{ opacity: available[m] ? 1 : 0.5 }}>
                      <input type="radio" name={`${uid}-meth`} checked={chosenMethod === m} disabled={!available[m]} onChange={() => setMethod(m)} />
                      {METHOD_LABEL[m]}{!available[m] && (m === "pago_movil" && !!payee.pagoMovil ? " (tasa del día pendiente)" : " (no disponible)")}
                    </label>
                  ))}
                </div>
              </fieldset>
            </div>
            {offer && (
              <p className="text-lg">
                Total: <strong>{chosenMethod === "pago_movil" && bsPreview ? formatBs(bsPreview) : formatUsd(usd)}</strong>
                {chosenMethod === "pago_movil" && bsPreview && <span className="muted text-sm"> ({formatUsd(usd)} a la tasa BCV de hoy; se congela 30 minutos al continuar)</span>}
              </p>
            )}
            {err && <p className="alert-error" role="alert">{err}</p>}
            <div><button type="submit" className="btn btn-primary" disabled={busy || !offer || !available[chosenMethod]}>{busy ? "Creando…" : "Continuar al pago"}</button></div>
          </form>
        )}
      </section>

      {payments.length > 0 && (
        <section aria-label="Tus pagos">
          <h2 className="text-2xl">Tus pagos</h2>
          <ul className="mt-4 flex flex-col gap-4">
            {payments.map((p) => <PaymentCard key={p.id} p={p} planName={planNames.get(p.planId) ?? "Plan"} payee={payee} onChange={load} />)}
          </ul>
        </section>
      )}
    </div>
  );
}
EOF_SRC_COMPONENTS_BILLINGPANEL_TSX
echo "✔ src/components/BillingPanel.tsx"
mkdir -p src/components
cat > src/components/AdminBilling.tsx <<'EOF_SRC_COMPONENTS_ADMINBILLING_TSX'
"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useId, useState, type FormEvent } from "react";
import { amountMatches, formatBs, formatUsd } from "@/lib/billing/money";

export interface BillingSettings { rate: number | null; rateAgeHours: number | null; pmBank: string; pmPhone: string; pmHolderId: string; pmHolderName: string; paypal: string; binance: string; notes: string }
export interface PricedPlan { id: string; name: string; priceCents: number | null }
interface AdminPayment {
  id: string; tenantName: string; planName: string; months: number; method: "pago_movil" | "paypal" | "binance"; amountUsdCents: number;
  rate: number | null; amountBsCents: number | null; status: string; reference: string | null; payerBank: string | null; payerPhone: string | null;
  paidOn: string | null; declaredCents: number | null; hasProof: boolean; submittedAt: string | null; decidedAt: string | null; rejectReason: string | null;
}
const lab = { color: "var(--color-pure-white)" } as const;
const white = { background: "#fff" } as const;
const METHOD: Record<string, string> = { pago_movil: "Pago Móvil", paypal: "PayPal", binance: "Binance" };
const fmtDt = (iso: string | null) => (iso ? new Intl.DateTimeFormat("es-VE", { dateStyle: "short", timeStyle: "short" }).format(new Date(iso)) : "—");

async function post(url: string, body: unknown): Promise<{ ok: boolean; message?: string }> {
  try {
    const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const d = (await res.json().catch(() => ({}))) as { message?: string };
    return { ok: res.ok, message: d.message };
  } catch { return { ok: false, message: "Sin conexión." }; }
}

function Settings({ s }: { s: BillingSettings }) {
  const router = useRouter();
  const uid = useId();
  const [f, setF] = useState({ rate: s.rate === null ? "" : String(s.rate), pmBank: s.pmBank, pmPhone: s.pmPhone, pmHolderId: s.pmHolderId, pmHolderName: s.pmHolderName, paypal: s.paypal, binance: s.binance, notes: s.notes });
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const hours = s.rateAgeHours;
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF((v) => ({ ...v, [k]: e.target.value }));

  async function save(e: FormEvent) {
    e.preventDefault();
    setBusy(true); setMsg(null);
    const rate = f.rate.trim() === "" ? null : Number(f.rate.replace(",", "."));
    const r = await post("/api/admin/billing-settings", { ...f, rate });
    setMsg(r.ok ? { ok: true, text: "Guardado. La tasa quedó como actualizada ahora." } : { ok: false, text: r.message ?? "No se pudo guardar." });
    setBusy(false);
    if (r.ok) router.refresh();
  }
  const field = (k: keyof typeof f, label: string, extra: Record<string, unknown> = {}) => (
    <div className="field">
      <label htmlFor={`${uid}-${k}`} style={lab}>{label}</label>
      <input id={`${uid}-${k}`} className="input" style={white} value={f[k]} onChange={set(k)} {...extra} />
    </div>
  );
  return (
    <form onSubmit={save} className="card-dark mt-4 grid gap-4" aria-label="Datos de cobro">
      <div>
        <h3 className="text-lg">Tasa BCV y datos para cobrar</h3>
        <p className={hours !== null && hours <= 36 ? "muted-dark mt-1 text-sm" : "alert-warn mt-2"} role="status">
          {s.rate === null ? "No hay tasa: no se puede cobrar en bolívares." : hours !== null && hours <= 36 ? `Tasa actual: Bs. ${s.rate} (actualizada hace ${Math.floor(hours)} h).` : `La tasa tiene más de 36 h: los clientes NO pueden pagar en bolívares hasta que la actualices.`}
          {" "}Actualízala cada día: al guardar se vuelve a marcar como vigente.
        </p>
      </div>
      <div className="grid gap-4 md:grid-cols-3">
        {field("rate", "Bs. por 1 USD (tasa BCV)", { inputMode: "decimal", placeholder: "ej. 40,50" })}
        {field("pmBank", "Banco (Pago Móvil)", { maxLength: 60, placeholder: "0102 Banco de Venezuela" })}
        {field("pmPhone", "Teléfono (Pago Móvil)", { maxLength: 30 })}
        {field("pmHolderId", "Cédula / RIF", { maxLength: 30 })}
        {field("pmHolderName", "Titular", { maxLength: 80 })}
        {field("paypal", "Correo de PayPal", { maxLength: 120, type: "email" })}
        {field("binance", "Binance Pay ID", { maxLength: 80 })}
      </div>
      <div className="field">
        <label htmlFor={`${uid}-notes`} style={lab}>Nota para el cliente (opcional)</label>
        <textarea id={`${uid}-notes`} className="input" style={white} rows={2} maxLength={500} value={f.notes} onChange={set("notes")} />
      </div>
      {msg && <p className={msg.ok ? "badge" : "alert-error"} role={msg.ok ? "status" : "alert"}>{msg.text}</p>}
      <div><button type="submit" className="btn btn-primary btn-sm" disabled={busy}>{busy ? "Guardando…" : "Guardar datos de cobro"}</button></div>
    </form>
  );
}

function Prices({ plans }: { plans: PricedPlan[] }) {
  const router = useRouter();
  const uid = useId();
  const [vals, setVals] = useState<Record<string, string>>(() => Object.fromEntries(plans.map((p) => [p.id, p.priceCents === null ? "" : (p.priceCents / 100).toFixed(2)])));
  const [msg, setMsg] = useState<Record<string, string>>({});
  async function save(id: string) {
    const raw = (vals[id] ?? "").trim().replace(",", ".");
    const cents = raw === "" ? null : Math.round(Number(raw) * 100);
    if (cents !== null && (!Number.isFinite(cents) || cents < 1)) { setMsg((m) => ({ ...m, [id]: "Precio inválido." })); return; }
    const r = await post("/api/admin/plan-price", { planId: id, priceCents: cents });
    setMsg((m) => ({ ...m, [id]: r.ok ? "Guardado." : r.message ?? "No se pudo guardar." }));
    if (r.ok) router.refresh();
  }
  return (
    <div className="card-dark mt-4 grid gap-3" aria-label="Precios de los planes">
      <h3 className="text-lg">Precio mensual de cada plan (USD)</h3>
      <p className="muted-dark text-sm">Déjalo vacío para que el plan no se pueda comprar en línea (por ejemplo, planes a medida).</p>
      {plans.map((p) => (
        <div key={p.id} className="flex flex-wrap items-end gap-3">
          <div className="field" style={{ minWidth: 220 }}>
            <label htmlFor={`${uid}-${p.id}`} style={lab}>{p.name}</label>
            <input id={`${uid}-${p.id}`} className="input" style={white} inputMode="decimal" value={vals[p.id] ?? ""} onChange={(e) => setVals((v) => ({ ...v, [p.id]: e.target.value }))} placeholder="Sin venta en línea" />
          </div>
          <button type="button" className="btn btn-ghost-dark btn-sm" onClick={() => void save(p.id)}>Guardar</button>
          {msg[p.id] && <span className="text-sm" role="status">{msg[p.id]}</span>}
        </div>
      ))}
    </div>
  );
}

function Row({ p, onDone }: { p: AdminPayment; onDone: () => void }) {
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const pm = p.method === "pago_movil";
  const expected = pm ? p.amountBsCents : p.amountUsdCents;
  const matches = p.declaredCents !== null && expected !== null ? amountMatches(p.declaredCents, expected) : null;
  const fmt = (c: number) => (pm ? formatBs(c) : formatUsd(c));
  async function decide(approve: boolean) {
    if (!approve && !reason.trim()) { setErr("Escribe el motivo del rechazo."); return; }
    if (approve && !window.confirm(`¿Confirmar el pago de ${p.tenantName}? Se activa ${p.planName} por ${p.months} ${p.months === 1 ? "mes" : "meses"}.`)) return;
    setBusy(true); setErr(null);
    const r = await post("/api/admin/payments/decide", { paymentId: p.id, approve, reason: approve ? undefined : reason });
    setBusy(false);
    if (r.ok) onDone(); else setErr(r.message ?? "No se pudo.");
  }
  return (
    <li className="card-dark grid gap-4 md:grid-cols-[1fr_260px]" aria-label={`Pago de ${p.tenantName}`}>
      <div>
        <h3 className="text-lg">{p.tenantName}</h3>
        <p className="muted-dark mt-1 text-sm">{p.planName} · {p.months} {p.months === 1 ? "mes" : "meses"} · {METHOD[p.method]} · enviado {fmtDt(p.submittedAt)}</p>
        <dl className="mt-3 grid gap-1 text-sm">
          <div>Esperado: <strong>{expected !== null ? fmt(expected) : "—"}</strong>{pm && p.rate !== null && <span className="muted-dark"> ({formatUsd(p.amountUsdCents)} × {p.rate})</span>}</div>
          <div>
            Declarado: <strong>{p.declaredCents !== null ? fmt(p.declaredCents) : "—"}</strong>{" "}
            {matches === true && <span className="badge">Coincide</span>}
            {matches === false && <span className="alert-warn" style={{ padding: "2px 8px" }}>No coincide</span>}
          </div>
          <div>Referencia: <strong>{p.reference ?? "—"}</strong> · Fecha: {p.paidOn ?? "—"}</div>
          {pm && <div>Pagó desde: {p.payerBank ?? "—"} · {p.payerPhone ?? "—"}</div>}
        </dl>
        <p className="muted-dark mt-3 text-sm">Compara con tu banco: referencia, monto y fecha. El comprobante lo sube el cliente y puede ser falso; solo tu banco lo confirma.</p>
        {p.status === "por_revisar" && (
          <div className="mt-4 grid gap-2">
            <div className="flex flex-wrap gap-2">
              <button type="button" className="btn btn-primary btn-sm" disabled={busy} onClick={() => void decide(true)}>Confirmar pago</button>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <input className="input" style={{ ...white, width: 260 }} placeholder="Motivo si lo rechazas" aria-label="Motivo del rechazo" value={reason} maxLength={300} onChange={(e) => setReason(e.target.value)} />
              <button type="button" className="btn btn-ghost-dark btn-sm" disabled={busy} onClick={() => void decide(false)}>Rechazar</button>
            </div>
            {err && <p className="alert-error" role="alert">{err}</p>}
          </div>
        )}
        {p.status === "rechazado" && <p className="muted-dark mt-3 text-sm">Rechazado: {p.rejectReason}</p>}
      </div>
      {p.hasProof && (
        <a href={`/api/admin/payments/proof?id=${p.id}`} target="_blank" rel="noreferrer" aria-label="Abrir el comprobante en grande">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={`/api/admin/payments/proof?id=${p.id}`} alt={`Comprobante de ${p.tenantName}`} style={{ width: "100%", maxHeight: 320, objectFit: "contain", background: "#fff", borderRadius: 8 }} />
        </a>
      )}
    </li>
  );
}

function Queue() {
  const [status, setStatus] = useState("por_revisar");
  const [rows, setRows] = useState<AdminPayment[] | null>(null);
  const load = useCallback(async (st: string) => {
    try {
      const r = await fetch(`/api/admin/payments?status=${st}`, { cache: "no-store" });
      setRows(r.ok ? ((await r.json()) as { payments: AdminPayment[] }).payments : []);
    } catch { setRows([]); }
  }, []);
  useEffect(() => {
    let off = false;
    fetch(`/api/admin/payments?status=${status}`, { cache: "no-store" })
      .then((r) => (r.ok ? (r.json() as Promise<{ payments: AdminPayment[] }>) : { payments: [] }))
      .then((j) => { if (!off) setRows(j.payments); })
      .catch(() => { if (!off) setRows([]); });
    return () => { off = true; };
  }, [status]);
  return (
    <div className="mt-4">
      <div className="flex flex-wrap items-center gap-3">
        <label htmlFor="pay-status" className="text-sm">Ver</label>
        <select id="pay-status" className="input" style={{ ...white, width: "auto" }} value={status} onChange={(e) => { setRows(null); setStatus(e.target.value); }}>
          <option value="por_revisar">Por revisar</option>
          <option value="confirmado">Confirmados</option>
          <option value="rechazado">Rechazados</option>
          <option value="pendiente">Esperando pago</option>
          <option value="vencido">Vencidos</option>
        </select>
      </div>
      {rows === null ? <p className="muted-dark mt-4" role="status">Cargando…</p> : rows.length === 0 ? (
        <p className="card-dark muted-dark mt-4">No hay pagos en esta lista.</p>
      ) : (
        <ul className="mt-4 flex flex-col gap-4">{rows.map((p) => <Row key={p.id} p={p} onDone={() => void load(status)} />)}</ul>
      )}
    </div>
  );
}

/** Cobros del súper admin: datos y tasa, precios y cola de comprobantes. */
export function AdminBilling({ settings, plans }: { settings: BillingSettings; plans: PricedPlan[] }) {
  return (
    <section className="mt-12" aria-label="Cobros">
      <h2 className="text-2xl">Cobros</h2>
      <h3 className="mt-6 text-lg">Pagos por revisar</h3>
      <Queue />
      <Settings s={settings} />
      <Prices plans={plans} />
    </section>
  );
}
EOF_SRC_COMPONENTS_ADMINBILLING_TSX
echo "✔ src/components/AdminBilling.tsx"
mkdir -p src/components
cat > src/components/PlanCard.tsx <<'EOF_SRC_COMPONENTS_PLANCARD_TSX'
"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { PLAN_MODULES, PLAN_MODULE_LABEL, type PlanUsage, type QuotaState } from "@/lib/plans/usage";

type Data = PlanUsage & { repliesState: QuotaState; membersState: QuotaState; canPay?: boolean };

function Bar({ used, max, state, label }: { used: number; max: number | null; state: QuotaState; label: string }) {
  const pct = max === null || max === 0 ? 0 : Math.min(100, Math.round((used / max) * 100));
  const color = state === "full" ? "var(--color-danger-on-dark)" : state === "near" ? "var(--color-signal-yellow)" : "var(--color-neon-pulse)";
  return (
    <div>
      <p className="text-sm">
        {label}: <strong>{used.toLocaleString("es")}</strong> {max === null ? "(sin tope)" : `de ${max.toLocaleString("es")}`}
      </p>
      {max !== null && (
        <div role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={max} aria-valuenow={Math.min(used, max)} className="mt-2" style={{ height: 8, borderRadius: 8, background: "rgba(255,255,255,0.15)" }}>
          <div style={{ width: `${pct}%`, height: 8, borderRadius: 8, background: color }} />
        </div>
      )}
    </div>
  );
}

/** Plan del negocio y cuánto lleva usado este mes. */
export function PlanCard() {
  const [d, setD] = useState<Data | null | undefined>(undefined);
  useEffect(() => {
    let off = false;
    fetch("/api/plan", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((j: (Data & { plan: unknown }) | null) => { if (!off) setD(j && j.plan ? j : null); })
      .catch(() => { if (!off) setD(null); });
    return () => { off = true; };
  }, []);
  if (!d) return null;
  return (
    <section className="card-dark mt-8" aria-label="Tu plan" style={{ maxWidth: 720 }}>
      <p className="eyebrow eyebrow--dark">Tu plan</p>
      <h2 className="mt-2 text-xl">{d.plan.name}</h2>
      <div className="mt-4 grid gap-5 md:grid-cols-2">
        <Bar used={d.repliesThisMonth} max={d.plan.maxRepliesMonth} state={d.repliesState} label="Respuestas del asistente este mes" />
        <Bar used={d.members + d.pendingInvitations} max={d.plan.maxMembers} state={d.membersState} label="Personas del equipo (con invitaciones)" />
      </div>
      {d.repliesState === "full" && (
        <p className="alert-warn mt-4" role="alert">
          Llegaste al tope mensual de tu plan: el asistente dejó de responder y las conversaciones nuevas pasan a una persona. Se renueva el día 1 de cada mes.
        </p>
      )}
      {d.repliesState === "near" && (
        <p className="alert-warn mt-4" role="status">Estás cerca del tope mensual de respuestas de tu plan.</p>
      )}
      <p className="muted-dark mt-4 text-sm">
        Incluye: {d.plan.modules.length ? d.plan.modules.map((m) => PLAN_MODULE_LABEL[m]).join(", ") : "solo atención"}.
        {PLAN_MODULES.some((m) => !d.plan.modules.includes(m)) && (
          <> No incluye: {PLAN_MODULES.filter((m) => !d.plan.modules.includes(m)).map((m) => PLAN_MODULE_LABEL[m]).join(", ")}.</>
        )}
      </p>
      {d.canPay && (
        <p className="mt-4"><Link href="/plan" className="btn btn-ghost-dark btn-sm">Pagar o cambiar de plan</Link></p>
      )}
    </section>
  );
}
EOF_SRC_COMPONENTS_PLANCARD_TSX
echo "✔ src/components/PlanCard.tsx"
mkdir -p src/app/plan
cat > src/app/plan/page.tsx <<'EOF_SRC_APP_PLAN_PAGE_TSX'
import type { Metadata } from "next";
import { headers } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { Suspense } from "react";
import { AppHeader, ROLE_LABEL } from "@/components/AppHeader";
import { BillingPanel } from "@/components/BillingPanel";
import { can } from "@/lib/auth/permissions";
import { effectiveTenant, getSessionFromHeaders } from "@/lib/auth/session";

export const metadata: Metadata = { title: "Plan y pagos" };

export default function PlanPage() {
  return (
    <Suspense fallback={<div className="container-app py-24 muted-dark" role="status">Cargando…</div>}>
      <PlanContent />
    </Suspense>
  );
}

async function PlanContent() {
  const auth = await getSessionFromHeaders(await headers());
  if (!auth) redirect("/entrar");
  const { session } = auth;
  if (session.needsMfaSetup) redirect("/seguridad");
  const ctx = effectiveTenant(session);
  if (!ctx || ctx.impersonating || !can(ctx.role, "billing:manage")) notFound();
  return (
    <div className="flex min-h-screen flex-col">
      <AppHeader email={session.email} roleLabel={ROLE_LABEL[ctx.role]} showAdmin={session.isSuperAdmin} showTeam />
      <main className="container-app flex-1 pb-24 pt-8">
        <p className="eyebrow eyebrow--dark">Tu negocio</p>
        <h1 className="mt-3 text-[32px] sm:text-[48px]">Plan y pagos</h1>
        <BillingPanel />
      </main>
    </div>
  );
}
EOF_SRC_APP_PLAN_PAGE_TSX
echo "✔ src/app/plan/page.tsx"
mkdir -p src/app/admin
cat > src/app/admin/page.tsx <<'EOF_SRC_APP_ADMIN_PAGE_TSX'
import { AdminBilling } from "@/components/AdminBilling";
import { PlanEditor } from "@/components/PlanEditor";
import { rowToPlan } from "@/lib/plans/usage";
import type { Metadata } from "next";
import { headers } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { Suspense } from "react";
import { AppHeader } from "@/components/AppHeader";
import { TenantActions } from "@/components/TenantActions";
import { getPool } from "@/lib/db";
import { getSessionFromHeaders } from "@/lib/auth/session";

export const metadata: Metadata = { title: "Administración" };

const STATUS_LABEL: Record<string, string> = {
  trial: "Prueba",
  active: "Activa",
  past_due: "Pago pendiente",
  suspended: "Suspendida",
};

export default function AdminPage() {
  return (
    <Suspense fallback={<div className="container-app py-24 muted-dark" role="status">Cargando…</div>}>
      <AdminContent />
    </Suspense>
  );
}

async function AdminContent() {
  const auth = await getSessionFromHeaders(await headers());
  // Defensa en profundidad: el proxy ya responde 404 real a quien no es súper admin; aquí se repite la comprobación.
  if (!auth) notFound();
  if (auth.session.needsMfaSetup) redirect("/seguridad"); // súper admin sin 2FA
  if (!auth.session.isSuperAdmin) notFound(); // para el resto, esta página "no existe"

  const r = await getPool().query("SELECT * FROM admin_list_tenants($1)", [auth.tokenHash]);
  const planRows = (await getPool().query("SELECT * FROM plans ORDER BY position, name")).rows;
  const plans = planRows.map((r) => ({ ...rowToPlan(r), active: Boolean(r.active), isDefault: Boolean(r.is_default) }));
  const st = (await getPool().query("SELECT admin_get_payment_settings($1) AS s", [auth.tokenHash])).rows[0].s as Record<string, string | number | null>;
  const billing = {
    rate: st.bcv_rate === null ? null : Number(st.bcv_rate), rateAgeHours: st.rate_age_hours === null || st.rate_age_hours === undefined ? null : Number(st.rate_age_hours),
    pmBank: String(st.pm_bank ?? ""), pmPhone: String(st.pm_phone ?? ""), pmHolderId: String(st.pm_holder_id ?? ""), pmHolderName: String(st.pm_holder_name ?? ""),
    paypal: String(st.paypal_email ?? ""), binance: String(st.binance_id ?? ""), notes: String(st.notes ?? ""),
  };
  const priced = planRows.map((r) => ({ id: String(r.id), name: String(r.name), priceCents: r.price_usd_cents === null ? null : Number(r.price_usd_cents) }));
  const fmt = new Intl.DateTimeFormat("es-VE", { dateStyle: "medium" });

  return (
    <div className="flex min-h-screen flex-col">
      <AppHeader email={auth.session.email} roleLabel="Súper admin" showWork={false} />
      <main className="container-app flex-1 pb-24 pt-8">
        <p className="eyebrow eyebrow--dark">Solo súper admin</p>
        <h1 className="mt-3 text-[32px] sm:text-[48px]">Administración</h1>
        <p className="muted-dark mt-3 max-w-xl text-sm">
          Entrar como soporte exige un motivo, dura 30 minutos como máximo y queda en el registro de auditoría del negocio.
        </p>

        <PlanEditor plans={plans} />

        <AdminBilling settings={billing} plans={priced} />

        <h2 className="mt-12 text-2xl">Negocios</h2>
        {r.rows.length === 0 ? (
          <p className="card-dark mt-10 muted-dark">Todavía no hay negocios registrados.</p>
        ) : (
          <ul className="mt-10 flex flex-col gap-4">
            {r.rows.map((t) => (
              <li key={t.t_id} className="card-dark grid gap-4 md:grid-cols-[1fr_auto] md:items-start">
                <div>
                  <h2 className="text-xl">{t.t_name}</h2>
                  <p className="muted-dark mt-1 text-sm">
                    {t.t_slug} · {Number(t.t_members)} {Number(t.t_members) === 1 ? "persona" : "personas"} · creado {fmt.format(t.t_created_at)}
                  </p>
                  <p className="mt-3">
                    <span className="badge">{STATUS_LABEL[t.t_status] ?? t.t_status}</span>
                  </p>
                </div>
                <TenantActions tenantId={t.t_id} status={t.t_status} planId={t.t_plan_id} plans={plans.map((p) => ({ id: p.id, name: p.name, active: p.active }))} />
              </li>
            ))}
          </ul>
        )}
      </main>
    </div>
  );
}
EOF_SRC_APP_ADMIN_PAGE_TSX
echo "✔ src/app/admin/page.tsx"
mkdir -p src/worker
cat > src/worker/index.ts <<'EOF_SRC_WORKER_INDEX_TS'
import { Worker } from "bullmq";
import { getPool } from "@/lib/db";
import { getEmbeddingsEnv, getLlmEnv, getSendMode } from "@/lib/env";
import { QUEUE_NAME, createWorkerConnection, queuePrefix } from "@/lib/queue/connection";
import { closeLockClient } from "@/lib/queue/lock";
import { closeProducer } from "@/lib/queue/producer";
import { processInbound } from "@/lib/queue/process";
import { sweepPending } from "@/lib/queue/sweeper";
import { createInboundHandler, onJobFailed } from "./handler";
import { indexPending } from "./kb";
import { deliverDue } from "@/lib/webhooks/deliver";
import { sendDue } from "@/lib/notifications/send";
import { tickAutomations } from "@/lib/automations/tick";

const handler = createInboundHandler();

const CONCURRENCY = 5;
const SWEEP_EVERY_MS = 30_000;

const connection = createWorkerConnection();
const worker = new Worker(QUEUE_NAME, (job) => processInbound(job.data, handler), {
  connection,
  prefix: queuePrefix(),
  concurrency: CONCURRENCY,
});

worker.on("completed", (job, result) => {
  console.log(`[worker] trabajo ${job.id} → ${String(result)}`);
});
worker.on("failed", (job, err) => void onJobFailed(job, err));
worker.on("error", (err) => console.error("[worker] error:", err.message));

let sweeping = false;
async function sweep() {
  if (sweeping) return;
  sweeping = true;
  try {
    const n = await sweepPending();
    if (n > 0) console.log(`[worker] barrendero: ${n} mensajes pendientes reencolados`);
  } catch (err) {
    console.error("[worker] barrendero falló:", err instanceof Error ? err.message : err);
  } finally {
    sweeping = false;
  }
}
void sweep();
const timer = setInterval(sweep, SWEEP_EVERY_MS);

// Indexado de documentos de la base de conocimiento (cada pocos segundos; la cola vive en Postgres).
const KB_EVERY_MS = 5_000;
let indexing = false;
async function indexKb() {
  if (indexing || closing) return;
  indexing = true;
  try {
    await indexPending();
  } catch (err) {
    console.error("[worker] indexado de conocimiento falló:", err instanceof Error ? err.message : err);
  } finally {
    indexing = false;
  }
}
const kbTimer = setInterval(() => void indexKb(), KB_EVERY_MS);

// Avisos (webhooks) a otros sistemas: la cola vive en Postgres; se revisa cada pocos segundos.
const WEBHOOK_EVERY_MS = 3_000;
let delivering = false;
async function deliverWebhooks() {
  if (delivering || closing) return;
  delivering = true;
  try {
    // Mientras haya entregas vencidas se sigue sin esperar al siguiente turno (hasta un tope por vuelta).
    for (let i = 0; i < 10 && !closing; i++) {
      const c = await deliverDue(5);
      if (c.delivered + c.retry + c.failed + c.skipped === 0) break;
    }
  } catch (err) {
    console.error("[worker] avisos (webhooks) falló:", err instanceof Error ? err.message : err);
  } finally {
    delivering = false;
  }
}
const webhookTimer = setInterval(() => void deliverWebhooks(), WEBHOOK_EVERY_MS);

// Avisos automáticos a clientes por WhatsApp (los crean las reglas de «Automatizaciones»).
const NOTIFY_EVERY_MS = 3_000;
let notifying = false;
async function sendNotifications() {
  if (notifying || closing) return;
  notifying = true;
  try {
    for (let i = 0; i < 10 && !closing; i++) {
      const c = await sendDue(5);
      if (c.sent + c.retry + c.omitted + c.failed + c.skipped === 0) break;
    }
  } catch (err) {
    console.error("[worker] avisos a clientes falló:", err instanceof Error ? err.message : err);
  } finally {
    notifying = false;
  }
}
const notifyTimer = setInterval(() => void sendNotifications(), NOTIFY_EVERY_MS);

// Reglas por tiempo («24 h antes de una cita», «pedido sin confirmar»): se revisan cada 30 s solo los negocios que las usan.
let ticking = false;
async function tickTime() {
  if (ticking || closing) return;
  ticking = true;
  try {
    await tickAutomations();
  } catch (err) {
    console.error("[worker] reglas por tiempo falló:", err instanceof Error ? err.message : err);
  } finally {
    ticking = false;
  }
}
const tickTimer = setInterval(() => void tickTime(), 15_000);

// Suscripciones: quien no renovó pasa a «pago pendiente» (no responde a clientes hasta que pague). Cada 10 min.
let expiring = false;
async function expireSubs() {
  if (expiring || closing) return;
  expiring = true;
  try {
    const r = await getPool().query("SELECT expire_subscriptions() AS n");
    if (Number(r.rows[0].n) > 0) console.log(`[worker] ${r.rows[0].n} suscripción(es) vencida(s)`);
  } catch (err) {
    console.error("[worker] vencimientos falló:", err instanceof Error ? err.message : err);
  } finally {
    expiring = false;
  }
}
const expireTimer = setInterval(() => void expireSubs(), 600_000);
setTimeout(() => void expireSubs(), 5_000);

let closing = false;
async function shutdown(signal: string) {
  if (closing) return;
  closing = true;
  console.log(`[worker] ${signal}: cerrando con calma…`);
  clearInterval(timer);
  clearInterval(kbTimer);
  clearInterval(webhookTimer);
  clearInterval(notifyTimer);
  clearInterval(tickTimer);
  clearInterval(expireTimer);
  try {
    await worker.close();
    await closeProducer();
    await closeLockClient();
    connection.disconnect();
    await getPool().end();
  } finally {
    process.exit(0);
  }
}
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

const sendMode = getSendMode();
const llmProvider = getLlmEnv().LLM_PROVIDER;
if (sendMode === "simulate") console.warn("[worker] ⚠ MODO SIMULACIÓN: las respuestas NO se envían a WhatsApp (solo se ven en /simulador).");
if (getEmbeddingsEnv().EMBEDDINGS_PROVIDER === "fake") console.warn("[worker] ⚠ Embeddings de prueba (fake): la búsqueda en documentos solo coincide por palabras, no por significado.");
if (llmProvider === "mock") console.warn("[worker] ⚠ IA en modo de prueba (mock): se responde con un texto fijo, no hay modelo conectado.");
console.log(`[worker] listo: escuchando la cola "${QUEUE_NAME}" (concurrencia ${CONCURRENCY})`);
EOF_SRC_WORKER_INDEX_TS
echo "✔ src/worker/index.ts"
mkdir -p tests
cat > tests/billing.test.ts <<'EOF_TESTS_BILLING_TEST_TS'
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GET as billingGet } from "@/app/api/billing/route";
import { POST as billingPay } from "@/app/api/billing/pay/route";
import { POST as billingSubmit } from "@/app/api/billing/submit/route";
import { GET as adminPayments } from "@/app/api/admin/payments/route";
import { GET as adminProof } from "@/app/api/admin/payments/proof/route";
import { POST as adminDecide } from "@/app/api/admin/payments/decide/route";
import { GET as settingsGet, POST as settingsPost } from "@/app/api/admin/billing-settings/route";
import { POST as planPrice } from "@/app/api/admin/plan-price/route";
import { POST as login } from "@/app/api/auth/login/route";
import { POST as signup } from "@/app/api/auth/signup/route";
import { POST as verify2fa } from "@/app/api/auth/2fa/verify/route";
import { GET as me } from "@/app/api/me/route";
import { hashPassword } from "@/lib/auth/password";
import { getPool, withTenant } from "@/lib/db";
import { tokenHashOf } from "@/lib/auth/session";
import { amountMatches, formatBs, formatUsd, parseAmountToCents } from "@/lib/billing/money";
import { sniffImage } from "@/lib/billing/proof";
import { codeFor, enableMfaDirect } from "./mfa-helpers";

const RUN = randomUUID().slice(0, 8);
const ORIGIN = new URL(process.env.APP_URL!).origin;
const PASSWORD = "contraseña-de-prueba-123";
const owner = new Pool({ connectionString: process.env.MIGRATION_DATABASE_URL, max: 3 });
const tenantIds: string[] = [];
const planIds: string[] = [];
let admin = "";
let planId = "";
let oldSettings: Record<string, unknown> = {};

const req = (method: string, path: string, cookie?: string, body?: unknown) =>
  new Request(`${ORIGIN}${path}`, { method, headers: { origin: ORIGIN, ...(body !== undefined ? { "content-type": "application/json" } : {}), ...(cookie ? { cookie } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
const cookieOf = (res: Response) => (res.headers.get("set-cookie") ?? "").split(";")[0]!;

async function register(name: string) {
  const res = await signup(req("POST", "/api/auth/signup", undefined, { email: `bl-${RUN}-${name}@example.test`, password: PASSWORD, businessName: `Negocio ${name}` }));
  expect(res.status).toBe(201);
  const cookie = cookieOf(res);
  const info = await (await me(req("GET", "/api/me", cookie))).json();
  tenantIds.push(info.tenant.id);
  return { cookie, tenantId: info.tenant.id as string };
}
type T = Awaited<ReturnType<typeof register>>;

async function makeSuperAdmin() {
  const addr = `bl-${RUN}-admin@example.test`;
  const ins = await owner.query<{ id: string }>("INSERT INTO users (email, password_hash, is_super_admin) VALUES ($1,$2,true) RETURNING id", [addr, await hashPassword(PASSWORD)]);
  const secret = await enableMfaDirect(owner, ins.rows[0]!.id);
  const res = await login(req("POST", "/api/auth/login", undefined, { email: addr, password: PASSWORD }));
  const ver = await verify2fa(req("POST", "/api/auth/2fa/verify", cookieOf(res), { code: codeFor(secret) }));
  expect(ver.status).toBe(200);
  return cookieOf(ver);
}

// Imágenes mínimas válidas (cabeceras reales).
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(200, 7)]);
const JPG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(200, 9)]);
const today = () => new Date().toISOString().slice(0, 10);
const daysAgo = (n: number) => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);

const SETTINGS: { rate: number | null; pmBank: string; pmPhone: string; pmHolderId: string; pmHolderName: string; paypal: string; binance: string; notes: string } = { rate: 40.5, pmBank: "0102 Banco de Venezuela", pmPhone: "0414-1234567", pmHolderId: "J-12345678-9", pmHolderName: "Mi Empresa C.A.", paypal: "pagos@example.test", binance: "123456789", notes: "" };
const setSettings = async (s: Partial<typeof SETTINGS> = {}) => expect((await settingsPost(req("POST", "/api/admin/billing-settings", admin, { ...SETTINGS, ...s }))).status).toBe(200);

async function pay(t: T, method: "pago_movil" | "paypal" | "binance" = "pago_movil", months = 1, pid = planId) {
  return billingPay(req("POST", "/api/billing/pay", t.cookie, { planId: pid, months, method }));
}
async function payId(t: T, method: "pago_movil" | "paypal" | "binance" = "pago_movil", months = 1) {
  const r = await pay(t, method, months);
  expect(r.status).toBe(201);
  return (await r.json()).paymentId as string;
}
type PayRow = { id: string; amountUsdCents: number; rate: number | null; amountBsCents: number | null; status: string; quoteExpiresAt: string; reference: string | null; declaredCents: number | null; paidOn: string | null; rejectReason: string | null };
const payments = async (t: T) => (await (await billingGet(req("GET", "/api/billing", t.cookie))).json()).payments as PayRow[];
const submit = (t: T, paymentId: string, o: Record<string, unknown> = {}) =>
  billingSubmit(req("POST", "/api/billing/submit", t.cookie, { paymentId, reference: `REF${randomUUID().replace(/-/g, "").slice(0, 10)}`, bank: "0134 Banesco", phone: "04141112233", paidOn: today(), declared: "40,50", proof: PNG.toString("base64"), ...o }));
const decide = (paymentId: string, approve: boolean, reason?: string) => adminDecide(req("POST", "/api/admin/payments/decide", admin, { paymentId, approve, reason }));
const tenantRow = (t: T) => withTenant(t.tenantId, async (db) => (await db.query("SELECT plan_id, plan_expires_at, status FROM tenants WHERE id = $1", [t.tenantId])).rows[0]);
const hash = (cookie: string) => tokenHashOf(req("GET", "/", cookie))!;

beforeAll(async () => {
  await getPool().query("SELECT 1");
  admin = await makeSuperAdmin();
  oldSettings = (await owner.query("SELECT * FROM platform_settings")).rows[0];
  const p = await owner.query<{ id: string }>("INSERT INTO plans (slug, name, position, max_replies_month, max_members, modules, price_usd_cents) VALUES ($1,'Plan cobro',97,500,4,'{agenda}',1000) RETURNING id", [`bl-${RUN}`]);
  planId = p.rows[0]!.id;
  planIds.push(planId);
  await setSettings();
});
afterAll(async () => {
  await owner.query("DELETE FROM users WHERE email LIKE $1", [`bl-${RUN}-%`]);
  for (const id of tenantIds) {
    const c = await owner.connect();
    try {
      await c.query("BEGIN");
      await c.query("SELECT set_config('app.tenant_id', $1, true)", [id]);
      await c.query("ALTER TABLE audit_log DISABLE TRIGGER audit_log_sin_cambios");
      await c.query("DELETE FROM audit_log WHERE tenant_id = $1", [id]);
      await c.query("ALTER TABLE audit_log ENABLE TRIGGER audit_log_sin_cambios");
      await c.query("DELETE FROM tenants WHERE id = $1", [id]);
      await c.query("COMMIT");
    } catch (e) { await c.query("ROLLBACK"); throw e; } finally { c.release(); }
  }
  // La tasa y los datos de cobro vuelven a como estaban.
  const o = oldSettings as Record<string, unknown>;
  await owner.query("UPDATE platform_settings SET bcv_rate=$1, bcv_rate_at=$2, pm_bank=$3, pm_phone=$4, pm_holder_id=$5, pm_holder_name=$6, paypal_email=$7, binance_id=$8, notes=$9", [o.bcv_rate, o.bcv_rate_at, o.pm_bank, o.pm_phone, o.pm_holder_id, o.pm_holder_name, o.paypal_email, o.binance_id, o.notes]);
  if (planIds.length) await owner.query("DELETE FROM plans WHERE id = ANY($1)", [planIds]);
  await owner.end();
});

describe("montos y comprobantes (funciones puras)", () => {
  it("lee montos escritos de varias formas", () => {
    const ok: Array<[string, number]> = [["40,50", 4050], ["40.50", 4050], ["1.234,56", 123456], ["1,234.56", 123456], ["1.234", 123400], ["12", 1200], ["Bs. 7,5", 750], ["$ 10", 1000], ["0,01", 1], ["1234567,89", 123456789]];
    for (const [i, c] of ok) expect(parseAmountToCents(i), i).toBe(c);
    for (const bad of ["", "abc", "0", "0,00", "-5", "1,2,3x", "12,345", "1.2.3,4,5", "9999999999999999", "1234567890123"]) expect(parseAmountToCents(bad), bad).toBeNull();
  });
  it("formatea dólares y bolívares", () => {
    expect(formatUsd(1050)).toBe("$10,50");
    expect(formatBs(123456)).toBe("Bs. 1.234,56");
  });
  it("tolera 1 % entre lo declarado y lo esperado", () => {
    expect(amountMatches(4050, 4050)).toBe(true);
    expect(amountMatches(4040, 4050)).toBe(true);
    expect(amountMatches(4000, 4050)).toBe(false);
    expect(amountMatches(5000, 4050)).toBe(false);
    expect(amountMatches(1, 1)).toBe(true);
  });
  it("reconoce la imagen por sus primeros bytes", () => {
    expect(sniffImage(PNG)).toBe("image/png");
    expect(sniffImage(JPG)).toBe("image/jpeg");
    expect(sniffImage(Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WEBP"), Buffer.alloc(8)]))).toBe("image/webp");
    expect(sniffImage(Buffer.from("<svg onload=alert(1)>"))).toBeNull();
    expect(sniffImage(Buffer.from("%PDF-1.4 ...."))).toBeNull();
    expect(sniffImage(new Uint8Array([0xff, 0xd8]))).toBeNull();
    expect(sniffImage(Buffer.concat([Buffer.from([0xff, 0x00, 0x00]), Buffer.alloc(50)]))).toBeNull();
    expect(sniffImage(Buffer.concat([Buffer.from([0xff, 0xd8, 0x00]), Buffer.alloc(50)]))).toBeNull();
    expect(sniffImage(Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x00, 0x00]), Buffer.alloc(50)]))).toBeNull();
    expect(sniffImage(Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x00, 0x1a, 0x0a]), Buffer.alloc(50)]))).toBeNull();
    expect(sniffImage(Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WAVE"), Buffer.alloc(8)]))).toBeNull();
    expect(sniffImage(Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WEBX"), Buffer.alloc(8)]))).toBeNull();
  });
});

describe("cotización", () => {
  it("Pago Móvil: el monto en Bs sale de la tasa del momento y queda congelado", async () => {
    const t = await register("quote");
    await setSettings({ rate: 40.5 });
    const id = await payId(t, "pago_movil", 2);
    const row = (await payments(t)).find((p) => p.id === id)!;
    expect(row.amountUsdCents).toBe(2000);
    expect(row.rate).toBe(40.5);
    expect(row.amountBsCents).toBe(81000); // 20,00 USD × 40,50
    expect(row.status).toBe("pendiente");
    const mins = (new Date(row.quoteExpiresAt).getTime() - Date.now()) / 60000;
    expect(mins).toBeGreaterThan(28);
    expect(mins).toBeLessThanOrEqual(30);
    await setSettings({ rate: 99 });
    const again = (await payments(t)).find((p) => p.id === id)!;
    expect(again.rate).toBe(40.5);
    expect(again.amountBsCents).toBe(81000);
    await setSettings();
  });
  it("redondea al céntimo", async () => {
    const t = await register("round");
    await setSettings({ rate: 36.1236 });
    const id = await payId(t, "pago_movil", 1);
    expect((await payments(t)).find((p) => p.id === id)!.amountBsCents).toBe(Math.round(1000 * 36.1236));
    await setSettings();
  });
  it("PayPal y Binance: sin tasa, 24 h para pagar", async () => {
    const t = await register("intl");
    const id = await payId(t, "paypal");
    const row = (await payments(t)).find((p) => p.id === id)!;
    expect(row.rate).toBeNull();
    expect(row.amountBsCents).toBeNull();
    expect((new Date(row.quoteExpiresAt).getTime() - Date.now()) / 3600000).toBeGreaterThan(23);
  });
  it("con la tasa de hace más de 36 h NO se cotiza en bolívares", async () => {
    const t = await register("stale");
    await owner.query("UPDATE platform_settings SET bcv_rate_at = now() - interval '37 hours'");
    const r = await pay(t, "pago_movil");
    expect(r.status).toBe(409);
    expect((await r.json()).error).toBe("tasa_desactualizada");
    expect((await pay(t, "paypal")).status).toBe(201);
    expect((await (await billingGet(req("GET", "/api/billing", t.cookie))).json()).payee.rateFresh).toBe(false);
    await owner.query("UPDATE platform_settings SET bcv_rate_at = now() - interval '35 hours'");
    expect((await (await billingGet(req("GET", "/api/billing", t.cookie))).json()).payee.rateFresh).toBe(true);
    expect((await pay(t, "pago_movil")).status).toBe(201);
    await setSettings();
  });
  it("sin tasa o sin datos del método, ese método no está disponible", async () => {
    const t = await register("nometh");
    await setSettings({ rate: null });
    expect((await pay(t, "pago_movil")).status).toBe(409);
    await setSettings({ pmPhone: "", paypal: "", binance: "" });
    for (const m of ["pago_movil", "paypal", "binance"] as const) {
      const r = await pay(t, m);
      expect(r.status).toBe(409);
      expect(["metodo_no_disponible", "tasa_desactualizada"]).toContain((await r.json()).error);
    }
    await setSettings();
  });
  it("planes sin precio o inactivos no se pueden comprar; meses fuera de rango no pasan", async () => {
    const t = await register("badplan");
    const free = await owner.query<{ id: string }>("INSERT INTO plans (slug, name, position, max_members, modules) VALUES ($1,'Sin precio',96,2,'{}') RETURNING id", [`bl-free-${RUN}`]);
    planIds.push(free.rows[0]!.id);
    expect((await pay(t, "paypal", 1, free.rows[0]!.id)).status).toBe(404);
    expect((await pay(t, "paypal", 1, randomUUID())).status).toBe(404);
    expect((await pay(t, "paypal", 0)).status).toBe(400);
    expect((await pay(t, "paypal", 13)).status).toBe(400);
    expect((await billingPay(req("POST", "/api/billing/pay", t.cookie, { planId, months: 1, method: "efectivo" }))).status).toBe(400);
    await owner.query("UPDATE plans SET active = false WHERE id = $1", [planId]);
    expect((await pay(t, "paypal")).status).toBe(404);
    await owner.query("UPDATE plans SET active = true WHERE id = $1", [planId]);
  });
  it("máximo 3 pagos abiertos por negocio", async () => {
    const t = await register("max3");
    for (let i = 0; i < 3; i++) await payId(t, "paypal");
    const r = await pay(t, "paypal");
    expect(r.status).toBe(409);
    expect((await r.json()).error).toBe("demasiados_pagos");
  });
  it("las cotizaciones sin comprobante que pasaron el plazo se cierran y liberan cupo", async () => {
    const t = await register("expire-q");
    const ids = [await payId(t, "paypal"), await payId(t, "paypal"), await payId(t, "paypal")];
    await owner.query("UPDATE payments SET quote_expires_at = now() - interval '7 hours' WHERE id = ANY($1)", [ids]);
    expect((await pay(t, "paypal")).status).toBe(201);
    const list = await payments(t);
    expect(list.filter((p) => p.status === "vencido")).toHaveLength(3);
  });
  it("la lista de planes solo trae los que tienen precio y están activos", async () => {
    const t = await register("offers");
    const d = await (await billingGet(req("GET", "/api/billing", t.cookie))).json();
    expect(d.offers.map((o: { id: string }) => o.id)).toContain(planId);
    expect(d.offers.every((o: { priceUsdCents: number }) => o.priceUsdCents > 0)).toBe(true);
    expect(d.payee.pagoMovil.telefono).toBe("0414-1234567");
    expect(d.payee.rateFresh).toBe(true);
  });
});

describe("permisos", () => {
  it("sin sesión no se ve ni se paga; el origen se revisa", async () => {
    expect((await billingGet(req("GET", "/api/billing"))).status).toBe(401);
    const t = await register("origin");
    const bad = new Request(`${ORIGIN}/api/billing/pay`, { method: "POST", headers: { origin: "https://malo.test", "content-type": "application/json", cookie: t.cookie }, body: JSON.stringify({ planId, months: 1, method: "paypal" }) });
    expect((await billingPay(bad)).status).toBe(403);
  });
  it("solo el dueño paga: un admin del equipo o una persona de otro negocio no pueden", async () => {
    const a = await register("own-a");
    const b = await register("own-b");
    const bUser = (await owner.query<{ id: string }>("SELECT id FROM users WHERE email = $1", [`bl-${RUN}-own-b@example.test`])).rows[0]!.id;
    const call = (cookie: string, tenant: string) => getPool().query("SELECT payment_create($1,$2,$3,1,'paypal')", [hash(cookie), tenant, planId]);
    await expect(call(b.cookie, a.tenantId)).rejects.toMatchObject({ code: "42501" }); // no es miembro
    await owner.query("INSERT INTO memberships (tenant_id, user_id, role) VALUES ($1,$2,'admin')", [a.tenantId, bUser]);
    await expect(call(b.cookie, a.tenantId)).rejects.toMatchObject({ code: "42501" }); // admin, no dueño
    await expect(getPool().query("SELECT payment_payee($1,$2)", [hash(b.cookie), a.tenantId])).rejects.toMatchObject({ code: "42501" });
    await expect(getPool().query("SELECT payment_submit($1,$2,$3,'ABCD1234',NULL,NULL,CURRENT_DATE,100,$4,'image/png')", [hash(b.cookie), a.tenantId, randomUUID(), PNG])).rejects.toMatchObject({ code: "42501" });
    await owner.query("UPDATE memberships SET role = 'agent' WHERE tenant_id = $1 AND user_id = $2", [a.tenantId, bUser]);
    await expect(call(b.cookie, a.tenantId)).rejects.toMatchObject({ code: "42501" });
    await owner.query("DELETE FROM memberships WHERE tenant_id = $1 AND user_id = $2", [a.tenantId, bUser]);
    await expect(call(a.cookie, a.tenantId)).resolves.toBeDefined(); // el dueño sí
  });
  it("un negocio no ve los pagos de otro y no puede tocar la tabla", async () => {
    const a = await register("iso-a");
    const b = await register("iso-b");
    const id = await payId(a, "paypal");
    expect((await payments(b)).map((p) => p.id)).not.toContain(id);
    await expect(withTenant(b.tenantId, (db) => db.query("SELECT proof FROM payments"))).rejects.toMatchObject({ code: "42501" });
    await expect(withTenant(b.tenantId, (db) => db.query("SELECT * FROM payments"))).rejects.toMatchObject({ code: "42501" });
    await expect(withTenant(a.tenantId, (db) => db.query("UPDATE payments SET status = 'confirmado' WHERE id = $1", [id]))).rejects.toMatchObject({ code: "42501" });
    await expect(withTenant(a.tenantId, (db) => db.query("INSERT INTO payments (tenant_id, plan_id, months, method, amount_usd_cents, quote_expires_at) VALUES ($1,$2,1,'paypal',100,now())", [a.tenantId, planId]))).rejects.toMatchObject({ code: "42501" });
    await expect(withTenant(a.tenantId, (db) => db.query("SELECT * FROM platform_settings"))).rejects.toMatchObject({ code: "42501" });
    const own = await withTenant(a.tenantId, async (db) => (await db.query("SELECT id, status FROM payments WHERE id = $1", [id])).rows);
    expect(own).toHaveLength(1);
  });
  it("el negocio no puede cambiar su vencimiento ni su plan por su cuenta", async () => {
    const t = await register("guard");
    await expect(withTenant(t.tenantId, (db) => db.query("UPDATE tenants SET plan_expires_at = now() + interval '5 years' WHERE id = $1", [t.tenantId]))).rejects.toMatchObject({ code: "42501" });
  });
  it("las rutas del súper admin responden 404 a todos los demás", async () => {
    const t = await register("noadmin");
    const id = await payId(t, "paypal");
    expect((await adminPayments(req("GET", "/api/admin/payments", t.cookie))).status).toBe(404);
    expect((await adminPayments(req("GET", "/api/admin/payments"))).status).toBe(404);
    expect((await adminProof(req("GET", `/api/admin/payments/proof?id=${id}`, t.cookie))).status).toBe(404);
    expect((await decide(id, true)).status).not.toBe(404);
    expect((await adminDecide(req("POST", "/api/admin/payments/decide", t.cookie, { paymentId: id, approve: true }))).status).toBe(404);
    expect((await settingsGet(req("GET", "/api/admin/billing-settings", t.cookie))).status).toBe(404);
    expect((await settingsPost(req("POST", "/api/admin/billing-settings", t.cookie, SETTINGS))).status).toBe(404);
    expect((await planPrice(req("POST", "/api/admin/plan-price", t.cookie, { planId, priceCents: 1 }))).status).toBe(404);
  });
});

describe("enviar el comprobante", () => {
  it("camino feliz: queda por revisar con todos los datos", async () => {
    const t = await register("sub-ok");
    const id = await payId(t);
    const r = await submit(t, id, { reference: "ab-1234 5678", declared: "40,50" });
    expect(r.status).toBe(200);
    const row = (await payments(t)).find((p) => p.id === id)!;
    expect(row.status).toBe("por_revisar");
    expect(row.reference).toBe("AB12345678"); // sin símbolos, en mayúsculas
    expect(row.declaredCents).toBe(4050);
    expect(row.paidOn).toBe(today());
    expect(row).not.toHaveProperty("proof");
    const stored = await owner.query("SELECT proof, proof_mime FROM payments WHERE id = $1", [id]);
    expect(Buffer.compare(stored.rows[0].proof, PNG)).toBe(0);
    expect(stored.rows[0].proof_mime).toBe("image/png");
  });
  it("rechaza datos malos con 400", async () => {
    const t = await register("sub-bad");
    const id = await payId(t);
    const cases: Array<[string, Record<string, unknown>]> = [
      ["referencia corta", { reference: "ab" }],
      ["referencia con solo símbolos", { reference: "!!!!----" }],
      ["fecha futura", { paidOn: new Date(Date.now() + 3 * 86400000).toISOString().slice(0, 10) }],
      ["fecha de hace 5 días", { paidOn: daysAgo(5) }],
      ["fecha mal escrita", { paidOn: "ayer" }],
      ["monto ilegible", { declared: "mucho" }],
      ["monto cero", { declared: "0" }],
      ["sin banco (Pago Móvil)", { bank: "" }],
      ["sin teléfono (Pago Móvil)", { phone: "" }],
      ["imagen vacía", { proof: "" }],
      ["no es base64", { proof: "esto no es base64 ".repeat(20) }],
      ["texto disfrazado de imagen", { proof: Buffer.from("<script>alert(1)</script>".repeat(10)).toString("base64") }],
      ["SVG", { proof: Buffer.from("<svg xmlns='http://www.w3.org/2000/svg' onload='alert(1)'>" + " ".repeat(100) + "</svg>").toString("base64") }],
      ["PDF", { proof: Buffer.from("%PDF-1.4" + " ".repeat(200)).toString("base64") }],
    ];
    for (const [name, o] of cases) {
      const r = await submit(t, id, o);
      expect(r.status, name).toBe(400);
    }
    expect((await payments(t)).find((p) => p.id === id)!.status).toBe("pendiente");
  });
  it("imagen de más de 2 MB: 413", async () => {
    const t = await register("sub-big");
    const id = await payId(t);
    const big = Buffer.concat([PNG, Buffer.alloc(2 * 1024 * 1024)]);
    const r = await submit(t, id, { proof: big.toString("base64") });
    expect(r.status).toBe(413);
  });
  it("JPG también vale; en PayPal no hacen falta banco ni teléfono", async () => {
    const t = await register("sub-jpg");
    const id = await payId(t, "paypal");
    expect((await submit(t, id, { bank: "", phone: "", proof: JPG.toString("base64"), declared: "10" })).status).toBe(200);
    const r = await owner.query("SELECT proof_mime FROM payments WHERE id = $1", [id]);
    expect(r.rows[0].proof_mime).toBe("image/jpeg");
  });
  it("no se envía dos veces ni se envía algo que no existe o es de otro negocio", async () => {
    const t = await register("sub-twice");
    const other = await register("sub-other");
    const id = await payId(t);
    expect((await submit(t, id)).status).toBe(200);
    expect((await submit(t, id)).status).toBe(409);
    expect((await submit(t, randomUUID())).status).toBe(404);
    expect((await submit(other, id)).status).toBe(404);
  });
  it("la misma referencia no sirve dos veces (ni en otro negocio) mientras esté en revisión o confirmada", async () => {
    const a = await register("ref-a");
    const b = await register("ref-b");
    const ida = await payId(a);
    const idb = await payId(b);
    expect((await submit(a, ida, { reference: "REPETIDA9999" })).status).toBe(200);
    const r = await submit(b, idb, { reference: "repetida-9999" });
    expect(r.status).toBe(409);
    expect((await r.json()).error).toBe("referencia_repetida");
    // Otro método con la misma referencia sí es otro pago distinto.
    const idc = await payId(b, "paypal");
    expect((await submit(b, idc, { reference: "REPETIDA9999" })).status).toBe(200);
    // Si se rechaza, la referencia se libera.
    const pend = (await adminPayments(req("GET", "/api/admin/payments", admin)));
    expect(pend.status).toBe(200);
    expect((await decide(ida, false, "No aparece en el banco")).status).toBe(200);
    expect((await submit(b, idb, { reference: "REPETIDA9999" })).status).toBe(200);
  });
  it("pasada la cotización sigue valiendo 6 h; después ya no", async () => {
    const t = await register("sub-late");
    const id = await payId(t);
    await owner.query("UPDATE payments SET quote_expires_at = now() - interval '5 hours' WHERE id = $1", [id]);
    expect((await submit(t, id)).status).toBe(200);
    const id2 = await payId(t, "paypal");
    await owner.query("UPDATE payments SET quote_expires_at = now() - interval '7 hours' WHERE id = $1", [id2]);
    expect((await submit(t, id2)).status).toBe(400);
    await getPool().query("SELECT expire_subscriptions()");
    expect((await payments(t)).find((p) => p.id === id2)!.status).toBe("vencido");
  });
});

describe("revisión del súper admin", () => {
  const find = async (id: string, status = "por_revisar") => ((await (await adminPayments(req("GET", `/api/admin/payments?status=${status}`, admin))).json()).payments as Array<Record<string, unknown>>).find((p) => p.id === id);

  it("la cola muestra datos del pago, del negocio y si hay imagen; sin la imagen dentro", async () => {
    const t = await register("rev-list");
    const id = await payId(t);
    expect(await find(id)).toBeUndefined();
    await submit(t, id, { reference: "COLA00001111" });
    const p = (await find(id))!;
    expect(p).toMatchObject({ tenantName: "Negocio rev-list", planName: "Plan cobro", method: "pago_movil", amountBsCents: 40500, declaredCents: 4050, hasProof: true, reference: "COLA00001111", payerBank: "0134 Banesco" });
    expect(JSON.stringify(p)).not.toContain("proof\"");
    expect(await find(id, "confirmado")).toBeUndefined();
  });
  it("la imagen se sirve con tipo fijo y cabeceras de seguridad", async () => {
    const t = await register("rev-img");
    const id = await payId(t);
    await submit(t, id, { proof: JPG.toString("base64") });
    const r = await adminProof(req("GET", `/api/admin/payments/proof?id=${id}`, admin));
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toBe("image/jpeg");
    expect(r.headers.get("x-content-type-options")).toBe("nosniff");
    expect(r.headers.get("content-security-policy")).toContain("sandbox");
    expect(r.headers.get("cache-control")).toContain("no-store");
    expect(Buffer.compare(Buffer.from(await r.arrayBuffer()), JPG)).toBe(0);
    expect((await adminProof(req("GET", "/api/admin/payments/proof?id=../../etc/passwd", admin))).status).toBe(404);
    expect((await adminProof(req("GET", `/api/admin/payments/proof?id=${randomUUID()}`, admin))).status).toBe(404);
  });
  it("confirmar activa el plan, pone 30 días por mes y deja el negocio activo", async () => {
    const t = await register("rev-ok");
    const id = await payId(t, "pago_movil", 3);
    await submit(t, id);
    const before = await tenantRow(t);
    expect(before.status).toBe("trial");
    expect((await decide(id, true)).status).toBe(200);
    const after = await tenantRow(t);
    expect(after.plan_id).toBe(planId);
    expect(after.status).toBe("active");
    const days = (new Date(after.plan_expires_at).getTime() - Date.now()) / 86400000;
    expect(days).toBeGreaterThan(89.9);
    expect(days).toBeLessThan(90.1);
    const row = (await payments(t)).find((p) => p.id === id)!;
    expect(row.status).toBe("confirmado");
    const a = await withTenant(t.tenantId, async (db) => (await db.query("SELECT action FROM audit_log WHERE tenant_id = $1 AND action LIKE 'billing.%'", [t.tenantId])).rows);
    expect(a.map((x) => x.action)).toContain("billing.payment.confirm");
  });
  it("renovar el mismo plan suma sobre lo que queda; cambiar de plan empieza hoy", async () => {
    const t = await register("rev-renew");
    const i1 = await payId(t, "paypal", 1);
    await submit(t, i1, { declared: "10" });
    await decide(i1, true);
    const first = new Date((await tenantRow(t)).plan_expires_at).getTime();
    const i2 = await payId(t, "paypal", 1);
    await submit(t, i2, { declared: "10" });
    await decide(i2, true);
    const second = new Date((await tenantRow(t)).plan_expires_at).getTime();
    expect(Math.round((second - first) / 86400000)).toBe(30);
    // Otro plan: empieza desde hoy, no suma lo que quedaba.
    const p2 = await owner.query<{ id: string }>("INSERT INTO plans (slug, name, position, max_members, modules, price_usd_cents) VALUES ($1,'Otro',95,2,'{}',500) RETURNING id", [`bl-otro-${RUN}`]);
    planIds.push(p2.rows[0]!.id);
    const r = await pay(t, "paypal", 1, p2.rows[0]!.id);
    const i3 = (await r.json()).paymentId as string;
    await submit(t, i3, { declared: "5" });
    await decide(i3, true);
    const third = await tenantRow(t);
    expect(third.plan_id).toBe(p2.rows[0]!.id);
    expect((new Date(third.plan_expires_at).getTime() - Date.now()) / 86400000).toBeLessThan(30.1);
  });
  it("una cuenta suspendida sigue suspendida aunque se confirme el pago", async () => {
    const t = await register("rev-susp");
    const id = await payId(t, "paypal");
    await submit(t, id, { declared: "10" });
    await owner.query("SELECT set_config('app.tenant_id', $1, false)", [t.tenantId]);
    const c = await owner.connect();
    try { await c.query("SELECT set_config('app.tenant_id', $1, false)", [t.tenantId]); await c.query("UPDATE tenants SET status = 'suspended' WHERE id = $1", [t.tenantId]); await c.query("SELECT set_config('app.tenant_id', '', false)"); } finally { c.release(); }
    await decide(id, true);
    expect((await tenantRow(t)).status).toBe("suspended");
  });
  it("rechazar exige motivo, no cambia el plan y el negocio ve el motivo", async () => {
    const t = await register("rev-no");
    const id = await payId(t);
    await submit(t, id);
    const before = await tenantRow(t);
    expect((await adminDecide(req("POST", "/api/admin/payments/decide", admin, { paymentId: id, approve: false }))).status).toBe(400);
    expect((await decide(id, false, "   ")).status).not.toBe(200);
    expect((await decide(id, false, "El monto no coincide")).status).toBe(200);
    const row = (await payments(t)).find((p) => p.id === id)!;
    expect(row.status).toBe("rechazado");
    expect(row.rejectReason).toBe("El monto no coincide");
    const after = await tenantRow(t);
    expect(after.plan_id).toBe(before.plan_id);
    expect(after.plan_expires_at).toBeNull();
  });
  it("un estado desconocido en la cola vuelve a «por revisar»", async () => {
    const t = await register("rev-unk");
    const id = await payId(t);
    await submit(t, id, { reference: "DESCONOCIDO01" });
    const r = await (await adminPayments(req("GET", "/api/admin/payments?status=loquesea", admin))).json();
    expect(r.payments.map((p: { id: string }) => p.id)).toContain(id);
    expect(r.payments.every((p: { status: string }) => p.status === "por_revisar")).toBe(true);
  });
  it("las funciones también se defienden solas (sin pasar por las rutas)", async () => {
    const t = await register("rev-sql");
    const id = await payId(t);
    await submit(t, id, { reference: "SOLOSQL00001" });
    const h = hash(admin);
    await expect(getPool().query("SELECT admin_payment_decide($1,$2,false,'  ')", [h, id])).rejects.toMatchObject({ code: "22023" });
    await expect(getPool().query("SELECT admin_payment_decide($1,$2,false,NULL)", [h, id])).rejects.toMatchObject({ code: "22023" });
    await expect(getPool().query("SELECT payment_create($1,$2,$3,0,'paypal')", [hash(t.cookie), t.tenantId, planId])).rejects.toMatchObject({ code: "22023" });
    await expect(getPool().query("SELECT payment_create($1,$2,$3,13,'paypal')", [hash(t.cookie), t.tenantId, planId])).rejects.toMatchObject({ code: "22023" });
    await expect(getPool().query("SELECT admin_set_payment_settings($1,-5,'a','b','c','d','e','f','g')", [h])).rejects.toMatchObject({ code: "22023" });
    await expect(getPool().query("SELECT admin_set_payment_settings($1,0,'a','b','c','d','e','f','g')", [h])).rejects.toMatchObject({ code: "22023" });
    await expect(getPool().query("SELECT admin_set_payment_settings($1,1000000000,'a','b','c','d','e','f','g')", [h])).rejects.toMatchObject({ code: "22023" });
    await expect(getPool().query("SELECT admin_set_plan_price($1,$2,0)", [h, planId])).rejects.toMatchObject({ code: "22023" });
    // quien no es súper admin no puede llamar a las funciones de admin
    await expect(getPool().query("SELECT admin_payment_decide($1,$2,true,NULL)", [hash(t.cookie), id])).rejects.toMatchObject({ code: "42501" });
    await expect(getPool().query("SELECT * FROM admin_list_payments($1,NULL)", [hash(t.cookie)])).rejects.toMatchObject({ code: "42501" });
    await expect(getPool().query("SELECT * FROM admin_payment_proof($1,$2)", [hash(t.cookie), id])).rejects.toMatchObject({ code: "42501" });
    await expect(getPool().query("SELECT admin_get_payment_settings($1)", [hash(t.cookie)])).rejects.toMatchObject({ code: "42501" });
  });
  it("un pago se decide una sola vez y solo si está por revisar", async () => {
    const t = await register("rev-once");
    const id = await payId(t);
    expect((await decide(id, true)).status).toBe(409); // aún sin comprobante
    await submit(t, id);
    expect((await decide(id, true)).status).toBe(200);
    expect((await decide(id, true)).status).toBe(409);
    expect((await decide(id, false, "x")).status).toBe(409);
    expect((await decide(randomUUID(), true)).status).toBe(404);
  });
});

describe("datos de cobro y precios", () => {
  it("guarda y lee la configuración; la fecha de la tasa se renueva al guardar", async () => {
    await owner.query("UPDATE platform_settings SET bcv_rate_at = now() - interval '3 days'");
    await setSettings({ rate: 41.25, notes: "Pago de lunes a viernes" });
    const s = (await (await settingsGet(req("GET", "/api/admin/billing-settings", admin))).json()).settings;
    expect(Number(s.bcv_rate)).toBe(41.25);
    expect(s.notes).toBe("Pago de lunes a viernes");
    expect(Date.now() - new Date(s.bcv_rate_at).getTime()).toBeLessThan(60000);
    await setSettings();
  });
  it("rechaza tasas absurdas y vacía los campos en blanco", async () => {
    expect((await settingsPost(req("POST", "/api/admin/billing-settings", admin, { ...SETTINGS, rate: -1 }))).status).toBe(400);
    expect((await settingsPost(req("POST", "/api/admin/billing-settings", admin, { ...SETTINGS, rate: 0 }))).status).toBe(400);
    await setSettings({ paypal: "   " });
    expect((await (await settingsGet(req("GET", "/api/admin/billing-settings", admin))).json()).settings.paypal_email).toBeNull();
    await setSettings();
  });
  it("el precio de un plan se cambia y se quita", async () => {
    const p = await owner.query<{ id: string }>("INSERT INTO plans (slug, name, position, max_members, modules) VALUES ($1,'Precio',94,2,'{}') RETURNING id", [`bl-precio-${RUN}`]);
    planIds.push(p.rows[0]!.id);
    expect((await planPrice(req("POST", "/api/admin/plan-price", admin, { planId: p.rows[0]!.id, priceCents: 2500 }))).status).toBe(200);
    expect((await owner.query("SELECT price_usd_cents FROM plans WHERE id = $1", [p.rows[0]!.id])).rows[0].price_usd_cents).toBe(2500);
    expect((await planPrice(req("POST", "/api/admin/plan-price", admin, { planId: p.rows[0]!.id, priceCents: null }))).status).toBe(200);
    expect((await owner.query("SELECT price_usd_cents FROM plans WHERE id = $1", [p.rows[0]!.id])).rows[0].price_usd_cents).toBeNull();
    expect((await planPrice(req("POST", "/api/admin/plan-price", admin, { planId: p.rows[0]!.id, priceCents: 0 }))).status).toBe(400);
    expect((await planPrice(req("POST", "/api/admin/plan-price", admin, { planId: randomUUID(), priceCents: 100 }))).status).toBe(404);
  });
});

describe("vencimientos", () => {
  it("quien no renovó pasa a «pago pendiente»; los de prueba y los activados a mano no se tocan", async () => {
    const venc = await register("exp-a");
    const manual = await register("exp-b");
    const trial = await register("exp-c");
    const vigente = await register("exp-d");
    const setT = async (t: T, status: string, exp: string | null) => {
      const c = await owner.connect();
      try {
        await c.query("BEGIN");
        await c.query("SELECT set_config('app.tenant_id', $1, true)", [t.tenantId]);
        await c.query("ALTER TABLE tenants DISABLE TRIGGER tenants_plan_guard");
        await c.query(`UPDATE tenants SET status = $2, plan_expires_at = ${exp ?? "NULL"} WHERE id = $1`, [t.tenantId, status]);
        await c.query("ALTER TABLE tenants ENABLE TRIGGER tenants_plan_guard");
        await c.query("COMMIT");
      } catch (e) { await c.query("ROLLBACK"); throw e; } finally { c.release(); }
    };
    await setT(venc, "active", "now() - interval '1 minute'");
    await setT(manual, "active", null);
    await setT(trial, "trial", "now() - interval '1 day'");
    await setT(vigente, "active", "now() + interval '1 day'");
    const n = Number((await getPool().query("SELECT expire_subscriptions() AS n")).rows[0].n);
    expect(n).toBeGreaterThanOrEqual(1);
    expect((await tenantRow(venc)).status).toBe("past_due");
    expect((await tenantRow(manual)).status).toBe("active");
    expect((await tenantRow(trial)).status).toBe("trial");
    expect((await tenantRow(vigente)).status).toBe("active");
    const again = Number((await getPool().query("SELECT expire_subscriptions() AS n")).rows[0].n);
    expect(again).toBe(0);
    // Pagar de nuevo lo reactiva.
    const id = await payId(venc, "paypal");
    await submit(venc, id, { declared: "10" });
    await decide(id, true);
    expect((await tenantRow(venc)).status).toBe("active");
  });
  it("los días que quedan salen en /api/billing", async () => {
    const t = await register("exp-days");
    const id = await payId(t, "paypal");
    await submit(t, id, { declared: "10" });
    await decide(id, true);
    const d = await (await billingGet(req("GET", "/api/billing", t.cookie))).json();
    expect(d.subscription.status).toBe("active");
    expect(d.subscription.daysLeft).toBe(30);
    expect(d.subscription.planName).toBe("Plan cobro");
  });
});
EOF_TESTS_BILLING_TEST_TS
echo "✔ tests/billing.test.ts"

cat <<'FIN'

══════════════════════════════════════════════════════════
 Paso 18C aplicado. Ahora, en este orden:

   1) npm run db:up
   2) npm run db:migrate       # aplica 0025 (cobros)
   3) npm run typecheck && npm run lint && npm test
   4) npm run dev:all          # reinícialo (el worker ahora también marca los vencimientos)

   Primera configuración (como súper admin, en «Administración» → «Cobros»):
     a) Precio mensual en USD de cada plan (vacío = no se vende en línea).
     b) Datos para cobrar: Pago Móvil (banco, teléfono, cédula/RIF, titular), correo PayPal, ID de Binance Pay.
     c) La TASA BCV del día (Bs. por 1 USD). Hay que escribirla tú cada día: si pasan 36 h sin
        actualizarla, los clientes no pueden pagar en bolívares (así nunca se cobra con una tasa vieja).

   Cómo funciona para el cliente (el dueño del negocio, en «Panel» → «Pagar o cambiar de plan»):
     1. Elige plan, meses y método. Con Pago Móvil ve el monto exacto en Bs. con la tasa congelada 30 minutos.
     2. Paga desde su banco y sube la captura + referencia, fecha, banco, teléfono y monto.
     3. Tú lo ves en «Cobros» con la imagen, comparas con tu banco y pulsas «Confirmar pago»
        (o «Rechazar» con un motivo). Al confirmar se activa el plan: 30 días por mes pagado
        (renovar el mismo plan suma sobre lo que le queda).
     4. Al vencer el período, el negocio pasa a «Pago pendiente» y el asistente deja de responder a clientes
        hasta que pague de nuevo. (Los negocios en prueba o activados a mano, sin fecha, no se tocan.)

   Seguridad: el comprobante no se acepta solo ni la IA lo "verifica": SOLO TU BANCO confirma un pago.
   Una misma referencia no se puede usar dos veces. El cliente nunca puede cambiar su plan ni su vencimiento.

   Todavía NO incluye: lectura automática del comprobante con IA, ni verificación automática con el banco
   (requiere cuenta jurídica y acceso a la API del banco), ni cobro automático con tarjeta, ni avisos de
   «tu plan vence pronto» por WhatsApp. Se agregan después.
══════════════════════════════════════════════════════════
FIN