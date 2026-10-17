#!/usr/bin/env bash
# Paso 18A: planes con límites (respuestas al mes, personas del equipo) y consumo.
# Ejecútalo desde la raíz del proyecto:  bash aplicar-paso-18a.sh
set -euo pipefail

[ -f package.json ] && grep -q '"name": "saas-whatsapp"' package.json || { echo "✖ Ejecuta esto dentro de ~/proyectos/saas-whatsapp"; exit 1; }
[ -f db/migrations/0016_pedidos.sql ] || { echo "✖ Falta el Paso 14B (migración 0016). Aplícalo primero."; exit 1; }
[ -f db/migrations/0020_automatizaciones.sql ] || { echo "✖ Falta el Paso 16B (migración 0020). Aplícalo primero."; exit 1; }
[ -f src/lib/automations/rules.ts ] || { echo "✖ Falta el Paso 16B (automatizaciones). Aplícalo primero."; exit 1; }
[ -f db/migrations/0022_recordatorios.sql ] || { echo "✖ Falta el Paso 16D (migración 0022). Aplícalo primero."; exit 1; }
[ -f src/lib/modules.ts ] || { echo "✖ Falta el Paso 17A (src/lib/modules.ts). Aplícalo primero."; exit 1; }
command -v npm >/dev/null || { echo "✖ No encuentro npm"; exit 1; }

if [ "$(git rev-parse --abbrev-ref HEAD 2>/dev/null)" = "main" ]; then
  git checkout -b paso-18a 2>/dev/null || git checkout paso-18a
  echo "✔ Rama paso-18a lista"
fi

BK=".paso18a-backup"
mkdir -p "$BK"
backup() { if [ -f "$1" ]; then mkdir -p "$BK/$(dirname "$1")"; cp "$1" "$BK/$1"; fi; }
grep -q "^.paso18a-backup" .gitignore 2>/dev/null || printf "\n.paso18a-backup/\n" >> .gitignore
backup db/migrations/0023_planes.sql
backup src/lib/plans/usage.ts
backup src/app/api/plan/route.ts
backup src/app/api/admin/plans/route.ts
backup src/app/api/admin/tenant-plan/route.ts
backup src/app/api/admin/tenants/route.ts
backup src/lib/auth/validation.ts
backup src/lib/auth/team-errors.ts
backup src/lib/agent/run.ts
backup src/components/SimulatorChat.tsx
backup src/components/PlanCard.tsx
backup src/components/PlanEditor.tsx
backup src/components/TenantActions.tsx
backup src/app/panel/page.tsx
backup src/app/admin/page.tsx
backup tests/plans.test.ts
backup tests/agent.test.ts
backup tests/mfa-team.test.ts

mkdir -p db/migrations
cat > db/migrations/0023_planes.sql <<'EOF_DB_MIGRATIONS_0023_PLANES_SQL'
-- Paso 18A: planes con límites editables. Los precios NO viven aquí (llegan con el cobro, Paso 18C).
-- Los tres planes de abajo son PROVISIONALES: el súper admin cambia nombres y límites desde Administración.

CREATE TABLE plans (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug text NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9][a-z0-9-]{1,30}$'),
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 60),
  position integer NOT NULL DEFAULT 0,
  is_default boolean NOT NULL DEFAULT false,
  active boolean NOT NULL DEFAULT true,
  -- NULL = sin tope. Cuenta respuestas del asistente por mes calendario (UTC).
  max_replies_month integer CHECK (max_replies_month IS NULL OR max_replies_month BETWEEN 0 AND 10000000),
  max_members integer NOT NULL CHECK (max_members BETWEEN 1 AND 1000),
  -- Módulos incluidos. (Se aplican en el Paso 18B; aquí solo se guardan.)
  modules text[] NOT NULL DEFAULT '{}' CHECK (modules <@ ARRAY['agenda','catalogo','copiloto','automatizaciones']::text[]),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (NOT is_default OR active)
);
CREATE UNIQUE INDEX plans_un_solo_defecto_idx ON plans (is_default) WHERE is_default;
-- Los planes no tienen secretos y los lee cualquier negocio; solo se cambian con funciones del súper admin.
REVOKE INSERT, UPDATE, DELETE ON plans FROM app_user;

INSERT INTO plans (slug, name, position, is_default, max_replies_month, max_members, modules) VALUES
  ('plan-1', 'Plan 1', 1, true, 300, 3, ARRAY['agenda','catalogo']),
  ('plan-2', 'Plan 2', 2, false, 2000, 6, ARRAY['agenda','catalogo','copiloto','automatizaciones']),
  ('plan-3', 'Plan 3', 3, false, 10000, 15, ARRAY['agenda','catalogo','copiloto','automatizaciones']);

CREATE FUNCTION default_plan_id() RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$ SELECT id FROM plans WHERE is_default AND active LIMIT 1 $$;
GRANT EXECUTE ON FUNCTION default_plan_id() TO app_user;

ALTER TABLE tenants ADD COLUMN plan_id uuid REFERENCES plans (id) DEFAULT default_plan_id();
UPDATE tenants SET plan_id = default_plan_id() WHERE plan_id IS NULL;
ALTER TABLE tenants ALTER COLUMN plan_id SET NOT NULL;
CREATE INDEX tenants_plan_idx ON tenants (plan_id);

-- El plan de un negocio solo cambia dentro de las funciones del súper admin (ni siquiera el dueño del negocio).
CREATE FUNCTION tenants_plan_guard() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.plan_id IS DISTINCT FROM OLD.plan_id AND NOT (current_user = 'app_owner' AND session_user <> 'app_owner') THEN
    RAISE EXCEPTION 'el plan solo lo cambia un súper admin' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER tenants_plan_guard BEFORE UPDATE OF plan_id ON tenants
  FOR EACH ROW EXECUTE FUNCTION tenants_plan_guard();

-- ---- Funciones del súper admin
CREATE FUNCTION admin_update_plan(
  p_token_hash bytea, p_plan_id uuid, p_name text, p_max_replies integer, p_max_members integer, p_modules text[], p_active boolean
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE v_default boolean;
BEGIN
  PERFORM admin_require(p_token_hash);
  SELECT is_default INTO v_default FROM plans WHERE id = p_plan_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'plan inexistente' USING ERRCODE = 'no_data_found'; END IF;
  IF v_default AND NOT p_active THEN
    RAISE EXCEPTION 'el plan por defecto no se puede desactivar' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  UPDATE plans SET name = btrim(p_name), max_replies_month = p_max_replies, max_members = p_max_members,
         modules = COALESCE(p_modules, '{}'), active = p_active, updated_at = now()
   WHERE id = p_plan_id;
END
$$;

CREATE FUNCTION admin_set_tenant_plan(p_token_hash bytea, p_tenant_id uuid, p_plan_id uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE v_user uuid; v_old uuid; v_active boolean;
BEGIN
  v_user := admin_require(p_token_hash);
  SELECT plan_id INTO v_old FROM tenants WHERE id = p_tenant_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'negocio inexistente' USING ERRCODE = 'no_data_found'; END IF;
  SELECT active INTO v_active FROM plans WHERE id = p_plan_id;
  IF v_active IS NOT TRUE THEN RAISE EXCEPTION 'plan inexistente o inactivo' USING ERRCODE = 'no_data_found'; END IF;
  UPDATE tenants SET plan_id = p_plan_id WHERE id = p_tenant_id;
  INSERT INTO audit_log (tenant_id, actor_id, action, target_type, target_id, metadata)
    VALUES (p_tenant_id, v_user, 'admin.tenant.plan', 'tenant', p_tenant_id::text,
            jsonb_build_object('from', v_old, 'to', p_plan_id));
END
$$;

-- La lista de negocios del súper admin ahora incluye el plan.
DROP FUNCTION admin_list_tenants(bytea);
CREATE FUNCTION admin_list_tenants(p_token_hash bytea)
RETURNS TABLE (
  t_id uuid, t_name text, t_slug text, t_status text,
  t_trial_ends_at timestamptz, t_created_at timestamptz, t_members bigint, t_plan_id uuid
)
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  PERFORM admin_require(p_token_hash);
  RETURN QUERY
    SELECT t.id, t.name, t.slug, t.status, t.trial_ends_at, t.created_at,
           (SELECT count(*) FROM memberships m WHERE m.tenant_id = t.id), t.plan_id
    FROM tenants t ORDER BY t.created_at DESC LIMIT 500;
END
$$;

REVOKE ALL ON FUNCTION admin_update_plan(bytea, uuid, text, integer, integer, text[], boolean),
  admin_set_tenant_plan(bytea, uuid, uuid), admin_list_tenants(bytea) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION admin_update_plan(bytea, uuid, text, integer, integer, text[], boolean),
  admin_set_tenant_plan(bytea, uuid, uuid), admin_list_tenants(bytea) TO app_user;

-- ---- Tope de personas del equipo = el del plan (antes: 25 fijo)
CREATE OR REPLACE FUNCTION team_invite(
  p_token_hash bytea, p_tenant_id uuid, p_email text, p_role text, p_inv_hash bytea
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE v_role text; v_actor uuid; v_email text; v_id uuid; v_max integer;
BEGIN
  v_role := auth_tenant_role(p_token_hash, p_tenant_id);
  IF v_role IS NULL OR v_role NOT IN ('owner', 'admin') THEN
    RAISE EXCEPTION 'no autorizado' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_role NOT IN ('admin', 'agent') THEN
    RAISE EXCEPTION 'rol inválido' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF v_role = 'admin' AND p_role <> 'agent' THEN
    RAISE EXCEPTION 'no autorizado' USING ERRCODE = 'insufficient_privilege';
  END IF;
  v_email := lower(btrim(p_email));
  IF char_length(v_email) < 3 OR char_length(v_email) > 254 THEN
    RAISE EXCEPTION 'correo inválido' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF EXISTS (
    SELECT 1 FROM memberships m JOIN users u ON u.id = m.user_id
    WHERE m.tenant_id = p_tenant_id AND u.email = v_email
  ) THEN
    RAISE EXCEPTION 'ya es miembro' USING ERRCODE = 'unique_violation';
  END IF;
  -- Tope de personas según el plan del negocio (miembros + invitaciones pendientes).
  SELECT p.max_members INTO v_max FROM tenants t JOIN plans p ON p.id = t.plan_id WHERE t.id = p_tenant_id;
  IF (SELECT count(*) FROM memberships WHERE tenant_id = p_tenant_id)
     + (SELECT count(*) FROM invitations
        WHERE tenant_id = p_tenant_id AND accepted_at IS NULL AND revoked_at IS NULL
          AND expires_at > now()) >= COALESCE(v_max, 1) THEN
    RAISE EXCEPTION 'límite de equipo' USING ERRCODE = 'program_limit_exceeded';
  END IF;

  v_actor := auth_session_user(p_token_hash);
  UPDATE invitations SET revoked_at = now()
    WHERE tenant_id = p_tenant_id AND email = v_email AND accepted_at IS NULL AND revoked_at IS NULL;
  INSERT INTO invitations (tenant_id, email, role, token_hash, invited_by, expires_at)
    VALUES (p_tenant_id, v_email, p_role, p_inv_hash, v_actor, now() + interval '7 days')
    RETURNING id INTO v_id;
  INSERT INTO audit_log (tenant_id, actor_id, action, target_type, target_id, metadata)
    VALUES (p_tenant_id, v_actor, 'team.invited', 'invitation', v_id::text,
            jsonb_build_object('email', v_email, 'role', p_role));
  RETURN v_id;
END
$$;

-- ---- Aviso en «Hoy» cuando el asistente se detiene por el tope mensual del plan
CREATE OR REPLACE FUNCTION conversations_work_sync() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_name text;
  v_reason text;
BEGIN
  IF NEW.status = 'human' AND OLD.status = 'bot' AND COALESCE(NEW.handoff_reason, '') <> 'tomada_por_persona' THEN
    SELECT COALESCE(NULLIF(display_name, ''), '+' || wa_id) INTO v_name
      FROM contacts WHERE tenant_id = NEW.tenant_id AND id = NEW.contact_id;
    v_reason := CASE NEW.handoff_reason
      WHEN 'pedido_de_persona' THEN 'El cliente pidió hablar con una persona.'
      WHEN 'limite_diario' THEN 'El asistente llegó a su límite diario de respuestas.'
      WHEN 'limite_plan' THEN 'Se llegó al tope mensual de respuestas del plan; el asistente se detuvo hasta el mes siguiente.'
      WHEN 'limite_contacto' THEN 'Este cliente escribió muchísimo en poco tiempo; el asistente se detuvo.'
      WHEN 'intentos_de_manipulacion' THEN 'El cliente intentó manipular al asistente; revisa el chat con cuidado.'
      WHEN 'envio_rechazado' THEN 'WhatsApp rechazó la respuesta del asistente.'
      WHEN 'envio_incierto' THEN 'No se pudo confirmar si la respuesta llegó al cliente.'
      WHEN 'agente_fallo' THEN 'El asistente tuvo un fallo y no pudo responder.'
      WHEN 'fuga_de_instrucciones' THEN 'El asistente iba a revelar sus instrucciones; se detuvo.'
      WHEN 'salida_bloqueada' THEN 'Se bloqueó una respuesta del asistente por seguridad.'
      WHEN 'respuesta_vacia' THEN 'El asistente no pudo generar una respuesta.'
      ELSE 'El asistente pasó esta conversación a una persona.'
    END;
    INSERT INTO work_items (tenant_id, type, priority, title, detail, conversation_id, contact_id, source)
      VALUES (NEW.tenant_id, 'atencion_humana', 1, 'Atender a ' || v_name, v_reason, NEW.id, NEW.contact_id, 'agente')
      ON CONFLICT (tenant_id, conversation_id) WHERE type = 'atencion_humana' AND status IN ('abierto', 'en_proceso')
      DO NOTHING;
  ELSIF (NEW.status = 'bot' AND OLD.status = 'human') OR (NEW.status = 'closed' AND OLD.status <> 'closed') THEN
    UPDATE work_items SET status = 'resuelto', resolved_at = now()
      WHERE tenant_id = NEW.tenant_id AND conversation_id = NEW.id
        AND type = 'atencion_humana' AND status IN ('abierto', 'en_proceso');
  END IF;
  RETURN NEW;
END
$$;

-- ---- Invitaciones pendientes del negocio ACTUAL (la tabla no es legible por la aplicación)
CREATE FUNCTION tenant_pending_invitations() RETURNS integer
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT count(*)::int FROM invitations
   WHERE tenant_id = app_current_tenant() AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > now()
$$;
REVOKE ALL ON FUNCTION tenant_pending_invitations() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION tenant_pending_invitations() TO app_user;
EOF_DB_MIGRATIONS_0023_PLANES_SQL
echo "✔ db/migrations/0023_planes.sql"
mkdir -p src/lib/plans
cat > src/lib/plans/usage.ts <<'EOF_SRC_LIB_PLANS_USAGE_TS'
import type { PoolClient } from "pg";

type Db = Pick<PoolClient, "query">;

export const PLAN_MODULES = ["agenda", "catalogo", "copiloto", "automatizaciones"] as const;
export type PlanModule = (typeof PLAN_MODULES)[number];
export const PLAN_MODULE_LABEL: Record<PlanModule, string> = {
  agenda: "Agenda de citas",
  catalogo: "Catálogo y pedidos",
  copiloto: "Copiloto",
  automatizaciones: "Automatizaciones y conexiones",
};

export interface PlanInfo { id: string; slug: string; name: string; maxRepliesMonth: number | null; maxMembers: number; modules: PlanModule[] }
export interface PlanUsage { plan: PlanInfo; repliesThisMonth: number; members: number; pendingInvitations: number }

/** Qué tan cerca está un uso de su tope. «near» = 80 % o más. */
export type QuotaState = "unlimited" | "ok" | "near" | "full";
export function quotaState(used: number, max: number | null): QuotaState {
  if (max === null) return "unlimited";
  if (used >= max) return "full";
  if (max > 0 && used / max >= 0.8) return "near";
  return "ok";
}

export const rowToPlan = (r: Record<string, unknown>): PlanInfo => ({
  id: String(r.id),
  slug: String(r.slug),
  name: String(r.name),
  maxRepliesMonth: r.max_replies_month === null || r.max_replies_month === undefined ? null : Number(r.max_replies_month),
  maxMembers: Number(r.max_members),
  modules: ((r.modules as string[]) ?? []).filter((m): m is PlanModule => (PLAN_MODULES as readonly string[]).includes(m)),
});

/** Respuestas del asistente en el mes calendario actual (UTC). */
export async function repliesThisMonth(db: Db, tenantId: string): Promise<number> {
  const r = await db.query(
    "SELECT COALESCE(sum(replies), 0)::int AS n FROM agent_usage_daily WHERE tenant_id = $1 AND day >= date_trunc('month', now() AT TIME ZONE 'utc')::date",
    [tenantId],
  );
  return Number(r.rows[0].n);
}

export async function loadPlan(db: Db, tenantId: string): Promise<PlanInfo | null> {
  const r = await db.query("SELECT p.* FROM tenants t JOIN plans p ON p.id = t.plan_id WHERE t.id = $1", [tenantId]);
  return r.rows[0] ? rowToPlan(r.rows[0]) : null;
}

export async function loadPlanUsage(db: Db, tenantId: string): Promise<PlanUsage | null> {
  const plan = await loadPlan(db, tenantId);
  if (!plan) return null;
  const used = await repliesThisMonth(db, tenantId);
  const m = await db.query("SELECT count(*)::int AS n FROM memberships WHERE tenant_id = $1", [tenantId]);
  const i = await db.query("SELECT tenant_pending_invitations() AS n"); // la tabla no es legible por la aplicación; la función mira solo el negocio actual
  return { plan, repliesThisMonth: used, members: Number(m.rows[0].n), pendingInvitations: Number(i.rows[0].n) };
}
EOF_SRC_LIB_PLANS_USAGE_TS
echo "✔ src/lib/plans/usage.ts"
mkdir -p src/app/api/plan
cat > src/app/api/plan/route.ts <<'EOF_SRC_APP_API_PLAN_ROUTE_TS'
import { requireTenant } from "@/lib/auth/guard";
import { jsonResponse, route } from "@/lib/auth/http";
import { withTenant } from "@/lib/db";
import { loadPlanUsage, quotaState } from "@/lib/plans/usage";

/** Plan del negocio y cuánto lleva usado. Lo puede ver cualquier persona del equipo. */
export const GET = route(async (req) => {
  const auth = await requireTenant(req);
  if (!auth.ok) return auth.response;
  const u = await withTenant(auth.ctx.tenantId, (db) => loadPlanUsage(db, auth.ctx.tenantId));
  if (!u) return jsonResponse({ plan: null });
  return jsonResponse({
    ...u,
    repliesState: quotaState(u.repliesThisMonth, u.plan.maxRepliesMonth),
    membersState: quotaState(u.members + u.pendingInvitations, u.plan.maxMembers),
  });
});
EOF_SRC_APP_API_PLAN_ROUTE_TS
echo "✔ src/app/api/plan/route.ts"
mkdir -p src/app/api/admin/plans
cat > src/app/api/admin/plans/route.ts <<'EOF_SRC_APP_API_ADMIN_PLANS_ROUTE_TS'
import { getPool } from "@/lib/db";
import { checkOrigin, errorResponse, jsonResponse, readJson, route } from "@/lib/auth/http";
import { requireSuperAdmin } from "@/lib/auth/guard";
import { planUpdateSchema } from "@/lib/auth/validation";

/** Edita un plan (nombre, límites, módulos, activo). Solo súper admin. */
export const POST = route(async (req) => {
  const blocked = checkOrigin(req);
  if (blocked) return blocked;
  const auth = await requireSuperAdmin(req);
  if (!auth.ok) return auth.response;
  const body = await readJson(req, planUpdateSchema);
  if (!body.ok) return body.response;
  const d = body.data;
  try {
    await getPool().query("SELECT admin_update_plan($1, $2, $3, $4, $5, $6, $7)", [auth.tokenHash, d.planId, d.name, d.maxRepliesMonth, d.maxMembers, [...new Set(d.modules)], d.active]);
  } catch (e) {
    const code = (e as { code?: string }).code;
    if (code === "P0002") return errorResponse(404, "no_encontrado", "Plan no encontrado.");
    if (code === "22023") return errorResponse(409, "plan_defecto", "El plan por defecto no se puede desactivar. Elige otro por defecto primero.");
    throw e;
  }
  return jsonResponse({ ok: true });
});
EOF_SRC_APP_API_ADMIN_PLANS_ROUTE_TS
echo "✔ src/app/api/admin/plans/route.ts"
mkdir -p src/app/api/admin/tenant-plan
cat > src/app/api/admin/tenant-plan/route.ts <<'EOF_SRC_APP_API_ADMIN_TENANT-PLAN_ROUTE_TS'
import { getPool } from "@/lib/db";
import { checkOrigin, errorResponse, jsonResponse, readJson, route } from "@/lib/auth/http";
import { requireSuperAdmin } from "@/lib/auth/guard";
import { tenantPlanSchema } from "@/lib/auth/validation";

/** Cambia el plan de un negocio. Solo súper admin. */
export const POST = route(async (req) => {
  const blocked = checkOrigin(req);
  if (blocked) return blocked;
  const auth = await requireSuperAdmin(req);
  if (!auth.ok) return auth.response;
  const body = await readJson(req, tenantPlanSchema);
  if (!body.ok) return body.response;
  try {
    await getPool().query("SELECT admin_set_tenant_plan($1, $2, $3)", [auth.tokenHash, body.data.tenantId, body.data.planId]);
  } catch (e) {
    if ((e as { code?: string }).code === "P0002") return errorResponse(404, "no_encontrado", "Negocio o plan no encontrado (o el plan está inactivo).");
    throw e;
  }
  return jsonResponse({ ok: true });
});
EOF_SRC_APP_API_ADMIN_TENANT-PLAN_ROUTE_TS
echo "✔ src/app/api/admin/tenant-plan/route.ts"
mkdir -p src/app/api/admin/tenants
cat > src/app/api/admin/tenants/route.ts <<'EOF_SRC_APP_API_ADMIN_TENANTS_ROUTE_TS'
import { getPool } from "@/lib/db";
import { jsonResponse, route } from "@/lib/auth/http";
import { requireSuperAdmin } from "@/lib/auth/guard";

export const GET = route(async (req) => {
  const auth = await requireSuperAdmin(req);
  if (!auth.ok) return auth.response;
  const r = await getPool().query("SELECT * FROM admin_list_tenants($1)", [auth.tokenHash]);
  return jsonResponse({
    tenants: r.rows.map((t) => ({
      id: t.t_id,
      name: t.t_name,
      slug: t.t_slug,
      status: t.t_status,
      trialEndsAt: t.t_trial_ends_at,
      createdAt: t.t_created_at,
      members: Number(t.t_members),
      planId: t.t_plan_id,
    })),
  });
});
EOF_SRC_APP_API_ADMIN_TENANTS_ROUTE_TS
echo "✔ src/app/api/admin/tenants/route.ts"
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
EOF_SRC_LIB_AUTH_VALIDATION_TS
echo "✔ src/lib/auth/validation.ts"
mkdir -p src/lib/auth
cat > src/lib/auth/team-errors.ts <<'EOF_SRC_LIB_AUTH_TEAM-ERRORS_TS'
import { errorResponse } from "./http";

/** Errores de las funciones de equipo -> respuestas HTTP claras. null = no es de equipo. */
export function teamErrorResponse(err: unknown): Response | null {
  const e = err as { code?: string };
  if (e.code === "23505") return errorResponse(409, "ya_es_miembro", "Esa persona ya forma parte del equipo.");
  if (e.code === "54000") return errorResponse(409, "limite_equipo", "Llegaste al máximo de personas que incluye tu plan (miembros e invitaciones pendientes).");
  if (e.code === "22023") return errorResponse(400, "datos_invalidos", "Datos inválidos.");
  if (e.code === "42501") return errorResponse(403, "sin_permiso", "No tienes permiso para esto.");
  if (e.code === "P0002") return errorResponse(404, "no_encontrado", "No encontrado.");
  return null;
}
EOF_SRC_LIB_AUTH_TEAM-ERRORS_TS
echo "✔ src/lib/auth/team-errors.ts"
mkdir -p src/lib/agent
cat > src/lib/agent/run.ts <<'EOF_SRC_LIB_AGENT_RUN_TS'
import { loadPlan, repliesThisMonth } from "@/lib/plans/usage";
import { getLlmProvider } from "@/lib/ai";
import type { LlmProvider } from "@/lib/ai/provider";
import { decryptSecret } from "@/lib/crypto";
import { withTenant } from "@/lib/db";
import { getLlmEnv } from "@/lib/env";
import { withLock } from "@/lib/queue/lock";
import type { InboundJob } from "@/lib/queue/producer";
import { sendText } from "@/lib/whatsapp/graph";
import { fixedTexts, styleFromRow, type AgentStyle } from "./style";
import { RULES_LINES, buildSystemPrompt, buildTurns, customerWantsHuman, parseReply, type HistoryRow } from "./prompt";
import { formatMoney } from "@/lib/catalog/money";
import { getEmbedder, type Embedder } from "@/lib/kb/embeddings";
import { searchKnowledge, type Snippet } from "@/lib/kb/search";
import { AGENDA_RULES_LINES, bookingTexts, buildMenu, createAgentAppointment, parseBookingRequest, stripBookingMarkers, whenLabel, type AgendaMenu } from "./booking";
import { ORDER_RULES_LINES, buildCatalogMenu, createAgentOrder, orderTexts, parseOrderRequest, stripOrderMarkers, type CatalogMenu } from "./ordering";
import { allowedContacts, checkOutput, looksLikeInjection, newCanary } from "./safety";

export type AgentOutcome =
  | "replied"
  | "handoff"
  | "already_replied"
  | "limit_reached"
  | "contact_limited"
  | "send_failed"
  | "send_unknown"
  | "skipped_not_found"
  | "skipped_ignored_type"
  | "skipped_disabled"
  | "skipped_inactive_tenant"
  | "skipped_human"
  | "skipped_personal"
  | "skipped_superseded"
  | "skipped_no_whatsapp";

export interface AgentDeps {
  llm: LlmProvider;
  send: typeof sendText;
  /** Para pruebas: el generador de vectores de la base de conocimiento. */
  embedder: Embedder;
}

const LOCK_TTL_MS = 90_000; // mayor que IA (30 s) + envío (10 s) + base de datos
const LLM_MAX_TOKENS = 400;
const TEXT_TYPES = new Set(["text", "button", "interactive"]);
const IGNORED_TYPES = new Set(["reaction"]);

interface Ctx {
  messageId: string;
  conversationId: string;
  contactId: string;
  msgType: string;
  body: string | null;
  convStatus: string;
  contactLabel: string;
  contactName: string | null;
  waId: string;
  tenantName: string;
  tenantStatus: string;
  trialEndsAt: Date | null;
  enabled: boolean;
  assistantName: string;
  instructions: string;
  style: AgentStyle;
  phoneId: string | null;
  secretEnc: string | null;
  keyVersion: number | null;
}

async function loadContext(job: InboundJob): Promise<Ctx | null> {
  return withTenant(job.tenantId, async (db) => {
    const r = await db.query(
      `SELECT m.id AS message_id, m.conversation_id, c.contact_id, m.msg_type, m.body,
              c.status AS conv_status, ct.wa_id, ct.label AS contact_label, ct.display_name AS contact_name,
              t.name AS tenant_name, t.status AS tenant_status, t.trial_ends_at,
              COALESCE(a.enabled, false) AS enabled,
              COALESCE(a.assistant_name, 'Asistente') AS assistant_name,
              COALESCE(a.instructions, '') AS instructions,
              a.business_type, a.country, a.tone, a.emoji_level, a.reply_length,
              i.external_id AS phone_id, i.secret_enc, i.key_version
         FROM messages m
         JOIN conversations c ON c.tenant_id = m.tenant_id AND c.id = m.conversation_id
         JOIN contacts ct ON ct.tenant_id = c.tenant_id AND ct.id = c.contact_id
         JOIN tenants t ON t.id = m.tenant_id
         LEFT JOIN tenant_agents a ON a.tenant_id = m.tenant_id
         LEFT JOIN tenant_integrations i ON i.tenant_id = m.tenant_id AND i.provider = 'whatsapp'
        WHERE m.tenant_id = $1 AND m.id = $2 AND m.direction = 'in'`,
      [job.tenantId, job.messageId],
    );
    const x = r.rows[0];
    if (!x) return null;
    return {
      messageId: x.message_id, conversationId: x.conversation_id, contactId: x.contact_id, msgType: x.msg_type, body: x.body,
       convStatus: x.conv_status, contactLabel: x.contact_label, contactName: x.contact_name, waId: x.wa_id,
      tenantName: x.tenant_name, tenantStatus: x.tenant_status, trialEndsAt: x.trial_ends_at,
      enabled: x.enabled, assistantName: x.assistant_name, instructions: x.instructions, style: styleFromRow(x),
      phoneId: x.phone_id, secretEnc: x.secret_enc, keyVersion: x.key_version,
    } satisfies Ctx;
  });
}

function tenantActive(c: Ctx): boolean {
  if (c.tenantStatus === "active") return true;
  if (c.tenantStatus === "trial") return !c.trialEndsAt || c.trialEndsAt.getTime() > Date.now();
  return false;
}

type EventKind = "inyeccion" | "fuga_prompt" | "salida_bloqueada" | "limite_contacto";

/** Anota un incidente (solo tipo, mensaje y conversación; nunca el texto). Un reintento no lo duplica. */
async function recordEvent(tenantId: string, conversationId: string, messageId: string, kind: EventKind) {
  await withTenant(tenantId, (db) =>
    db.query(
      "INSERT INTO agent_events (tenant_id, conversation_id, message_id, kind) VALUES ($1, $2, $3, $4) ON CONFLICT (tenant_id, message_id, kind) DO NOTHING",
      [tenantId, conversationId, messageId, kind],
    ),
  );
}

/** Tras este número de mensajes de manipulación en una conversación, se deja de gastar IA y pasa a una persona. */
const INJECTION_STRIKES = 3;

async function handoff(tenantId: string, conversationId: string, reason: string) {
  await withTenant(tenantId, (db) =>
    db.query(
      "UPDATE conversations SET status = 'human', handoff_reason = $3 WHERE tenant_id = $1 AND id = $2 AND status = 'bot'",
      [tenantId, conversationId, reason],
    ),
  );
}

/**
 * Atiende un mensaje entrante: decide si responde, genera la respuesta y la envía.
 * Garantías:
 *  - Una conversación a la vez (candado en Redis).
 *  - Si el cliente escribe varios mensajes seguidos, solo el último genera respuesta (con todo el contexto).
 *  - Una respuesta por mensaje (índice único) y nunca se reenvía a ciegas: si no sabemos si Meta lo recibió, pasa a una persona.
 */
export async function runAgent(job: InboundJob, deps: Partial<AgentDeps> = {}): Promise<AgentOutcome> {
  const first = await loadContext(job);
  if (!first) return "skipped_not_found";
  return withLock(`agent-${first.conversationId}`, LOCK_TTL_MS, () => attend(job, deps));
}

async function attend(job: InboundJob, deps: Partial<AgentDeps>): Promise<AgentOutcome> {
  const { tenantId } = job;
  const ctx = await loadContext(job);
  if (!ctx) return "skipped_not_found";
  if (IGNORED_TYPES.has(ctx.msgType)) return "skipped_ignored_type";
  // Contactos marcados como "personal" (familia, amistades, proveedores…): el asistente nunca les responde.
  if (ctx.contactLabel === "personal") return "skipped_personal";
  if (!ctx.enabled) return "skipped_disabled";
  if (!tenantActive(ctx)) return "skipped_inactive_tenant";
  if (!ctx.phoneId || !ctx.secretEnc || ctx.keyVersion === null) return "skipped_no_whatsapp";

  // ¿Ya hay una respuesta para este mensaje (reintento)?
  const prev = await withTenant(tenantId, async (db) => {
    const r = await db.query("SELECT id, send_state FROM messages WHERE tenant_id = $1 AND reply_to = $2 AND direction = 'out'", [tenantId, ctx.messageId]);
    return r.rows[0] as { id: string; send_state: string } | undefined;
  });
  if (prev) {
    if (prev.send_state === "sending") {
      // Un intento anterior murió a mitad del envío: no sabemos si Meta lo recibió.
      await withTenant(tenantId, (db) =>
        db.query("UPDATE messages SET send_state = 'unknown', send_error = 'el proceso se interrumpió durante el envío' WHERE tenant_id = $1 AND id = $2", [tenantId, prev.id]),
      );
      await handoff(tenantId, ctx.conversationId, "envio_incierto");
      return "send_unknown";
    }
    return prev.send_state === "failed" ? "send_failed" : prev.send_state === "unknown" ? "send_unknown" : "already_replied";
  }

  if (ctx.convStatus !== "bot") return "skipped_human";

  // Intentos de manipulación: se registran y, si la persona insiste, se corta antes de gastar IA.
  if (looksLikeInjection(ctx.body)) {
    await recordEvent(tenantId, ctx.conversationId, ctx.messageId, "inyeccion");
  }
  const strikes = await withTenant(tenantId, async (db) => {
    const r = await db.query("SELECT count(*)::int AS n FROM agent_events WHERE tenant_id = $1 AND conversation_id = $2 AND kind = 'inyeccion'", [tenantId, ctx.conversationId]);
    return r.rows[0].n as number;
  });

  // Si el cliente ya escribió algo más reciente, esa otra tarea responderá con todo el contexto.
  const newer = await withTenant(tenantId, async (db) => {
    const r = await db.query(
      `SELECT 1 FROM messages WHERE tenant_id = $1 AND conversation_id = $2 AND direction = 'in' AND msg_type <> 'reaction'
          AND (received_at, id) > (SELECT received_at, id FROM messages WHERE tenant_id = $1 AND id = $3) LIMIT 1`,
      [tenantId, ctx.conversationId, ctx.messageId],
    );
    return r.rowCount === 1;
  });
  if (newer) return "skipped_superseded";

  // Tope diario de respuestas por negocio.
  const env = getLlmEnv();
  const today = await withTenant(tenantId, async (db) => {
    const r = await db.query(
      `SELECT count(*)::int AS n FROM messages
        WHERE tenant_id = $1 AND direction = 'out' AND reply_to IS NOT NULL AND send_state <> 'failed'
          AND created_at >= (date_trunc('day', now() AT TIME ZONE 'utc') AT TIME ZONE 'utc')`,
      [tenantId],
    );
    return r.rows[0].n as number;
  });
  if (today >= env.AGENT_DAILY_REPLY_LIMIT) {
    await handoff(tenantId, ctx.conversationId, "limite_diario");
    return "limit_reached";
  }

  // Tope mensual del plan (NULL = sin tope). Al llegar, no se gasta IA y la conversación pasa a una persona.
  const monthly = await withTenant(tenantId, async (db) => {
    const plan = await loadPlan(db, tenantId);
    if (!plan || plan.maxRepliesMonth === null) return false;
    return (await repliesThisMonth(db, tenantId)) >= plan.maxRepliesMonth;
  });
  if (monthly) {
    await handoff(tenantId, ctx.conversationId, "limite_plan");
    return "limit_reached";
  }

  // Tope por cliente: cuántas respuestas del asistente recibió esta persona en la última hora y en las últimas 24 horas.
  const perContact = await withTenant(tenantId, async (db) => {
    const r = await db.query(
      `SELECT count(*) FILTER (WHERE m.created_at >= now() - interval '1 hour')::int AS hora,
              count(*)::int AS dia
         FROM messages m JOIN conversations c ON c.tenant_id = m.tenant_id AND c.id = m.conversation_id
        WHERE m.tenant_id = $1 AND c.contact_id = $2 AND m.direction = 'out' AND m.reply_to IS NOT NULL
          AND m.send_state <> 'failed' AND m.created_at >= now() - interval '24 hours'`,
      [tenantId, ctx.contactId],
    );
    return r.rows[0] as { hora: number; dia: number };
  });
  const contactLimited = perContact.hora >= env.AGENT_CONTACT_HOURLY_LIMIT || perContact.dia >= env.AGENT_CONTACT_DAILY_LIMIT;

  // Qué responder.
  const fixed = fixedTexts(ctx.style);
  let text: string;
  let wantsHandoff = false;
  let handoffReason = "pedido_de_persona";
  let usage = { input: 0, output: 0 };
  if (!(TEXT_TYPES.has(ctx.msgType) && ctx.body)) {
    text = fixed.nonText;
  } else if (contactLimited) {
    await recordEvent(tenantId, ctx.conversationId, ctx.messageId, "limite_contacto");
    text = fixed.rateLimited;
    wantsHandoff = true;
    handoffReason = "limite_contacto";
  } else if (strikes >= INJECTION_STRIKES) {
    text = fixed.handoff;
    wantsHandoff = true;
    handoffReason = "intentos_de_manipulacion";
  } else if (customerWantsHuman(ctx.body)) {
    text = fixed.handoff;
    wantsHandoff = true;
  } else {
    const history = await withTenant(tenantId, async (db) => {
      const r = await db.query(
        `SELECT direction, msg_type, body FROM messages
          WHERE tenant_id = $1 AND conversation_id = $2
            AND (direction = 'in' OR send_state = 'sent' OR send_state IS NULL)
          ORDER BY received_at DESC, id DESC LIMIT $3`,
        [tenantId, ctx.conversationId, env.AGENT_HISTORY_MESSAGES],
      );
      return (r.rows as HistoryRow[]).reverse();
    });
    const llm = deps.llm ?? getLlmProvider();
    // Base de conocimiento: si falla (modelo no disponible), se responde sin ella en vez de fallar la respuesta.
    let knowledge: Snippet[] = [];
    try {
      const questions = history.filter((h) => h.direction === "in" && h.msg_type === "text" && h.body).slice(-2).map((h) => h.body as string);
      knowledge = await searchKnowledge(tenantId, questions.join("\n"), deps.embedder ?? getEmbedder());
    } catch (err) {
      console.error("[agente] base de conocimiento no disponible:", err instanceof Error ? err.message : err);
    }
    // Agenda: si el negocio tiene servicios, el asistente recibe un menú cerrado de servicios y horarios libres.
    let menu: AgendaMenu | null = null;
    try {
      menu = await withTenant(tenantId, (db) => buildMenu(db, tenantId, ctx.contactId));
    } catch (err) {
      console.error("[agente] agenda no disponible:", err instanceof Error ? err.message : err);
    }
    // Catálogo: si el negocio tiene productos activos, el asistente recibe una lista cerrada con precios y disponibilidad.
    let catalog: CatalogMenu | null = null;
    try {
      const hints = history.filter((h) => h.direction === "in" && h.msg_type === "text" && h.body).slice(-3).map((h) => h.body as string);
      catalog = await withTenant(tenantId, (db) => buildCatalogMenu(db, tenantId, ctx.contactId, hints));
    } catch (err) {
      console.error("[agente] catálogo no disponible:", err instanceof Error ? err.message : err);
    }
    const canary = newCanary();
    const out = await llm.generate({
      system: buildSystemPrompt({ assistantName: ctx.assistantName, businessName: ctx.tenantName, instructions: ctx.instructions, style: ctx.style, canary, knowledge, agenda: menu?.text, catalog: catalog?.text }),
      messages: buildTurns(history),
      maxTokens: LLM_MAX_TOKENS,
    });
    usage = { input: out.inputTokens, output: out.outputTokens };
    const request = menu ? parseBookingRequest(out.text) : null;
    const orderReq = catalog ? parseOrderRequest(out.text) : null;
    const parsed = parseReply(stripOrderMarkers(stripBookingMarkers(out.text)), fixed.handoff);
    // Revisión de salida: si el modelo filtró sus reglas o inventó enlaces/correos, NO se envía; pasa a una persona.
    const verdict = checkOutput(parsed.text, { canary, rulesLines: [...RULES_LINES, ...AGENDA_RULES_LINES, ...ORDER_RULES_LINES], allowed: allowedContacts([ctx.instructions, ...knowledge.map((k) => k.content)].join("\n")) });
    if (!verdict.ok) {
      await recordEvent(tenantId, ctx.conversationId, ctx.messageId, verdict.kind);
      text = fixed.fallback;
      wantsHandoff = true;
      handoffReason = verdict.kind === "fuga_prompt" ? "fuga_de_instrucciones" : "salida_bloqueada";
    } else if (request && orderReq && !parsed.handoff) {
      // Una cita y un pedido en el mismo mensaje: no se adivina qué quiso el cliente.
      text = fixed.fallback;
      wantsHandoff = true;
      handoffReason = "solicitud_mixta";
    } else if (orderReq && catalog && !parsed.handoff) {
      const ot = orderTexts(ctx.style);
      const c = catalog;
      const res = await withTenant(tenantId, (db) =>
        createAgentOrder(db, { tenantId, contactId: ctx.contactId, conversationId: ctx.conversationId, messageId: ctx.messageId, waId: ctx.waId, contactName: ctx.contactName, menu: c, req: orderReq }),
      );
      if (res.kind === "ok") text = ot.requested(res.name, res.number, res.lines, formatMoney(res.totalMinor, res.currency));
      else if (res.kind === "sin_stock") text = ot.unavailable(res.names);
      else if (res.kind === "limite") {
        text = ot.limit;
        wantsHandoff = true;
        handoffReason = "pedidos_limite";
      } else {
        text = fixed.fallback;
        wantsHandoff = true;
        handoffReason = "pedido_invalido";
      }
    } else if (request && menu && !parsed.handoff) {
      // Pedido de cita: el servidor valida códigos, horario y límites; el mensaje al cliente lo escribe el servidor.
      const bt = bookingTexts(ctx.style);
      const m = menu;
      const res = await withTenant(tenantId, (db) =>
        createAgentAppointment(db, { tenantId, contactId: ctx.contactId, conversationId: ctx.conversationId, messageId: ctx.messageId, waId: ctx.waId, contactName: ctx.contactName, menu: m, req: request }),
      );
      if (res.kind === "ok") text = bt.requested(res.name, res.serviceName, whenLabel(res.startsAt, m.timezone));
      else if (res.kind === "ocupado") text = bt.slotTaken;
      else if (res.kind === "limite") {
        text = bt.limit;
        wantsHandoff = true;
        handoffReason = "citas_limite";
      } else {
        // Códigos que no están en el menú de este turno: no se crea nada y pasa a una persona.
        text = fixed.fallback;
        wantsHandoff = true;
        handoffReason = "cita_invalida";
      }
    } else if (!parsed.text) {
      text = fixed.fallback;
      wantsHandoff = true;
      handoffReason = "respuesta_vacia";
    } else {
      text = parsed.text;
      wantsHandoff = parsed.handoff;
    }
  }

  // Descifrar el token ANTES de crear la fila "sending": si falla aquí, no hay nada a medias.
  const token = decryptSecret(ctx.secretEnc, `wa:${tenantId}:${ctx.phoneId}`, ctx.keyVersion);

  // Anotar la respuesta como "sending" ANTES de enviar (bandeja de salida). Si el proceso muere
  // después del envío, el reintento verá esta fila y no volverá a mandar el mensaje.
  const reserved = await withTenant(tenantId, async (db) => {
    const c = await db.query("SELECT status FROM conversations WHERE tenant_id = $1 AND id = $2 FOR SHARE", [tenantId, ctx.conversationId]);
    if (c.rows[0]?.status !== "bot") return "human" as const; // una persona tomó la conversación mientras pensábamos
    const r = await db.query(
      `INSERT INTO messages (tenant_id, conversation_id, direction, msg_type, body, reply_to, send_state)
       VALUES ($1, $2, 'out', 'text', $3, $4, 'sending')
       ON CONFLICT (tenant_id, reply_to) WHERE direction = 'out' AND reply_to IS NOT NULL DO NOTHING
       RETURNING id`,
      [tenantId, ctx.conversationId, text, ctx.messageId],
    );
    return r.rowCount ? (r.rows[0].id as string) : ("dup" as const);
  });
  if (reserved === "human") return "skipped_human";
  if (reserved === "dup") return "already_replied";
  const outId = reserved;

  const result = await (deps.send ?? sendText)(ctx.phoneId, token, ctx.waId, text);

  switch (result.kind) {
    case "sent": {
      await withTenant(tenantId, async (db) => {
        await db.query("UPDATE messages SET wa_message_id = $3, send_state = 'sent' WHERE tenant_id = $1 AND id = $2", [tenantId, outId, result.waMessageId]);
        await db.query("UPDATE conversations SET last_message_at = now() WHERE tenant_id = $1 AND id = $2", [tenantId, ctx.conversationId]);
        await db.query(
          `INSERT INTO agent_usage_daily (tenant_id, day, replies, input_tokens, output_tokens)
           VALUES ($1, (now() AT TIME ZONE 'utc')::date, 1, $2, $3)
           ON CONFLICT (tenant_id, day) DO UPDATE SET replies = agent_usage_daily.replies + 1,
             input_tokens = agent_usage_daily.input_tokens + EXCLUDED.input_tokens,
             output_tokens = agent_usage_daily.output_tokens + EXCLUDED.output_tokens`,
          [tenantId, usage.input, usage.output],
        );
      });
      if (wantsHandoff) {
        await handoff(tenantId, ctx.conversationId, handoffReason);
        return "handoff";
      }
      return "replied";
    }
    case "retry": {
      // No llegó a Meta: se borra la fila y se reintenta todo el trabajo más tarde.
      await withTenant(tenantId, (db) => db.query("DELETE FROM messages WHERE tenant_id = $1 AND id = $2 AND send_state = 'sending'", [tenantId, outId]));
      throw new Error(`No se pudo enviar todavía (${result.reason}); se reintentará`);
    }
    case "rejected": {
      await withTenant(tenantId, (db) =>
        db.query("UPDATE messages SET send_state = 'failed', send_error = $3 WHERE tenant_id = $1 AND id = $2", [tenantId, outId, `${result.code ?? result.status}: ${result.message}`.slice(0, 300)]),
      );
      await handoff(tenantId, ctx.conversationId, "envio_rechazado");
      return "send_failed";
    }
    case "unknown": {
      await withTenant(tenantId, (db) =>
        db.query("UPDATE messages SET send_state = 'unknown', send_error = $3 WHERE tenant_id = $1 AND id = $2", [tenantId, outId, result.reason.slice(0, 300)]),
      );
      await handoff(tenantId, ctx.conversationId, "envio_incierto");
      return "send_unknown";
    }
  }
}
EOF_SRC_LIB_AGENT_RUN_TS
echo "✔ src/lib/agent/run.ts"
mkdir -p src/components
cat > src/components/SimulatorChat.tsx <<'EOF_SRC_COMPONENTS_SIMULATORCHAT_TSX'
"use client";

import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";

interface Msg {
  id: string;
  direction: "in" | "out";
  msg_type: string;
  body: string | null;
  send_state: string | null;
  send_error: string | null;
  process_state: string;
}
interface State {
  sendMode: "meta" | "simulate";
  agentEnabled: boolean;
  whatsappReady: boolean;
  conversation: { status: string; handoffReason: string | null } | null;
  messages: Msg[];
}

const REASON: Record<string, string> = {
  pedido_de_persona: "El cliente pidió hablar con una persona.",
  limite_diario: "Se alcanzó el tope diario de respuestas.",
  limite_plan: "Se alcanzó el tope mensual de respuestas de tu plan.",
  envio_rechazado: "Meta rechazó el envío del mensaje.",
  envio_incierto: "No se sabe si el mensaje salió; una persona debe revisarlo.",
  limite_contacto: "Este cliente alcanzó el tope de respuestas por hora o por día.",
  intentos_de_manipulacion: "El cliente insistió en manipular al asistente; lo atiende una persona.",
  fuga_de_instrucciones: "El asistente iba a revelar sus instrucciones internas; se bloqueó la respuesta.",
  salida_bloqueada: "La respuesta traía un enlace o correo que el negocio no escribió; se bloqueó.",
  respuesta_vacia: "El asistente no generó una respuesta.",
  agente_fallo: "El asistente no pudo procesar el mensaje.",
};

const WAIT_HINT_MS = 12_000;

export function SimulatorChat() {
  const [state, setState] = useState<State | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [waitingSince, setWaitingSince] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const listRef = useRef<HTMLDivElement>(null);
  const textRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/dev/simulador", { cache: "no-store" });
      if (!res.ok) {
        const d = (await res.json().catch(() => ({}))) as { message?: string };
        setError(d.message ?? "No se pudo cargar el simulador.");
        return;
      }
      setState((await res.json()) as State);
      setError(null);
    } catch {
      setError("No hay conexión con el servidor local. ¿Sigue corriendo `npm run dev`?");
    }
  }, []);

  useEffect(() => {
    const first = setTimeout(() => void load(), 0);
    const t = setInterval(() => {
      setNow(Date.now());
      void load();
    }, 1500);
    return () => {
      clearTimeout(first);
      clearInterval(t);
    };
  }, [load]);

  const last = state?.messages[state.messages.length - 1];
  const pendingReply = !!last && last.direction === "in" && state?.conversation?.status === "bot" && !!state?.agentEnabled;
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- el cronómetro de espera se deriva de los datos que llegan por sondeo
    setWaitingSince((prev) => (pendingReply ? (prev ?? Date.now()) : null));
  }, [pendingReply]);

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
  }, [state?.messages.length]);

  async function post(body: unknown): Promise<boolean> {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/dev/simulador", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      if (!res.ok) {
        const d = (await res.json().catch(() => ({}))) as { message?: string };
        setError(d.message ?? "No se pudo completar la acción.");
        return false;
      }
      await load();
      return true;
    } catch {
      setError("No hay conexión con el servidor local.");
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function send(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const text = (textRef.current?.value ?? "").trim();
    if (!text || busy) return;
    if (await post({ action: "send", text })) {
      if (textRef.current) textRef.current.value = "";
      textRef.current?.focus();
    }
  }

  const status = state?.conversation?.status;
  const slow = waitingSince !== null && now - waitingSince > WAIT_HINT_MS;

  return (
    <section className="card-light" style={{ maxWidth: 720 }}>
      <p className="eyebrow">Solo desarrollo</p>
      <h2 className="mt-3 text-[28px]">Simulador de WhatsApp</h2>
      <p className="muted mt-3">
        Escribe como si fueras un cliente. El mensaje pasa por la misma ruta real (base de datos, cola y asistente), pero no sale a WhatsApp.
      </p>

      {state && !state.agentEnabled && (
        <p className="alert-warn mt-4" role="status">
          El asistente está apagado: nadie responderá. Actívalo en <a className="link" href="/agente">Asistente</a>.
        </p>
      )}
      {state && state.sendMode === "meta" && (
        <p className="alert-warn mt-4" role="status">
          Atención: tu entorno está en modo <strong>meta</strong>, así que las respuestas SÍ se enviarían por WhatsApp si el número es real. Para probar sin
          enviar nada, pon WHATSAPP_SEND_MODE=simulate en .env.local y reinicia.
        </p>
      )}

      <div className="mt-6 flex flex-wrap items-center gap-3">
        <span className="badge" style={{ background: "var(--color-mint-frost)", color: "var(--color-ink)", border: "1px solid var(--color-fog-border)" }}>{status === "human" ? "En manos de una persona" : status === "bot" ? "Atiende el asistente" : "Sin conversación"}</span>
        <button type="button" className="btn btn-ghost-light btn-sm" disabled={busy} onClick={() => post({ action: "reset" })}>
          Nueva conversación
        </button>
      </div>
      {status === "human" && (
        <p className="muted mt-3" role="status">
          {REASON[state?.conversation?.handoffReason ?? ""] ?? "Pasó a una persona."} El asistente ya no responde aquí. Pulsa «Nueva conversación» para seguir probando.
        </p>
      )}

      <div
        ref={listRef}
        className="mt-5 flex flex-col gap-3 overflow-y-auto"
        style={{ height: 380, padding: 16, background: "var(--color-pure-white)", border: "1.5px solid var(--color-fog-border)", borderRadius: "var(--radius-small)" }}
        role="log"
        aria-live="polite"
        aria-label="Conversación de prueba"
      >
        {state && state.messages.length === 0 && <p className="muted">Aún no hay mensajes. Escribe el primero abajo.</p>}
        {state?.messages.map((m) => {
          const mine = m.direction === "in"; // "in" = lo que escribe el cliente simulado
          return (
            <div key={m.id} style={{ alignSelf: mine ? "flex-end" : "flex-start", maxWidth: "82%" }}>
              <div
                style={{
                  padding: "10px 14px",
                  borderRadius: 16,
                  whiteSpace: "pre-wrap",
                  overflowWrap: "anywhere",
                  background: mine ? "var(--color-ink)" : "var(--color-mint-frost)",
                  color: mine ? "var(--color-pure-white)" : "var(--color-ink)",
                  border: mine ? "none" : "1px solid var(--color-fog-border)",
                }}
              >
                {m.body ?? `(${m.msg_type})`}
              </div>
              <p className="muted" style={{ fontSize: 12, marginTop: 4, textAlign: mine ? "right" : "left" }}>
                {mine ? "Cliente (tú)" : "Asistente"}
                {!mine && m.send_state && m.send_state !== "sent" ? ` · envío: ${m.send_state}${m.send_error ? ` (${m.send_error})` : ""}` : ""}
              </p>
            </div>
          );
        })}
        {pendingReply && !slow && <p className="muted" style={{ alignSelf: "flex-start" }}>El asistente está escribiendo…</p>}
      </div>

      {slow && (
        <p className="alert-warn mt-4" role="status">
          Pasaron más de 12 segundos sin respuesta. Revisa que <strong>npm run worker</strong> esté corriendo (o usa <strong>npm run dev:all</strong>).
        </p>
      )}
      <div role="alert" aria-live="assertive">{error && <p className="alert-error mt-4">{error}</p>}</div>

      <form onSubmit={send} className="mt-4 flex gap-3">
        <label htmlFor="sim-text" className="sr-only" style={{ position: "absolute", width: 1, height: 1, overflow: "hidden", clip: "rect(0 0 0 0)" }}>
          Mensaje del cliente
        </label>
        <input id="sim-text" ref={textRef} className="input" placeholder="Escribe como si fueras el cliente…" maxLength={1000} autoComplete="off" disabled={busy} />
        <button type="submit" className="btn btn-primary" disabled={busy}>
          Enviar
        </button>
      </form>
    </section>
  );
}
EOF_SRC_COMPONENTS_SIMULATORCHAT_TSX
echo "✔ src/components/SimulatorChat.tsx"
mkdir -p src/components
cat > src/components/PlanCard.tsx <<'EOF_SRC_COMPONENTS_PLANCARD_TSX'
"use client";

import { useEffect, useState } from "react";
import { PLAN_MODULE_LABEL, type PlanUsage, type QuotaState } from "@/lib/plans/usage";

type Data = PlanUsage & { repliesState: QuotaState; membersState: QuotaState };

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
      </p>
    </section>
  );
}
EOF_SRC_COMPONENTS_PLANCARD_TSX
echo "✔ src/components/PlanCard.tsx"
mkdir -p src/components
cat > src/components/PlanEditor.tsx <<'EOF_SRC_COMPONENTS_PLANEDITOR_TSX'
"use client";

import { useRouter } from "next/navigation";
import { useId, useState, type FormEvent } from "react";
import { PLAN_MODULES, PLAN_MODULE_LABEL, type PlanInfo, type PlanModule } from "@/lib/plans/usage";

export type AdminPlan = PlanInfo & { active: boolean; isDefault: boolean };

function Row({ plan }: { plan: AdminPlan }) {
  const router = useRouter();
  const uid = useId();
  const lab = { color: "var(--color-pure-white)" } as const; // las etiquetas por defecto son oscuras (para tarjetas claras)
  const [name, setName] = useState(plan.name);
  const [replies, setReplies] = useState(plan.maxRepliesMonth === null ? "" : String(plan.maxRepliesMonth));
  const [members, setMembers] = useState(String(plan.maxMembers));
  const [mods, setMods] = useState<PlanModule[]>(plan.modules);
  const [active, setActive] = useState(plan.active);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  async function save(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setMsg(null);
    try {
      const res = await fetch("/api/admin/plans", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ planId: plan.id, name, maxRepliesMonth: replies.trim() === "" ? null : Number(replies), maxMembers: Number(members), modules: mods, active }),
      });
      const d = (await res.json().catch(() => ({}))) as { message?: string };
      setMsg(res.ok ? { ok: true, text: "Guardado." } : { ok: false, text: d.message ?? "No se pudo guardar." });
      if (res.ok) router.refresh();
    } catch {
      setMsg({ ok: false, text: "Sin conexión." });
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={save} className="card-dark grid gap-4" aria-label={`Plan ${plan.name}`}>
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-lg">{plan.slug}</h3>
        {plan.isDefault && <span className="badge">Por defecto (planes nuevos)</span>}
      </div>
      <div className="grid gap-4 md:grid-cols-4">
        <div className="field">
          <label htmlFor={`${uid}-n`} style={lab}>Nombre</label>
          <input id={`${uid}-n`} className="input" style={{ background: "#fff" }} value={name} onChange={(e) => setName(e.target.value)} maxLength={60} required />
        </div>
        <div className="field">
          <label htmlFor={`${uid}-r`} style={lab}>Respuestas al mes</label>
          <input id={`${uid}-r`} className="input" style={{ background: "#fff" }} type="number" min={0} max={10000000} step={1} value={replies} onChange={(e) => setReplies(e.target.value)} placeholder="Sin tope" />
        </div>
        <div className="field">
          <label htmlFor={`${uid}-m`} style={lab}>Personas del equipo</label>
          <input id={`${uid}-m`} className="input" style={{ background: "#fff" }} type="number" min={1} max={1000} step={1} value={members} onChange={(e) => setMembers(e.target.value)} required />
        </div>
        <div className="field">
          <span className="text-sm">Estado</span>
          <label className="flex items-center gap-2 text-sm" style={lab}>
            <input type="checkbox" checked={active} disabled={plan.isDefault} onChange={(e) => setActive(e.target.checked)} /> Activo (se puede asignar)
          </label>
        </div>
      </div>
      <fieldset>
        <legend className="text-sm">Módulos incluidos (se aplican en el próximo paso)</legend>
        <div className="mt-2 flex flex-wrap gap-4">
          {PLAN_MODULES.map((m) => (
            <label key={m} className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={mods.includes(m)} onChange={(e) => setMods(e.target.checked ? [...mods, m] : mods.filter((x) => x !== m))} />
              {PLAN_MODULE_LABEL[m]}
            </label>
          ))}
        </div>
      </fieldset>
      <div className="flex flex-wrap items-center gap-3">
        <button type="submit" className="btn btn-primary btn-sm" disabled={busy}>{busy ? "Guardando…" : "Guardar plan"}</button>
        {msg && <span role={msg.ok ? "status" : "alert"} className="text-sm" style={msg.ok ? undefined : { color: "var(--color-danger-on-dark)" }}>{msg.text}</span>}
      </div>
    </form>
  );
}

export function PlanEditor({ plans }: { plans: AdminPlan[] }) {
  return (
    <section aria-label="Planes" className="mt-8 flex flex-col gap-4">
      <h2 className="text-2xl">Planes</h2>
      <p className="muted-dark max-w-xl text-sm">
        Los límites se aplican al instante. «Sin tope» = respuestas ilimitadas. Un cambio de nombre no afecta a los negocios que ya lo tienen.
      </p>
      {plans.map((p) => <Row key={p.id} plan={p} />)}
    </section>
  );
}
EOF_SRC_COMPONENTS_PLANEDITOR_TSX
echo "✔ src/components/PlanEditor.tsx"
mkdir -p src/components
cat > src/components/TenantActions.tsx <<'EOF_SRC_COMPONENTS_TENANTACTIONS_TSX'
"use client";

import { useRouter } from "next/navigation";
import { useId, useState, type FormEvent } from "react";

export function TenantActions({ tenantId, status, planId, plans }: { tenantId: string; status: string; planId: string; plans: { id: string; name: string; active: boolean }[] }) {
  const router = useRouter();
  const uid = useId();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [plan, setPlan] = useState(planId);

  async function send(url: string, body: unknown) {
    setPending(true);
    setError(null);
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as { message?: string } | null;
        setError(data?.message ?? "No se pudo completar.");
        return false;
      }
      return true;
    } catch {
      setError("Sin conexión.");
      return false;
    } finally {
      setPending(false);
    }
  }

  async function enter(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const reason = String(new FormData(e.currentTarget).get("reason") ?? "");
    if (await send("/api/admin/impersonation", { tenantId, reason })) {
      router.push("/panel");
      router.refresh();
    }
  }

  async function toggleSuspend() {
    const next = status === "suspended" ? "active" : "suspended";
    const verb = next === "suspended" ? "suspender" : "reactivar";
    if (!window.confirm(`¿Seguro que quieres ${verb} este negocio?`)) return;
    if (await send("/api/admin/tenant-status", { tenantId, status: next })) router.refresh();
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap gap-2">
        <button type="button" className="btn btn-primary btn-sm" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
          Entrar como soporte
        </button>
        <button type="button" className="btn btn-ghost-dark btn-sm" onClick={toggleSuspend} disabled={pending}>
          {status === "suspended" ? "Reactivar" : "Suspender"}
        </button>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <label htmlFor={`${uid}-plan`} className="text-sm">Plan</label>
        <select id={`${uid}-plan`} className="input" style={{ background: "#fff", width: "auto" }} value={plan} onChange={(e) => setPlan(e.target.value)} disabled={pending}>
          {plans.map((p) => <option key={p.id} value={p.id} disabled={!p.active && p.id !== planId}>{p.name}{p.active ? "" : " (inactivo)"}</option>)}
        </select>
        <button type="button" className="btn btn-ghost-dark btn-sm" disabled={pending || plan === planId} onClick={async () => { if (await send("/api/admin/tenant-plan", { tenantId, planId: plan })) router.refresh(); }}>
          Cambiar plan
        </button>
      </div>
      {open && (
        <form onSubmit={enter} className="flex flex-col gap-2">
          <label htmlFor={`${uid}-motivo`} className="text-sm">
            Motivo (queda registrado y lo ve el dueño)
          </label>
          <textarea
            id={`${uid}-motivo`}
            name="reason"
            required
            minLength={10}
            maxLength={500}
            rows={2}
            className="input"
            style={{ background: "#fff" }}
            placeholder="Ej.: Ticket 123, revisar configuración del horario"
          />
          <button type="submit" className="btn btn-primary btn-sm self-start" disabled={pending}>
            {pending ? "Entrando…" : "Confirmar y entrar"}
          </button>
        </form>
      )}
      {error && (
        <p role="alert" className="text-sm" style={{ color: "var(--color-danger-on-dark)" }}>
          {error}
        </p>
      )}
    </div>
  );
}
EOF_SRC_COMPONENTS_TENANTACTIONS_TSX
echo "✔ src/components/TenantActions.tsx"
mkdir -p src/app/panel
cat > src/app/panel/page.tsx <<'EOF_SRC_APP_PANEL_PAGE_TSX'
import { PlanCard } from "@/components/PlanCard";
import type { Metadata } from "next";
import { headers } from "next/headers";
import Link from "next/link";
import { redirect } from "next/navigation";
import { Suspense } from "react";
import { AppHeader, ROLE_LABEL } from "@/components/AppHeader";
import { StopImpersonationButton } from "@/components/StopImpersonationButton";
import { effectiveTenant, getSessionFromHeaders } from "@/lib/auth/session";
import { can } from "@/lib/auth/permissions";
import { withTenant } from "@/lib/db";

export const metadata: Metadata = { title: "Panel" };

const STATUS_LABEL: Record<string, string> = {
  trial: "Prueba gratis",
  active: "Activa",
  past_due: "Pago pendiente",
  suspended: "Suspendida",
};

export default function PanelPage() {
  return (
    <Suspense fallback={<div className="container-app py-24 muted-dark" role="status">Cargando…</div>}>
      <PanelContent />
    </Suspense>
  );
}

async function PanelContent() {
  const auth = await getSessionFromHeaders(await headers());
  if (!auth) redirect("/entrar");
  const { session } = auth;
  if (session.needsMfaSetup) redirect("/seguridad");
  const ctx = effectiveTenant(session);

  const tenant = ctx
    ? await withTenant(ctx.tenantId, async (db) => {
        const r = await db.query<{ name: string; status: string; days_left: number | null }>(
          `SELECT name, status,
                  GREATEST(0, CEIL(EXTRACT(EPOCH FROM (trial_ends_at - now())) / 86400))::int AS days_left
           FROM tenants`,
        );
        return r.rows[0] ?? null;
      })
    : null;

  const daysLeft = tenant?.status === "trial" ? tenant.days_left : null;

  return (
    <div className="flex min-h-screen flex-col">
      {ctx?.impersonating && tenant && (
        <div className="alert-warn flex flex-wrap items-center justify-between gap-3" style={{ borderRadius: 0 }} role="status">
          <span>
            Estás viendo <strong>{tenant.name}</strong> como soporte (máximo 30 minutos). Todo queda registrado y el dueño puede verlo.
          </span>
          <StopImpersonationButton />
        </div>
      )}

      <AppHeader
        email={session.email}
        roleLabel={ctx ? (ctx.impersonating ? "Soporte" : ROLE_LABEL[ctx.role]) : "Súper admin"}
        showAdmin={session.isSuperAdmin}
        showTeam={!!ctx && can(ctx.role, "team:manage")}
        showWork={!!ctx}
      />

      <main className="container-app flex-1 pb-24 pt-8">
        {!ctx || !tenant ? (
          <section className="card-light" style={{ maxWidth: 640 }}>
            <p className="eyebrow">Sin negocio</p>
            <h1 className="mt-3 text-[32px]">No tienes un negocio activo</h1>
            <p className="muted mt-3">
              {session.isSuperAdmin ? (
                <>
                  Entra desde <Link href="/admin" className="link">Administración</Link> para ver un negocio como soporte.
                </>
              ) : (
                "Pide acceso a quien administra tu negocio."
              )}
            </p>
          </section>
        ) : (
          <>
            <p className="eyebrow eyebrow--dark">Tu negocio</p>
            <h1 className="mt-3 text-[32px] sm:text-[48px]" style={{ lineHeight: 1.12 }}>
              {tenant.name}
            </h1>
            <div className="mt-4 flex flex-wrap items-center gap-3">
              <span className="badge">{STATUS_LABEL[tenant.status] ?? tenant.status}</span>
              {daysLeft !== null && (
                <span className="muted-dark text-sm">
                  {daysLeft === 1 ? "Queda 1 día de prueba" : `Quedan ${daysLeft} días de prueba`}
                </span>
              )}
            </div>

            {tenant.status === "suspended" && !ctx.impersonating && (
              <p className="alert-warn mt-8" role="alert">
                Esta cuenta está suspendida. Escríbenos para reactivarla.
              </p>
            )}

            <PlanCard />

            <section className="mt-12 grid gap-6 md:grid-cols-3" aria-label="Próximos pasos">
              <article className="card-dark">
                <p className="eyebrow eyebrow--dark">Paso 1</p>
                <h2 className="mt-2 text-xl">Conecta tu WhatsApp</h2>
                <p className="muted-dark mt-2 text-sm">
                  <Link href="/whatsapp" className="link">Conectar mi número</Link>
                </p>
              </article>
              <article className="card-dark">
                <p className="eyebrow eyebrow--dark">Paso 2</p>
                <h2 className="mt-2 text-xl">Cuéntale a tu agente cómo atiendes</h2>
                <p className="muted-dark mt-2 text-sm">
                  Horarios, servicios y preguntas frecuentes. <Link href="/agente" className="link">Configurar el asistente</Link>
                </p>
              </article>
              <article className="card-dark">
                <p className="eyebrow eyebrow--dark">Paso 3</p>
                <h2 className="mt-2 text-xl">Invita a tu equipo</h2>
                <p className="muted-dark mt-2 text-sm">
                  {can(ctx.role, "team:manage") ? "Podrás añadir agentes y administradores." : "Solo administradores y dueños pueden invitar personas."}
                </p>
              </article>
            </section>
          </>
        )}
      </main>
    </div>
  );
}
EOF_SRC_APP_PANEL_PAGE_TSX
echo "✔ src/app/panel/page.tsx"
mkdir -p src/app/admin
cat > src/app/admin/page.tsx <<'EOF_SRC_APP_ADMIN_PAGE_TSX'
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
mkdir -p tests
cat > tests/plans.test.ts <<'EOF_TESTS_PLANS_TEST_TS'
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GET as adminTenants } from "@/app/api/admin/tenants/route";
import { POST as adminPlans } from "@/app/api/admin/plans/route";
import { POST as adminTenantPlan } from "@/app/api/admin/tenant-plan/route";
import { POST as login } from "@/app/api/auth/login/route";
import { POST as signup } from "@/app/api/auth/signup/route";
import { POST as verify2fa } from "@/app/api/auth/2fa/verify/route";
import { GET as me } from "@/app/api/me/route";
import { GET as planGet } from "@/app/api/plan/route";
import { POST as teamInvite } from "@/app/api/team/invite/route";
import { POST as teamInvitation } from "@/app/api/team/invitation/route";
import { GET as teamGet } from "@/app/api/team/route";
import { hashPassword } from "@/lib/auth/password";
import { getPool, withTenant } from "@/lib/db";
import { loadPlan, loadPlanUsage, quotaState, repliesThisMonth } from "@/lib/plans/usage";
import { tokenHashOf } from "@/lib/auth/session";
import { codeFor, enableMfaDirect } from "./mfa-helpers";

const RUN = randomUUID().slice(0, 8);
const ORIGIN = new URL(process.env.APP_URL!).origin;
const PASSWORD = "contraseña-de-prueba-123";
const owner = new Pool({ connectionString: process.env.MIGRATION_DATABASE_URL, max: 2 });
const tenantIds: string[] = [];
const planIds: string[] = [];

const req = (method: string, path: string, cookie?: string, body?: unknown, origin = ORIGIN) =>
  new Request(`${ORIGIN}${path}`, { method, headers: { origin, ...(body !== undefined ? { "content-type": "application/json" } : {}), ...(cookie ? { cookie } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
const cookieOf = (res: Response) => (res.headers.get("set-cookie") ?? "").split(";")[0]!;

async function register(name: string) {
  const res = await signup(req("POST", "/api/auth/signup", undefined, { email: `pl-${RUN}-${name}@example.test`, password: PASSWORD, businessName: `Negocio ${name}` }));
  expect(res.status).toBe(201);
  const cookie = cookieOf(res);
  const info = await (await me(req("GET", "/api/me", cookie))).json();
  tenantIds.push(info.tenant.id);
  return { cookie, tenantId: info.tenant.id as string };
}
type T = Awaited<ReturnType<typeof register>>;

async function makeSuperAdmin(name: string) {
  const addr = `pl-${RUN}-${name}@example.test`;
  const ins = await owner.query<{ id: string }>("INSERT INTO users (email, password_hash, is_super_admin) VALUES ($1,$2,true) RETURNING id", [addr, await hashPassword(PASSWORD)]);
  const secret = await enableMfaDirect(owner, ins.rows[0]!.id);
  const res = await login(req("POST", "/api/auth/login", undefined, { email: addr, password: PASSWORD }));
  const ver = await verify2fa(req("POST", "/api/auth/2fa/verify", cookieOf(res), { code: codeFor(secret) }));
  expect(ver.status).toBe(200);
  return cookieOf(ver);
}

/** Crea un plan de prueba (solo para estos tests) y lo devuelve. */
async function mkPlan(o: { replies?: number | null; members?: number; modules?: string[]; active?: boolean } = {}) {
  const slug = `t-${RUN}-${planIds.length}`;
  const r = await owner.query<{ id: string }>(
    "INSERT INTO plans (slug, name, position, max_replies_month, max_members, modules, active) VALUES ($1,$2,99,$3,$4,$5,$6) RETURNING id",
    [slug, `Prueba ${slug}`, o.replies === undefined ? 100 : o.replies, o.members ?? 5, o.modules ?? ["agenda"], o.active ?? true],
  );
  planIds.push(r.rows[0]!.id);
  return r.rows[0]!.id;
}
/** Asigna un plan saltándose el guardia (en producción solo lo hace admin_set_tenant_plan). */
async function setPlan(tenantId: string, planId: string) {
  const c = await owner.connect();
  try {
    await c.query("BEGIN");
    await c.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
    await c.query("ALTER TABLE tenants DISABLE TRIGGER tenants_plan_guard");
    await c.query("UPDATE tenants SET plan_id = $2 WHERE id = $1", [tenantId, planId]);
    await c.query("ALTER TABLE tenants ENABLE TRIGGER tenants_plan_guard");
    await c.query("COMMIT");
  } catch (e) { await c.query("ROLLBACK"); throw e; } finally { c.release(); }
}
const planOf = (t: T) => withTenant(t.tenantId, async (db) => (await db.query("SELECT plan_id FROM tenants WHERE id = $1", [t.tenantId])).rows[0].plan_id as string);
const addUsage = (t: T, daysAgoSql: string, replies: number) =>
  withTenant(t.tenantId, (db) => db.query(`INSERT INTO agent_usage_daily (tenant_id, day, replies) VALUES ($1, ${daysAgoSql}, $2)`, [t.tenantId, replies]));

beforeAll(async () => { await getPool().query("SELECT 1"); });
afterAll(async () => {
  await owner.query("DELETE FROM users WHERE email LIKE $1", [`pl-${RUN}-%`]);
  for (const id of tenantIds) {
    const c = await owner.connect();
    try {
      await c.query("BEGIN");
      await c.query("SELECT set_config('app.tenant_id', $1, true)", [id]);
      await c.query("ALTER TABLE audit_log DISABLE TRIGGER audit_log_sin_cambios");
      await c.query("DELETE FROM audit_log WHERE tenant_id = $1", [id]);
      await c.query("ALTER TABLE audit_log ENABLE TRIGGER audit_log_sin_cambios");
      const del = await c.query("DELETE FROM tenants WHERE id = $1", [id]);
      if (del.rowCount !== 1) throw new Error("La limpieza no borró el negocio de prueba " + id);
      await c.query("COMMIT");
    } catch (e) { await c.query("ROLLBACK"); throw e; } finally { c.release(); }
  }
  if (planIds.length) await owner.query("DELETE FROM plans WHERE id = ANY($1)", [planIds]);
  await owner.end();
  await getPool().end();
});

describe("quotaState", () => {
  it.each<[number, number | null, string]>([[5, null, "unlimited"], [0, 10, "ok"], [7, 10, "ok"], [8, 10, "near"], [9, 10, "near"], [10, 10, "full"], [11, 10, "full"], [0, 0, "full"], [1, 100, "ok"], [80, 100, "near"], [79, 100, "ok"]])("%i de %s → %s", (u, m, s) => {
    expect(quotaState(u, m)).toBe(s);
  });
});

describe("planes iniciales", () => {
  it("existen tres planes provisionales y uno solo es el de por defecto", async () => {
    const r = await getPool().query("SELECT slug, name, is_default, active, max_replies_month, max_members, modules FROM plans WHERE slug LIKE 'plan-%' ORDER BY position");
    expect(r.rows.map((p) => p.slug)).toEqual(["plan-1", "plan-2", "plan-3"]);
    expect(r.rows.map((p) => p.is_default)).toEqual([true, false, false]);
    const d = await getPool().query("SELECT count(*)::int AS n FROM plans WHERE is_default");
    expect(d.rows[0].n).toBe(1);
  });
  it("un negocio nuevo recibe el plan por defecto", async () => {
    const t = await register("nuevo");
    const plan = await withTenant(t.tenantId, (db) => loadPlan(db, t.tenantId));
    expect(plan).toMatchObject({ slug: "plan-1", maxMembers: 3 });
  });
  it("la aplicación no puede crear, cambiar ni borrar planes", async () => {
    await expect(getPool().query("INSERT INTO plans (slug, name, max_members) VALUES ('hack', 'x', 1)")).rejects.toThrow(/permission denied/);
    await expect(getPool().query("UPDATE plans SET max_members = 1000")).rejects.toThrow(/permission denied/);
    await expect(getPool().query("DELETE FROM plans")).rejects.toThrow(/permission denied/);
  });
  it("las restricciones de la tabla se cumplen", async () => {
    const bad = (cols: string, vals: unknown[]) => owner.query(`INSERT INTO plans (${cols}) VALUES (${vals.map((_, i) => `$${i + 1}`).join(",")})`, vals);
    await expect(bad("slug, name, max_members", ["A", "x", 1])).rejects.toThrow(); // slug en mayúscula
    await expect(bad("slug, name, max_members", [`ok-${RUN}-a`, "", 1])).rejects.toThrow(); // nombre vacío
    await expect(bad("slug, name, max_members", [`ok-${RUN}-b`, "x", 0])).rejects.toThrow(); // 0 personas
    await expect(bad("slug, name, max_members, max_replies_month", [`ok-${RUN}-c`, "x", 1, -1])).rejects.toThrow();
    await expect(bad("slug, name, max_members, modules", [`ok-${RUN}-d`, "x", 1, ["otro"]])).rejects.toThrow(); // módulo inventado
    await expect(bad("slug, name, max_members, is_default", [`ok-${RUN}-e`, "x", 1, true])).rejects.toThrow(); // dos por defecto
    await expect(bad("slug, name, max_members, is_default, active", [`ok-${RUN}-f`, "x", 1, true, false])).rejects.toThrow();
  });
});

describe("consumo del mes", () => {
  it("cuenta solo las respuestas del mes calendario actual", async () => {
    const t = await register("uso");
    await addUsage(t, "date_trunc('month', now() AT TIME ZONE 'utc')::date", 4); // 1.º del mes
    await addUsage(t, "(date_trunc('month', now() AT TIME ZONE 'utc') - interval '1 day')::date", 50); // último día del mes anterior
    await addUsage(t, "(date_trunc('month', now() AT TIME ZONE 'utc') - interval '40 days')::date", 70);
    expect(await withTenant(t.tenantId, (db) => repliesThisMonth(db, t.tenantId))).toBe(4);
  });
  it("sin consumo es 0 y los negocios no se mezclan", async () => {
    const a = await register("uso-a");
    const b = await register("uso-b");
    await addUsage(a, "(now() AT TIME ZONE 'utc')::date", 9);
    expect(await withTenant(a.tenantId, (db) => repliesThisMonth(db, a.tenantId))).toBe(9);
    expect(await withTenant(b.tenantId, (db) => repliesThisMonth(db, b.tenantId))).toBe(0);
  });
  it("GET /api/plan devuelve plan, uso y estados", async () => {
    const t = await register("api");
    const p = await mkPlan({ replies: 10, members: 4 });
    await setPlan(t.tenantId, p);
    await addUsage(t, "(now() AT TIME ZONE 'utc')::date", 8);
    const body = await (await planGet(req("GET", "/api/plan", t.cookie))).json();
    expect(body).toMatchObject({ repliesThisMonth: 8, members: 1, pendingInvitations: 0, repliesState: "near", membersState: "ok" });
    expect(body.plan).toMatchObject({ maxRepliesMonth: 10, maxMembers: 4, modules: ["agenda"] });
  });
  it("sin sesión no se ve el plan; plan sin tope = ilimitado", async () => {
    expect((await planGet(req("GET", "/api/plan"))).status).toBe(401);
    const t = await register("ilim");
    await setPlan(t.tenantId, await mkPlan({ replies: null }));
    const body = await (await planGet(req("GET", "/api/plan", t.cookie))).json();
    expect(body.plan.maxRepliesMonth).toBeNull();
    expect(body.repliesState).toBe("unlimited");
  });
  it("loadPlanUsage cuenta invitaciones pendientes", async () => {
    const t = await register("inv-uso");
    await teamInvite(req("POST", "/api/team/invite", t.cookie, { email: `pl-${RUN}-x1@example.test`, role: "agent" }));
    const u = await withTenant(t.tenantId, (db) => loadPlanUsage(db, t.tenantId));
    expect(u).toMatchObject({ members: 1, pendingInvitations: 1 });
  });
});

describe("invitaciones pendientes por negocio", () => {
  it("cada negocio ve solo las suyas; vencidas y revocadas no cuentan", async () => {
    const a = await register("pend-a");
    const b = await register("pend-b");
    await teamInvite(req("POST", "/api/team/invite", a.cookie, { email: `pl-${RUN}-pa1@example.test`, role: "agent" }));
    await teamInvite(req("POST", "/api/team/invite", a.cookie, { email: `pl-${RUN}-pa2@example.test`, role: "agent" }));
    const n = (t: T) => withTenant(t.tenantId, async (db) => Number((await db.query("SELECT tenant_pending_invitations() AS n")).rows[0].n));
    expect(await n(a)).toBe(2);
    expect(await n(b)).toBe(0);
    await owner.query("UPDATE invitations SET expires_at = now() - interval '1 minute' WHERE tenant_id = $1 AND email LIKE '%pa1@%'", [a.tenantId]);
    expect(await n(a)).toBe(1);
    await owner.query("UPDATE invitations SET revoked_at = now() WHERE tenant_id = $1", [a.tenantId]);
    expect(await n(a)).toBe(0);
  });
});

describe("tope de personas del plan", () => {
  const invite = (t: T, n: string) => teamInvite(req("POST", "/api/team/invite", t.cookie, { email: `pl-${RUN}-${n}@example.test`, role: "agent" }));
  it("miembros + invitaciones pendientes no pueden pasar del tope; revocar libera el cupo", async () => {
    const t = await register("tope");
    await setPlan(t.tenantId, await mkPlan({ members: 3 }));
    expect((await invite(t, "tp1")).status).toBe(201);
    expect((await invite(t, "tp2")).status).toBe(201);
    const blocked = await invite(t, "tp3");
    expect(blocked.status).toBe(409);
    expect((await blocked.json()).error).toBe("limite_equipo");
    const list = await (await teamGet(req("GET", "/api/team", t.cookie))).json();
    await teamInvitation(req("POST", "/api/team/invitation", t.cookie, { invitationId: list.invitations[0].id }));
    expect((await invite(t, "tp4")).status).toBe(201);
  });
  it("un plan de 1 persona no deja invitar a nadie; subir el tope lo permite", async () => {
    const t = await register("uno");
    const p = await mkPlan({ members: 1 });
    await setPlan(t.tenantId, p);
    expect((await invite(t, "u1")).status).toBe(409);
    await setPlan(t.tenantId, await mkPlan({ members: 2 }));
    expect((await invite(t, "u2")).status).toBe(201);
  });
  it("reinvitar al mismo correo reemplaza la invitación y no gasta otro cupo", async () => {
    const t = await register("reinv");
    await setPlan(t.tenantId, await mkPlan({ members: 2 }));
    expect((await invite(t, "same")).status).toBe(201);
    expect((await invite(t, "same")).status).toBe(409); // ya hay 1 + dueño = 2 = tope (la comprobación va antes de reemplazar)
  });
});

describe("súper admin: asignar plan", () => {
  it("cambia el plan, lo audita y la lista de negocios lo muestra", async () => {
    const adm = await makeSuperAdmin("adm1");
    const t = await register("asig");
    const p = await mkPlan();
    const res = await adminTenantPlan(req("POST", "/api/admin/tenant-plan", adm, { tenantId: t.tenantId, planId: p }));
    expect(res.status).toBe(200);
    expect(await planOf(t)).toBe(p);
    const audit = await withTenant(t.tenantId, async (db) => (await db.query("SELECT metadata FROM audit_log WHERE action = 'admin.tenant.plan'")).rows);
    expect(audit).toHaveLength(1);
    expect(audit[0].metadata.to).toBe(p);
    const list = await (await adminTenants(req("GET", "/api/admin/tenants", adm))).json();
    expect(list.tenants.find((x: { id: string }) => x.id === t.tenantId).planId).toBe(p);
  });
  it("rechaza plan inactivo, plan o negocio inexistentes, datos malos y a quien no es súper admin (404)", async () => {
    const adm = await makeSuperAdmin("adm2");
    const t = await register("rech");
    const before = await planOf(t);
    const off = await mkPlan({ active: false });
    expect((await adminTenantPlan(req("POST", "/api/admin/tenant-plan", adm, { tenantId: t.tenantId, planId: off }))).status).toBe(404);
    expect((await adminTenantPlan(req("POST", "/api/admin/tenant-plan", adm, { tenantId: t.tenantId, planId: randomUUID() }))).status).toBe(404);
    expect((await adminTenantPlan(req("POST", "/api/admin/tenant-plan", adm, { tenantId: randomUUID(), planId: before }))).status).toBe(404);
    expect((await adminTenantPlan(req("POST", "/api/admin/tenant-plan", adm, { tenantId: "x", planId: before }))).status).toBeGreaterThanOrEqual(400);
    expect((await adminTenantPlan(req("POST", "/api/admin/tenant-plan", t.cookie, { tenantId: t.tenantId, planId: await mkPlan() }))).status).toBe(404);
    expect((await adminTenantPlan(req("POST", "/api/admin/tenant-plan", undefined, { tenantId: t.tenantId, planId: before }))).status).toBe(404);
    expect((await adminTenantPlan(req("POST", "/api/admin/tenant-plan", adm, { tenantId: t.tenantId, planId: before }, "https://evil.example"))).status).toBeGreaterThanOrEqual(400);
    expect(await planOf(t)).toBe(before);
  });
  it("ni el dueño del negocio puede cambiarse el plan, ni con SQL directo", async () => {
    const t = await register("sql");
    const before = await planOf(t);
    const p = await mkPlan();
    await expect(withTenant(t.tenantId, (db) => db.query("UPDATE tenants SET plan_id = $1", [p]))).rejects.toMatchObject({ code: "42501" });
    expect(await planOf(t)).toBe(before);
    await withTenant(t.tenantId, (db) => db.query("UPDATE tenants SET name = 'Otro nombre'")); // otras columnas siguen editables
  });
});

describe("las funciones de la base también exigen ser súper admin (defensa en profundidad)", () => {
  it("con una sesión de dueño normal o un token inventado se rechazan, aunque se salten la API", async () => {
    const t = await register("directo");
    const p = await mkPlan();
    const before = await planOf(t);
    const hashes = [tokenHashOf(req("GET", "/", t.cookie))!, Buffer.alloc(32, 7)];
    for (const h of hashes) {
      await expect(getPool().query("SELECT admin_set_tenant_plan($1, $2, $3)", [h, t.tenantId, p])).rejects.toMatchObject({ code: "42501" });
      await expect(getPool().query("SELECT admin_update_plan($1, $2, 'x', 1, 1, '{}', true)", [h, p])).rejects.toMatchObject({ code: "42501" });
      await expect(getPool().query("SELECT * FROM admin_list_tenants($1)", [h])).rejects.toMatchObject({ code: "42501" });
    }
    expect(await planOf(t)).toBe(before);
    expect((await owner.query("SELECT name FROM plans WHERE id = $1", [p])).rows[0].name).not.toBe("x");
  });
});

describe("súper admin: editar planes", () => {
  const upd = (cookie: string | undefined, planId: string, o: Record<string, unknown> = {}) =>
    adminPlans(req("POST", "/api/admin/plans", cookie, { planId, name: "Nuevo nombre", maxRepliesMonth: 500, maxMembers: 7, modules: ["agenda", "copiloto"], active: true, ...o }));
  const row = async (id: string) => (await owner.query("SELECT * FROM plans WHERE id = $1", [id])).rows[0];

  it("guarda nombre, límites y módulos (sin repetidos) y el cambio rige de inmediato", async () => {
    const adm = await makeSuperAdmin("adm3");
    const p = await mkPlan();
    const t = await register("edit");
    await setPlan(t.tenantId, p);
    expect((await upd(adm, p, { name: "  Plan Oro  ", modules: ["agenda", "agenda", "copiloto"] })).status).toBe(200);
    expect(await row(p)).toMatchObject({ name: "Plan Oro", max_replies_month: 500, max_members: 7, modules: ["agenda", "copiloto"], active: true });
    const plan = await withTenant(t.tenantId, (db) => loadPlan(db, t.tenantId));
    expect(plan).toMatchObject({ name: "Plan Oro", maxMembers: 7 });
  });
  it("«sin tope» (null) y 0 se guardan distinto", async () => {
    const adm = await makeSuperAdmin("adm4");
    const p = await mkPlan();
    await upd(adm, p, { maxRepliesMonth: null });
    expect((await row(p)).max_replies_month).toBeNull();
    await upd(adm, p, { maxRepliesMonth: 0 });
    expect((await row(p)).max_replies_month).toBe(0);
  });
  it.each<[string, Record<string, unknown>]>([
    ["nombre vacío", { name: "   " }], ["nombre larguísimo", { name: "x".repeat(61) }], ["0 personas", { maxMembers: 0 }], ["demasiadas personas", { maxMembers: 1001 }],
    ["respuestas negativas", { maxRepliesMonth: -1 }], ["respuestas decimales", { maxRepliesMonth: 1.5 }], ["módulo inventado", { modules: ["otro"] }], ["activo no booleano", { active: "si" }],
  ])("rechaza: %s", async (_n, o) => {
    const adm = await makeSuperAdmin("adm-bad-" + Math.random().toString(36).slice(2, 7));
    const p = await mkPlan();
    const before = await row(p);
    expect((await upd(adm, p, o)).status).toBeGreaterThanOrEqual(400);
    expect(await row(p)).toEqual(before);
  });
  it("el plan por defecto no se puede desactivar; los demás sí", async () => {
    const adm = await makeSuperAdmin("adm5");
    const def = (await owner.query("SELECT id FROM plans WHERE is_default")).rows[0].id as string;
    const r = await upd(adm, def, { active: false, name: "Plan 1", maxRepliesMonth: 300, maxMembers: 3, modules: ["agenda", "catalogo"] });
    expect(r.status).toBe(409);
    expect((await row(def)).active).toBe(true);
    const p = await mkPlan();
    expect((await upd(adm, p, { active: false })).status).toBe(200);
    expect((await row(p)).active).toBe(false);
  });
  it("plan inexistente → 404; sin ser súper admin → 404 y no cambia nada", async () => {
    const adm = await makeSuperAdmin("adm6");
    expect((await upd(adm, randomUUID())).status).toBe(404);
    const t = await register("noadmin");
    const p = await mkPlan();
    const before = await row(p);
    expect((await upd(t.cookie, p)).status).toBe(404);
    expect((await upd(undefined, p)).status).toBe(404);
    expect(await row(p)).toEqual(before);
  });
});
EOF_TESTS_PLANS_TEST_TS
echo "✔ tests/plans.test.ts"
mkdir -p tests
cat > tests/agent.test.ts <<'EOF_TESTS_AGENT_TEST_TS'
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { POST as signup } from "@/app/api/auth/signup/route";
import { GET as me } from "@/app/api/me/route";
import { PUT as saveAgent } from "@/app/api/agent/route";
import { runAgent } from "@/lib/agent/run";
import { LlmError, type LlmProvider } from "@/lib/ai/provider";
import { encryptSecret } from "@/lib/crypto";
import { getPool, withTenant } from "@/lib/db";
import { can } from "@/lib/auth/permissions";
import { markInboundFailed } from "@/lib/queue/process";
import { LockBusyError } from "@/lib/queue/lock";
import { closeLockClient } from "@/lib/queue/lock";
import { ingestBatch } from "@/lib/whatsapp/ingest";
import type { SendResult } from "@/lib/whatsapp/graph";

process.env.WHATSAPP_APP_SECRET = "secreto-de-prueba-de-la-app-meta";
process.env.WHATSAPP_VERIFY_TOKEN = "token-de-verificacion-de-prueba-123456";
const RUN = randomUUID().slice(0, 8);
process.env.QUEUE_PREFIX = `test-a-${RUN}`;
const ORIGIN = new URL(process.env.APP_URL!).origin;
const PASSWORD = "contraseña-de-prueba-123";
const TOKEN = "EAAtoken-de-prueba-del-negocio-1234567890";
const owner = new Pool({ connectionString: process.env.MIGRATION_DATABASE_URL, max: 2 });
const tenantIds: string[] = [];
let seq = 0;
const newPhoneId = () => `6${RUN.replace(/\D/g, "").padEnd(4, "3").slice(0, 4)}${Date.now() % 100000}${seq++}`.slice(0, 18);
const newWaId = () => `58412${String(Date.now()).slice(-6)}${seq++}`.slice(0, 15);

function api(method: string, path: string, cookie?: string, body?: unknown, origin = ORIGIN) {
  return new Request(`${ORIGIN}${path}`, {
    method,
    headers: { origin, ...(body !== undefined ? { "content-type": "application/json" } : {}), ...(cookie ? { cookie } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

async function register(name: string, opts: { agent?: boolean; instructions?: string } = {}) {
  const email = `ag-${RUN}-${name}@example.test`;
  const res = await signup(api("POST", "/api/auth/signup", undefined, { email, password: PASSWORD, businessName: `Negocio ${name}` }));
  expect(res.status).toBe(201);
  const cookie = (res.headers.get("set-cookie") ?? "").split(";")[0]!;
  const info = await (await me(api("GET", "/api/me", cookie))).json();
  const tenantId = info.tenant.id as string;
  tenantIds.push(tenantId);
  const phoneId = newPhoneId();
  const { payload, keyVersion } = encryptSecret(TOKEN, `wa:${tenantId}:${phoneId}`);
  await owner.query("INSERT INTO tenant_integrations (tenant_id, provider, external_id, secret_enc, key_version) VALUES ($1,'whatsapp',$2,$3,$4)", [tenantId, phoneId, payload, keyVersion]);
  if (opts.agent !== false) {
    await withTenant(tenantId, (db) => db.query("INSERT INTO tenant_agents (tenant_id, enabled, assistant_name, instructions) VALUES ($1, true, 'Ana', $2)", [tenantId, opts.instructions ?? "Abrimos de 8am a 5pm. Corte: $10."]));
  }
  return { tenantId, phoneId, cookie, email };
}

type T = Awaited<ReturnType<typeof register>>;
let planSeq = 0;
const planRows: string[] = [];
let t0 = Math.floor(Date.now() / 1000) - 600;
/** Crea un mensaje entrante (como lo haría el webhook) y devuelve su id. */
async function inbound(t: T, waId: string, body: string | null, type = "text") {
  const r = await ingestBatch({ phoneNumberId: t.phoneId, statuses: [], messages: [{ waId, name: "Cliente", waMessageId: `wamid.${RUN}.${seq++}`, at: new Date(++t0 * 1000), type, body }] });
  return r.inbound[0]!.messageId;
}
const job = (t: T, messageId: string) => ({ tenantId: t.tenantId, messageId });

const sent = (id = `wamid.out.${randomUUID()}`): SendResult => ({ kind: "sent", waMessageId: id });
function deps(opts: { text?: string; result?: SendResult | (() => SendResult | Promise<SendResult>); delay?: number } = {}) {
  const llm = { name: "stub", generate: vi.fn(async () => { if (opts.delay) await new Promise((r) => setTimeout(r, opts.delay)); return { text: opts.text ?? "Hola, abrimos de 8am a 5pm.", inputTokens: 10, outputTokens: 5, model: "stub" }; }) };
  const send = vi.fn(async (...args: unknown[]) => (void args, typeof opts.result === "function" ? opts.result() : (opts.result ?? sent())));
  return { llm: llm as unknown as LlmProvider & { generate: ReturnType<typeof vi.fn> }, send, raw: { llm: llm as unknown as LlmProvider, send: send as never } };
}

const outRows = (t: T) => withTenant(t.tenantId, async (db) => (await db.query("SELECT * FROM messages WHERE direction = 'out' ORDER BY created_at")).rows);
const convOf = (t: T) => withTenant(t.tenantId, async (db) => (await db.query("SELECT status, handoff_reason FROM conversations")).rows[0] as { status: string; handoff_reason: string | null });
const setConv = (t: T, status: string) => withTenant(t.tenantId, (db) => db.query("UPDATE conversations SET status = $1", [status]));

beforeAll(async () => { await getPool().query("SELECT 1"); });
afterEach(() => { vi.unstubAllEnvs(); });

afterAll(async () => {
  await closeLockClient();
  await owner.query("DELETE FROM users WHERE email LIKE $1", [`ag-${RUN}-%`]);
  for (const id of tenantIds) {
    const c = await owner.connect();
    try {
      await c.query("BEGIN");
      await c.query("SELECT set_config('app.tenant_id', $1, true)", [id]);
      await c.query("ALTER TABLE audit_log DISABLE TRIGGER audit_log_sin_cambios");
      await c.query("DELETE FROM audit_log WHERE tenant_id = $1", [id]);
      await c.query("ALTER TABLE audit_log ENABLE TRIGGER audit_log_sin_cambios");
      const del = await c.query("DELETE FROM tenants WHERE id = $1", [id]);
      if (del.rowCount !== 1) throw new Error("La limpieza no borró el negocio de prueba " + id);
      await c.query("COMMIT");
    } catch (e) {
      await c.query("ROLLBACK");
      throw e;
    } finally {
      c.release();
    }
  }
  if (planRows.length) await owner.query("DELETE FROM plans WHERE id = ANY($1)", [planRows]);
  await owner.end();
  await getPool().end();
});

describe("responder", () => {
  it("genera la respuesta, la envía con el token descifrado y deja todo registrado", async () => {
    const t = await register("ok");
    const wa = newWaId();
    const m = await inbound(t, wa, "¿A qué hora abren?");
    const d = deps({ result: sent("wamid.respuesta1") });
    expect(await runAgent(job(t, m), d.raw)).toBe("replied");

    expect(d.send).toHaveBeenCalledTimes(1);
    expect(d.send).toHaveBeenCalledWith(t.phoneId, TOKEN, wa, "Hola, abrimos de 8am a 5pm.");
    const rows = await outRows(t);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ reply_to: m, send_state: "sent", wa_message_id: "wamid.respuesta1", body: "Hola, abrimos de 8am a 5pm." });
    const usage = await withTenant(t.tenantId, async (db) => (await db.query("SELECT replies, input_tokens, output_tokens FROM agent_usage_daily")).rows[0]);
    expect(usage).toMatchObject({ replies: 1, input_tokens: "10", output_tokens: "5" });

    // El modelo recibe las reglas, la información del negocio y el mensaje encerrado.
    const call = d.llm.generate.mock.calls[0]![0] as { system: string; messages: { role: string; content: string }[] };
    expect(call.system).toContain("Abrimos de 8am a 5pm");
    expect(call.system).toContain('"Negocio ok"');
    expect(call.messages).toEqual([{ role: "user", content: "<cliente>¿A qué hora abren?</cliente>" }]);
  });

  it("un reintento del mismo mensaje no vuelve a enviar nada", async () => {
    const t = await register("replay");
    const m = await inbound(t, newWaId(), "hola");
    const d = deps();
    expect(await runAgent(job(t, m), d.raw)).toBe("replied");
    expect(await runAgent(job(t, m), d.raw)).toBe("already_replied");
    expect(d.send).toHaveBeenCalledTimes(1);
    expect(d.llm.generate).toHaveBeenCalledTimes(1);
    expect(await outRows(t)).toHaveLength(1);
  });

  it("el historial lleva los mensajes anteriores y solo las respuestas realmente enviadas", async () => {
    const t = await register("hist");
    const wa = newWaId();
    const m1 = await inbound(t, wa, "primero");
    await runAgent(job(t, m1), deps({ text: "respuesta uno" }).raw);
    const m2 = await inbound(t, wa, "segundo");
    const d = deps({ text: "respuesta dos" });
    await runAgent(job(t, m2), d.raw);
    const msgs = (d.llm.generate.mock.calls[0]![0] as { messages: { role: string; content: string }[] }).messages;
    expect(msgs.map((x) => x.content)).toEqual(["<cliente>primero</cliente>", "respuesta uno", "<cliente>segundo</cliente>"]);
  });
});

describe("historial", () => {
  it("no incluye respuestas que nunca llegaron al cliente (failed, unknown, sending)", async () => {
    const t = await register("hist2");
    const wa = newWaId();
    const m1 = await inbound(t, wa, "primero");
    await withTenant(t.tenantId, async (db) => {
      const c = await db.query("SELECT id FROM conversations");
      for (const st of ["failed", "unknown", "sending"]) {
        // reply_to distinto para cada una (el índice único exige uno por mensaje)
        await db.query("INSERT INTO messages (tenant_id, conversation_id, direction, msg_type, body, reply_to, send_state) VALUES ($1,$2,'out','text',$3,$4,$5)", [t.tenantId, c.rows[0].id, `NO-ENVIADA-${st}`, randomUUID(), st]);
      }
    });
    const m2 = await inbound(t, wa, "segundo");
    const d = deps();
    await runAgent(job(t, m2), d.raw);
    const msgs = (d.llm.generate.mock.calls[0]![0] as { messages: { content: string }[] }).messages;
    expect(JSON.stringify(msgs)).not.toContain("NO-ENVIADA");
    expect(msgs.map((x) => x.content)).toEqual(["<cliente>primero</cliente>", "<cliente>segundo</cliente>"]);
    void m1;
  });
});

describe("cuándo NO responde", () => {
  it("asistente apagado, sin configurar, o negocio suspendido", async () => {
    const off = await register("off", { agent: false });
    const m = await inbound(off, newWaId(), "hola");
    const d = deps();
    expect(await runAgent(job(off, m), d.raw)).toBe("skipped_disabled");
    await withTenant(off.tenantId, (db) => db.query("INSERT INTO tenant_agents (tenant_id, enabled) VALUES ($1, false)", [off.tenantId]));
    expect(await runAgent(job(off, m), d.raw)).toBe("skipped_disabled");

    const sus = await register("sus");
    const m2 = await inbound(sus, newWaId(), "hola");
    for (const [status, trial] of [["suspended", null], ["past_due", null], ["trial", "2020-01-01"]] as const) {
      const c = await owner.connect();
      try {
        await c.query("BEGIN");
        await c.query("SELECT set_config('app.tenant_id', $1, true)", [sus.tenantId]);
        await c.query("UPDATE tenants SET status = $2, trial_ends_at = $3 WHERE id = $1", [sus.tenantId, status, trial]);
        await c.query("COMMIT");
      } finally { c.release(); }
      expect(await runAgent(job(sus, m2), d.raw)).toBe("skipped_inactive_tenant");
    }
    expect(d.send).not.toHaveBeenCalled();
    expect(d.llm.generate).not.toHaveBeenCalled();
  });

  it("conversación en manos de una persona, reacciones y negocio sin WhatsApp", async () => {
    const t = await register("human");
    const m = await inbound(t, newWaId(), "hola");
    await setConv(t, "human");
    const d = deps();
    expect(await runAgent(job(t, m), d.raw)).toBe("skipped_human");
    expect(d.llm.generate).not.toHaveBeenCalled(); // ni siquiera se gasta IA
    await setConv(t, "bot");
    const react = await inbound(t, newWaId(), "👍", "reaction");
    expect(await runAgent(job(t, react), d.raw)).toBe("skipped_ignored_type");
    expect(d.send).not.toHaveBeenCalled();

    const nowa = await register("nowa");
    const m2 = await inbound(nowa, newWaId(), "hola");
    await owner.query("DELETE FROM tenant_integrations WHERE tenant_id = $1", [nowa.tenantId]);
    expect(await runAgent(job(nowa, m2), d.raw)).toBe("skipped_no_whatsapp");
  });

  it("un trabajo falso (negocio A con mensaje de B) no hace nada", async () => {
    const a = await register("fa");
    const b = await register("fb");
    const m = await inbound(b, newWaId(), "hola");
    const d = deps();
    expect(await runAgent({ tenantId: a.tenantId, messageId: m }, d.raw)).toBe("skipped_not_found");
    expect(d.send).not.toHaveBeenCalled();
  });

  it("si el cliente escribió varios mensajes seguidos, solo el último responde, con todo el contexto", async () => {
    const t = await register("burst");
    const wa = newWaId();
    const m1 = await inbound(t, wa, "hola");
    const m2 = await inbound(t, wa, "quería saber el precio");
    const d = deps();
    expect(await runAgent(job(t, m1), d.raw)).toBe("skipped_superseded");
    expect(d.send).not.toHaveBeenCalled();
    expect(await runAgent(job(t, m2), d.raw)).toBe("replied");
    const msgs = (d.llm.generate.mock.calls[0]![0] as { messages: { content: string }[] }).messages;
    // El proveedor junta turnos seguidos del mismo rol (ver normalizeTurns); aquí llegan los dos.
    expect(msgs.map((x) => x.content)).toEqual(["<cliente>hola</cliente>", "<cliente>quería saber el precio</cliente>"]);
    expect(d.send).toHaveBeenCalledTimes(1);
  });

  it("una reacción posterior no cuenta como mensaje más reciente", async () => {
    const t = await register("react-after");
    const wa = newWaId();
    const m1 = await inbound(t, wa, "hola");
    await inbound(t, wa, "👍", "reaction");
    expect(await runAgent(job(t, m1), deps().raw)).toBe("replied");
  });
});

describe("pasar a una persona", () => {
  it("si el cliente la pide: sin gastar IA, mensaje fijo y la conversación pasa a humano", async () => {
    const t = await register("pide");
    const m = await inbound(t, newWaId(), "quiero hablar con una persona");
    const d = deps();
    expect(await runAgent(job(t, m), d.raw)).toBe("handoff");
    expect(d.llm.generate).not.toHaveBeenCalled();
    expect(d.send.mock.calls[0]![3]).toContain("te comunico con una persona");
    expect(await convOf(t)).toEqual({ status: "human", handoff_reason: "pedido_de_persona" });
  });

  it("si el modelo lo pide con la señal: se envía el texto SIN la señal", async () => {
    const t = await register("senal");
    const m = await inbound(t, newWaId(), "esto me parece una estafa");
    const d = deps({ text: "[[HUMANO]] Lamento eso, te paso con alguien del equipo." });
    expect(await runAgent(job(t, m), d.raw)).toBe("handoff");
    expect(d.send.mock.calls[0]![3]).toBe("Lamento eso, te paso con alguien del equipo.");
    expect((await convOf(t)).status).toBe("human");
  });

  it("respuesta vacía del modelo → mensaje de respaldo y a una persona; no de texto → aviso fijo sin IA", async () => {
    const t = await register("vacio");
    const m = await inbound(t, newWaId(), "hola");
    const d = deps({ text: "   " });
    expect(await runAgent(job(t, m), d.raw)).toBe("handoff");
    expect(d.send.mock.calls[0]![3]).toContain("no pude procesar");

    const t2 = await register("imagen");
    const m2 = await inbound(t2, newWaId(), null, "image");
    const d2 = deps();
    expect(await runAgent(job(t2, m2), d2.raw)).toBe("replied");
    expect(d2.llm.generate).not.toHaveBeenCalled();
    expect(d2.send.mock.calls[0]![3]).toContain("solo puedo leer mensajes de texto");
  });

  it("tope diario: no responde más y pasa a una persona", async () => {
    vi.stubEnv("AGENT_DAILY_REPLY_LIMIT", "1");
    const t = await register("tope");
    const wa = newWaId();
    const d = deps();
    expect(await runAgent(job(t, await inbound(t, wa, "uno")), d.raw)).toBe("replied");
    expect(await runAgent(job(t, await inbound(t, wa, "dos")), d.raw)).toBe("limit_reached");
    expect(d.send).toHaveBeenCalledTimes(1);
    expect(await convOf(t)).toEqual({ status: "human", handoff_reason: "limite_diario" });
  });

  it("tope mensual del plan: al llegar no responde y pasa a una persona; sin tope sigue; el mes anterior no cuenta", async () => {
    const plan = async (replies: number | null) => {
      const slug = `ag-${RUN}-${planSeq++}`;
      const r = await owner.query<{ id: string }>("INSERT INTO plans (slug, name, position, max_replies_month, max_members) VALUES ($1,$1,99,$2,3) RETURNING id", [slug, replies]);
      planRows.push(r.rows[0]!.id);
      return r.rows[0]!.id;
    };
    const assign = async (t: T, planId: string) => {
      const c = await owner.connect();
      try {
        await c.query("BEGIN");
        await c.query("SELECT set_config('app.tenant_id', $1, true)", [t.tenantId]);
        await c.query("ALTER TABLE tenants DISABLE TRIGGER tenants_plan_guard");
        await c.query("UPDATE tenants SET plan_id = $2 WHERE id = $1", [t.tenantId, planId]);
        await c.query("ALTER TABLE tenants ENABLE TRIGGER tenants_plan_guard");
        await c.query("COMMIT");
      } catch (e) { await c.query("ROLLBACK"); throw e; } finally { c.release(); }
    };
    const usage = (t: T, day: string, n: number) => withTenant(t.tenantId, (db) => db.query(`INSERT INTO agent_usage_daily (tenant_id, day, replies) VALUES ($1, ${day}, $2)`, [t.tenantId, n]));

    const t = await register("plan-tope");
    await assign(t, await plan(2));
    await usage(t, "(date_trunc('month', now() AT TIME ZONE 'utc') - interval '1 day')::date", 999); // mes pasado: no cuenta
    await usage(t, "(now() AT TIME ZONE 'utc')::date", 1);
    const wa = newWaId();
    const d = deps();
    expect(await runAgent(job(t, await inbound(t, wa, "uno")), d.raw)).toBe("replied"); // la respuesta suma 1 → total 2
    expect(await runAgent(job(t, await inbound(t, wa, "dos")), d.raw)).toBe("limit_reached");
    expect(d.send).toHaveBeenCalledTimes(1);
    expect(await convOf(t)).toEqual({ status: "human", handoff_reason: "limite_plan" });
    const task = await withTenant(t.tenantId, async (db) => (await db.query("SELECT detail FROM work_items WHERE type = 'atencion_humana'")).rows);
    expect(task[0].detail).toMatch(/tope mensual/);

    const t2 = await register("plan-sin-tope"); // NULL = sin tope
    await assign(t2, await plan(null));
    await usage(t2, "(now() AT TIME ZONE 'utc')::date", 100000);
    const wa2 = newWaId();
    expect(await runAgent(job(t2, await inbound(t2, wa2, "hola")), deps().raw)).toBe("replied");

    const t3 = await register("plan-cero"); // 0 = no responde nunca
    await assign(t3, await plan(0));
    const d3 = deps();
    expect(await runAgent(job(t3, await inbound(t3, newWaId(), "hola")), d3.raw)).toBe("limit_reached");
    expect(d3.send).not.toHaveBeenCalled();
    expect(d3.llm.generate).not.toHaveBeenCalled();
  });

  it("si una persona toma la conversación mientras la IA piensa, no se envía nada", async () => {
    const t = await register("toma");
    const m = await inbound(t, newWaId(), "hola");
    const d = deps();
    d.llm.generate.mockImplementationOnce(async () => {
      await setConv(t, "human");
      return { text: "tarde", inputTokens: 0, outputTokens: 0, model: "x" };
    });
    expect(await runAgent(job(t, m), d.raw)).toBe("skipped_human");
    expect(d.send).not.toHaveBeenCalled();
    expect(await outRows(t)).toHaveLength(0);
  });

  it("cuando BullMQ agota los reintentos la conversación pasa a una persona", async () => {
    const t = await register("fallo");
    const m = await inbound(t, newWaId(), "hola");
    await markInboundFailed(job(t, m));
    expect(await convOf(t)).toEqual({ status: "human", handoff_reason: "agente_fallo" });
  });
});

describe("envío seguro (nunca se duplica un mensaje al cliente)", () => {
  it("rechazado por Meta → failed y a una persona", async () => {
    const t = await register("rech");
    const m = await inbound(t, newWaId(), "hola");
    const d = deps({ result: { kind: "rejected", status: 401, code: 190, message: "Token vencido" } });
    expect(await runAgent(job(t, m), d.raw)).toBe("send_failed");
    expect((await outRows(t))[0]).toMatchObject({ send_state: "failed", send_error: "190: Token vencido" });
    expect(await convOf(t)).toEqual({ status: "human", handoff_reason: "envio_rechazado" });
    // Un reintento no vuelve a intentar enviar.
    expect(await runAgent(job(t, m), d.raw)).toBe("send_failed");
    expect(d.send).toHaveBeenCalledTimes(1);
  });

  it("resultado incierto → unknown y a una persona; el reintento NO reenvía", async () => {
    const t = await register("inc");
    const m = await inbound(t, newWaId(), "hola");
    const d = deps({ result: { kind: "unknown", reason: "tiempo agotado" } });
    expect(await runAgent(job(t, m), d.raw)).toBe("send_unknown");
    expect((await outRows(t))[0]).toMatchObject({ send_state: "unknown" });
    expect(await convOf(t)).toEqual({ status: "human", handoff_reason: "envio_incierto" });
    expect(await runAgent(job(t, m), d.raw)).toBe("send_unknown");
    expect(d.send).toHaveBeenCalledTimes(1);
  });

  it("no llegó a Meta (retry) → no queda fila, lanza error, y el reintento sí envía", async () => {
    const t = await register("retry");
    const m = await inbound(t, newWaId(), "hola");
    const d = deps({ result: { kind: "retry", reason: "ENOTFOUND" } });
    await expect(runAgent(job(t, m), d.raw)).rejects.toThrow(/reintentará/);
    expect(await outRows(t)).toHaveLength(0);
    expect((await convOf(t)).status).toBe("bot");
    d.send.mockResolvedValueOnce(sent("wamid.ok"));
    expect(await runAgent(job(t, m), d.raw)).toBe("replied");
    expect(d.send).toHaveBeenCalledTimes(2);
    expect(await outRows(t)).toHaveLength(1);
  });

  it("si un intento anterior murió a mitad del envío, no se reenvía a ciegas", async () => {
    const t = await register("murio");
    const m = await inbound(t, newWaId(), "hola");
    await withTenant(t.tenantId, async (db) => {
      const c = await db.query("SELECT id FROM conversations");
      await db.query("INSERT INTO messages (tenant_id, conversation_id, direction, msg_type, body, reply_to, send_state) VALUES ($1,$2,'out','text','x',$3,'sending')", [t.tenantId, c.rows[0].id, m]);
    });
    const d = deps();
    expect(await runAgent(job(t, m), d.raw)).toBe("send_unknown");
    expect(d.send).not.toHaveBeenCalled();
    expect((await outRows(t))[0].send_state).toBe("unknown");
    expect(await convOf(t)).toEqual({ status: "human", handoff_reason: "envio_incierto" });
  });

  it("dos respuestas simultáneas al mismo mensaje: el índice único deja pasar solo una", async () => {
    const t = await register("carrera");
    const m = await inbound(t, newWaId(), "hola");
    await withTenant(t.tenantId, async (db) => {
      const c = await db.query("SELECT id FROM conversations");
      await db.query("INSERT INTO messages (tenant_id, conversation_id, direction, msg_type, body, reply_to, send_state) VALUES ($1,$2,'out','text','a',$3,'sent')", [t.tenantId, c.rows[0].id, m]);
      await expect(db.query("INSERT INTO messages (tenant_id, conversation_id, direction, msg_type, body, reply_to, send_state) VALUES ($1,$2,'out','text','b',$3,'sending')", [t.tenantId, c.rows[0].id, m])).rejects.toMatchObject({ code: "23505" });
    }).catch((e) => { if ((e as { code?: string }).code !== "23505") throw e; });
  });

  it("errores de la IA se propagan (BullMQ reintenta) y no dejan nada a medias", async () => {
    const t = await register("llmerr");
    const m = await inbound(t, newWaId(), "hola");
    const d = deps();
    d.llm.generate.mockRejectedValueOnce(new LlmError("límite de uso", true, 429));
    await expect(runAgent(job(t, m), d.raw)).rejects.toBeInstanceOf(LlmError);
    expect(d.send).not.toHaveBeenCalled();
    expect(await outRows(t)).toHaveLength(0);
  });

  it("una conversación a la vez: un segundo trabajo simultáneo espera (candado)", async () => {
    const t = await register("lock");
    const wa = newWaId();
    const m1 = await inbound(t, wa, "hola");
    const d = deps({ delay: 400 });
    const first = runAgent(job(t, m1), d.raw);
    await new Promise((r) => setTimeout(r, 100));
    await expect(runAgent(job(t, m1), d.raw)).rejects.toBeInstanceOf(LockBusyError);
    expect(await first).toBe("replied");
    expect(d.send).toHaveBeenCalledTimes(1);
  });
});

describe("API /api/agent", () => {
  const body = { enabled: true, assistantName: "Sofía", instructions: "Atendemos de lunes a viernes.\u0007" };

  it("guarda la configuración (sin caracteres de control) y audita sin guardar el contenido", async () => {
    const t = await register("api", { agent: false });
    const res = await saveAgent(api("PUT", "/api/agent", t.cookie, body));
    expect(res.status).toBe(200);
    const row = await withTenant(t.tenantId, async (db) => (await db.query("SELECT * FROM tenant_agents")).rows[0]);
    expect(row).toMatchObject({ enabled: true, assistant_name: "Sofía", instructions: "Atendemos de lunes a viernes." });
    const audit = await withTenant(t.tenantId, async (db) => (await db.query("SELECT metadata FROM audit_log WHERE action = 'agent.updated'")).rows[0]);
    expect(audit.metadata).toEqual({ enabled: true, instructionsLength: 29 });
    expect(JSON.stringify(audit.metadata)).not.toContain("lunes");
    // Actualizar de nuevo (upsert).
    expect((await saveAgent(api("PUT", "/api/agent", t.cookie, { ...body, enabled: false }))).status).toBe(200);
    expect((await withTenant(t.tenantId, async (db) => (await db.query("SELECT enabled FROM tenant_agents")).rows))).toEqual([{ enabled: false }]);
  });

  it("rechaza sin sesión, con origen ajeno y con datos inválidos", async () => {
    const t = await register("api2", { agent: false });
    expect((await saveAgent(api("PUT", "/api/agent", undefined, body))).status).toBe(401);
    expect((await saveAgent(api("PUT", "/api/agent", t.cookie, body, "https://malo.example"))).status).toBe(403);
    expect((await saveAgent(api("PUT", "/api/agent", t.cookie, { ...body, assistantName: "  " }))).status).toBe(400);
    expect((await saveAgent(api("PUT", "/api/agent", t.cookie, { ...body, instructions: "x".repeat(4001) }))).status).toBe(400);
    expect((await saveAgent(api("PUT", "/api/agent", t.cookie, { ...body, enabled: "sí" }))).status).toBe(400);
    const row = await withTenant(t.tenantId, async (db) => (await db.query("SELECT 1 FROM tenant_agents")).rowCount);
    expect(row).toBe(0);
  });

  it("solo dueños y administradores pueden cambiar el asistente", () => {
    expect(can("owner", "agent:manage")).toBe(true);
    expect(can("admin", "agent:manage")).toBe(true);
    expect(can("agent", "agent:manage")).toBe(false);
    expect(can(null, "agent:manage")).toBe(false);
  });
});

describe("aislamiento de la configuración", () => {
  it("un negocio no ve ni cambia el asistente de otro (RLS)", async () => {
    const a = await register("iso-a", { instructions: "SECRETO-DE-A" });
    const b = await register("iso-b", { instructions: "de B" });
    const seenByB = await withTenant(b.tenantId, async (db) => (await db.query("SELECT instructions FROM tenant_agents")).rows);
    expect(seenByB).toEqual([{ instructions: "de B" }]);
    const touched = await withTenant(b.tenantId, (db) => db.query("UPDATE tenant_agents SET instructions = 'hackeado' WHERE tenant_id = $1", [a.tenantId]));
    expect(touched.rowCount).toBe(0);
  });
});
EOF_TESTS_AGENT_TEST_TS
echo "✔ tests/agent.test.ts"
mkdir -p tests
cat > tests/mfa-team.test.ts <<'EOF_TESTS_MFA-TEAM_TEST_TS'
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, describe, expect, it } from "vitest";
import { POST as verify2fa } from "@/app/api/auth/2fa/verify/route";
import { POST as setup2fa } from "@/app/api/auth/2fa/setup/route";
import { POST as confirm2fa } from "@/app/api/auth/2fa/confirm/route";
import { POST as disable2fa } from "@/app/api/auth/2fa/disable/route";
import { POST as regenCodes } from "@/app/api/auth/2fa/codes/route";
import { POST as login } from "@/app/api/auth/login/route";
import { POST as signup } from "@/app/api/auth/signup/route";
import { GET as listTenants } from "@/app/api/admin/tenants/route";
import { GET as me } from "@/app/api/me/route";
import { GET as teamGet } from "@/app/api/team/route";
import { POST as teamInvite } from "@/app/api/team/invite/route";
import { POST as teamInvitation } from "@/app/api/team/invitation/route";
import { POST as teamRole } from "@/app/api/team/role/route";
import { POST as teamRemove } from "@/app/api/team/remove/route";
import { POST as inviteSignup } from "@/app/api/invitations/signup/route";
import { POST as inviteAccept } from "@/app/api/invitations/accept/route";
import { hashPassword } from "@/lib/auth/password";
import { hashToken } from "@/lib/auth/tokens";
import { base32Encode, hotp, verifyTotp } from "@/lib/auth/totp";
import { getPool } from "@/lib/db";
import { codeFor, enableMfaDirect } from "./mfa-helpers";

const ORIGIN = new URL(process.env.APP_URL!).origin;
const RUN = randomUUID().slice(0, 8);
const email = (n: string) => `t2-${RUN}-${n}@example.test`;
const PASSWORD = "contraseña-de-prueba-123";
const owner = new Pool({ connectionString: process.env.MIGRATION_DATABASE_URL, max: 2 });
const tenantIds: string[] = [];

function req(method: string, path: string, cookie?: string, body?: unknown) {
  return new Request(`${ORIGIN}${path}`, {
    method,
    headers: {
      origin: ORIGIN,
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
      ...(cookie ? { cookie } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}
const cookieOf = (res: Response) => (res.headers.get("set-cookie") ?? "").split(";")[0]!;

async function register(name: string) {
  const res = await signup(req("POST", "/api/auth/signup", undefined,
    { email: email(name), password: PASSWORD, businessName: `Negocio ${name}` }));
  expect(res.status).toBe(201);
  const cookie = cookieOf(res);
  const info = await (await me(req("GET", "/api/me", cookie))).json();
  tenantIds.push(info.tenant.id);
  const u = await owner.query("SELECT id FROM users WHERE email = $1", [email(name)]);
  return { cookie, tenantId: info.tenant.id as string, userId: u.rows[0].id as string, email: email(name) };
}

async function loginRaw(addr: string) {
  return login(req("POST", "/api/auth/login", undefined, { email: addr, password: PASSWORD }));
}

/** Crea un usuario con 2FA ya activo (directo en la base) y lo deja con sesión completa. */
async function userWithMfa(name: string) {
  const a = await register(name);
  const secret = await enableMfaDirect(owner, a.userId);
  return { ...a, secret };
}

afterAll(async () => {
  await owner.query("DELETE FROM users WHERE email LIKE $1", [`t2-${RUN}-%`]);
  for (const id of tenantIds) {
    const c = await owner.connect();
    try {
      await c.query("BEGIN");
      // tenants tiene FORCE RLS: sin fijar el negocio el DELETE no borra nada (en silencio).
      await c.query("SELECT set_config('app.tenant_id', $1, true)", [id]);
      await c.query("ALTER TABLE audit_log DISABLE TRIGGER audit_log_sin_cambios");
      await c.query("DELETE FROM audit_log WHERE tenant_id = $1", [id]);
      await c.query("ALTER TABLE audit_log ENABLE TRIGGER audit_log_sin_cambios");
      const del = await c.query("DELETE FROM tenants WHERE id = $1", [id]);
      if (del.rowCount !== 1) throw new Error("La limpieza no borró el negocio de prueba " + id);
      await c.query("COMMIT");
    } catch (e) {
      await c.query("ROLLBACK");
      throw e;
    } finally {
      c.release();
    }
  }
  await owner.end();
  await getPool().end();
});

describe("TOTP (RFC 6238)", () => {
  const rfc = base32Encode(Buffer.from("12345678901234567890"));
  it("coincide con los vectores oficiales", () => {
    expect(hotp(rfc, Math.floor(59 / 30))).toBe("287082");
    expect(hotp(rfc, Math.floor(1111111109 / 30))).toBe("081804");
    expect(hotp(rfc, Math.floor(2000000000 / 30))).toBe("279037");
  });
  it("acepta ±1 paso y rechaza el resto o formatos raros", () => {
    const now = 1_700_000_000_000;
    const step = Math.floor(now / 30000);
    expect(verifyTotp(rfc, hotp(rfc, step), now)).toBe(step);
    expect(verifyTotp(rfc, hotp(rfc, step - 1), now)).toBe(step - 1);
    expect(verifyTotp(rfc, hotp(rfc, step + 1), now)).toBe(step + 1);
    expect(verifyTotp(rfc, hotp(rfc, step - 2), now)).toBeNull();
    expect(verifyTotp(rfc, "abcdef", now)).toBeNull();
    expect(verifyTotp(rfc, "12345", now)).toBeNull();
  });
});

describe("inicio de sesión con 2FA", () => {
  it("la contraseña sola solo da una sesión pendiente que no sirve para nada", async () => {
    const u = await userWithMfa("a1");
    const res = await loginRaw(u.email);
    expect(res.status).toBe(200);
    expect((await res.json()).mfaRequired).toBe(true);
    const pending = cookieOf(res);
    expect((await me(req("GET", "/api/me", pending))).status).toBe(401);
    expect((await teamGet(req("GET", "/api/team", pending))).status).toBe(401);
  });

  it("código correcto: cambia a una sesión NUEVA y la pendiente muere; el código no se reutiliza", async () => {
    const u = await userWithMfa("a2");
    const pending = cookieOf(await loginRaw(u.email));
    const code = codeFor(u.secret);
    const ok = await verify2fa(req("POST", "/api/auth/2fa/verify", pending, { code }));
    expect(ok.status).toBe(200);
    const full = cookieOf(ok);
    expect(full).not.toBe(pending);
    expect((await me(req("GET", "/api/me", full))).status).toBe(200);
    expect((await me(req("GET", "/api/me", pending))).status).toBe(401);

    // Mismo código otra vez (repetición) con otra sesión pendiente.
    const pending2 = cookieOf(await loginRaw(u.email));
    const replay = await verify2fa(req("POST", "/api/auth/2fa/verify", pending2, { code }));
    expect(replay.status).toBe(401);
  });

  it("5 códigos malos bloquean 15 minutos, incluso con el código bueno", async () => {
    const u = await userWithMfa("a3");
    const pending = cookieOf(await loginRaw(u.email));
    const bad = codeFor(u.secret, 5) === "000000" ? "111111" : "000000";
    let last = 0;
    for (let i = 0; i < 5; i++) {
      last = (await verify2fa(req("POST", "/api/auth/2fa/verify", pending, { code: bad }))).status;
    }
    expect(last).toBe(429);
    const again = cookieOf(await loginRaw(u.email));
    const good = await verify2fa(req("POST", "/api/auth/2fa/verify", again, { code: codeFor(u.secret, 1) }));
    expect(good.status).toBe(429);
  });

  it("código de recuperación: sirve una vez", async () => {
    const u = await userWithMfa("a4");
    const code = "ABCDE-FGHJK-LMNPQ";
    const { hashRecovery } = await import("@/lib/auth/mfa");
    await owner.query("INSERT INTO mfa_recovery_codes (user_id, code_hash) VALUES ($1, $2)", [u.userId, hashRecovery(code)]);
    const p1 = cookieOf(await loginRaw(u.email));
    const ok = await verify2fa(req("POST", "/api/auth/2fa/verify", p1, { recoveryCode: code.toLowerCase() }));
    expect(ok.status).toBe(200);
    expect((await me(req("GET", "/api/me", cookieOf(ok)))).status).toBe(200);
    const p2 = cookieOf(await loginRaw(u.email));
    const again = await verify2fa(req("POST", "/api/auth/2fa/verify", p2, { recoveryCode: code }));
    expect(again.status).toBe(401);
  });

  it("sin sesión pendiente, verify responde 401", async () => {
    const res = await verify2fa(req("POST", "/api/auth/2fa/verify", undefined, { code: "123456" }));
    expect(res.status).toBe(401);
  });
});

describe("activar, apagar y regenerar 2FA", () => {
  it("flujo completo: setup, confirmar, códigos, secreto cifrado y cierre de otras sesiones", async () => {
    const u = await register("b1");
    const other = cookieOf(await loginRaw(u.email)); // otra sesión del mismo usuario
    expect((await me(req("GET", "/api/me", other))).status).toBe(200);

    const s = await setup2fa(req("POST", "/api/auth/2fa/setup", u.cookie, {}));
    expect(s.status).toBe(200);
    const sj = await s.json();
    expect(sj.secret).toMatch(/^[A-Z2-7]{32}$/);
    expect(sj.qr).toMatch(/^data:image\/png;base64,/);

    const badConfirm = await confirm2fa(req("POST", "/api/auth/2fa/confirm", u.cookie, { code: "000000" }));
    expect(badConfirm.status).toBe(401);

    const ok = await confirm2fa(req("POST", "/api/auth/2fa/confirm", u.cookie, { code: hotp(sj.secret, Math.floor(Date.now() / 30000)) }));
    expect(ok.status).toBe(200);
    const { recoveryCodes } = await ok.json();
    expect(recoveryCodes).toHaveLength(10);
    expect(new Set(recoveryCodes).size).toBe(10);

    // En la base el secreto está cifrado y los códigos solo como hash.
    const row = await owner.query("SELECT secret_enc FROM user_mfa WHERE user_id = $1", [u.userId]);
    expect(row.rows[0].secret_enc).not.toContain(sj.secret);
    const codes = await owner.query("SELECT count(*)::int AS n FROM mfa_recovery_codes WHERE user_id = $1", [u.userId]);
    expect(codes.rows[0].n).toBe(10);

    // La sesión actual sigue; las demás se cerraron.
    expect((await me(req("GET", "/api/me", u.cookie))).status).toBe(200);
    expect((await me(req("GET", "/api/me", other))).status).toBe(401);
    // Ya activo: no se puede iniciar otra configuración.
    expect((await setup2fa(req("POST", "/api/auth/2fa/setup", u.cookie, {}))).status).toBe(409);
  });

  it("app_user no puede leer ni escribir las tablas de 2FA ni de invitaciones", async () => {
    const pool = getPool();
    for (const t of ["user_mfa", "mfa_recovery_codes", "invitations"]) {
      await expect(pool.query(`SELECT * FROM ${t}`)).rejects.toMatchObject({ code: "42501" });
    }
    await expect(pool.query("SELECT auth_issue_session($1, $2, 'x', false)", [randomUUID(), Buffer.alloc(32)]))
      .rejects.toMatchObject({ code: "42501" });
    await expect(pool.query("SELECT auth_tenant_role($1, $2)", [Buffer.alloc(32), randomUUID()]))
      .rejects.toMatchObject({ code: "42501" });
  });

  it("apagar exige contraseña Y código; regenerar invalida los anteriores", async () => {
    const u = await userWithMfa("b2");
    const full = async () => {
      const p = cookieOf(await loginRaw(u.email));
      return cookieOf(await verify2fa(req("POST", "/api/auth/2fa/verify", p, { code: codeFor(u.secret, full.n++) })));
    };
    full.n = 0;
    const c1 = await full();

    const wrongPw = await disable2fa(req("POST", "/api/auth/2fa/disable", c1, { password: "mala-contraseña-1", code: codeFor(u.secret, 1) }));
    expect(wrongPw.status).toBe(401);

    const { hashRecovery } = await import("@/lib/auth/mfa");
    await owner.query("INSERT INTO mfa_recovery_codes (user_id, code_hash) VALUES ($1, $2)", [u.userId, hashRecovery("AAAAA-BBBBB-CCCCC")]);
    const regen = await regenCodes(req("POST", "/api/auth/2fa/codes", c1, { password: PASSWORD, code: codeFor(u.secret, 1) }));
    expect(regen.status).toBe(200);
    expect((await regen.json()).recoveryCodes).toHaveLength(10);
    const old = await owner.query("SELECT count(*)::int AS n FROM mfa_recovery_codes WHERE user_id = $1 AND code_hash = $2", [u.userId, hashRecovery("AAAAA-BBBBB-CCCCC")]);
    expect(old.rows[0].n).toBe(0);

    const off = await disable2fa(req("POST", "/api/auth/2fa/disable", c1, { password: PASSWORD, code: codeFor(u.secret, 2) }));
    // el offset 2 queda fuera de la ventana: debe fallar
    expect(off.status).toBe(401);
  });

  it("apagar con contraseña y código válidos lo desactiva", async () => {
    const u = await userWithMfa("b3");
    const p = cookieOf(await loginRaw(u.email));
    const c = cookieOf(await verify2fa(req("POST", "/api/auth/2fa/verify", p, { code: codeFor(u.secret, -1) })));
    const off = await disable2fa(req("POST", "/api/auth/2fa/disable", c, { password: PASSWORD, code: codeFor(u.secret, 1) }));
    expect(off.status).toBe(200);
    const res = await loginRaw(u.email);
    expect((await res.json()).mfaRequired).toBe(false);
  });

  it("el súper admin no puede apagar su 2FA y sin 2FA no tiene poderes", async () => {
    const addr = email("sa1");
    const ins = await owner.query("INSERT INTO users (email, password_hash, is_super_admin) VALUES ($1, $2, true) RETURNING id", [addr, await hashPassword(PASSWORD)]);
    const res = await loginRaw(addr);
    const cookie = cookieOf(res);
    const info = await (await me(req("GET", "/api/me", cookie))).json();
    expect(info.user.isSuperAdmin).toBe(false);
    expect(info.user.needsMfaSetup).toBe(true);
    expect((await listTenants(req("GET", "/api/admin/tenants", cookie))).status).toBe(404);

    // Activa 2FA por la ruta normal y recupera poderes en la sesión actual.
    const s = await (await setup2fa(req("POST", "/api/auth/2fa/setup", cookie, {}))).json();
    const ok = await confirm2fa(req("POST", "/api/auth/2fa/confirm", cookie, { code: hotp(s.secret, Math.floor(Date.now() / 30000)) }));
    expect(ok.status).toBe(200);
    expect((await listTenants(req("GET", "/api/admin/tenants", cookie))).status).toBe(200);

    const off = await disable2fa(req("POST", "/api/auth/2fa/disable", cookie, { password: PASSWORD, code: hotp(s.secret, Math.floor(Date.now() / 30000) + 1) }));
    expect(off.status).toBe(403);
    // Aunque se salte la ruta, la base también lo impide.
    await expect(getPool().query("SELECT mfa_disable($1, 99999999999)", [hashToken(cookie.split("=")[1]!)]))
      .rejects.toMatchObject({ code: "42501" });
    const still = await owner.query("SELECT 1 FROM user_mfa WHERE user_id = $1 AND enabled_at IS NOT NULL", [ins.rows[0].id]);
    expect(still.rowCount).toBe(1);
  });
});

describe("equipo e invitaciones", () => {
  async function invite(cookie: string, to: string, role: "admin" | "agent") {
    const r = await teamInvite(req("POST", "/api/team/invite", cookie, { email: to, role }));
    return { status: r.status, body: await r.json() };
  }
  const tokenOf = (url: string) => url.split("/").pop()!;

  it("el dueño invita; la persona se registra con el correo de la invitación y entra al negocio", async () => {
    const o = await register("c1");
    const inv = await invite(o.cookie, email("c1-agente"), "agent");
    expect(inv.status).toBe(201);
    expect(inv.body.inviteUrl).toContain("/invitacion/");
    const token = tokenOf(inv.body.inviteUrl);

    // En la base solo existe el hash del token.
    const raw = await owner.query("SELECT encode(token_hash,'hex') AS h FROM invitations WHERE tenant_id = $1", [o.tenantId]);
    expect(raw.rows[0].h).toBe(hashToken(token).toString("hex"));

    const bad = await inviteSignup(req("POST", "/api/invitations/signup", undefined, { token: "z".repeat(43), password: PASSWORD }));
    expect(bad.status).toBe(404);

    const ok = await inviteSignup(req("POST", "/api/invitations/signup", undefined, { token, password: PASSWORD }));
    expect(ok.status).toBe(201);
    const info = await (await me(req("GET", "/api/me", cookieOf(ok)))).json();
    expect(info.user.email).toBe(email("c1-agente"));
    expect(info.tenant.id).toBe(o.tenantId);
    expect(info.tenant.role).toBe("agent");

    // Una invitación se usa una sola vez.
    const again = await inviteSignup(req("POST", "/api/invitations/signup", undefined, { token, password: PASSWORD }));
    expect(again.status).toBe(404);

    const team = await (await teamGet(req("GET", "/api/team", o.cookie))).json();
    expect(team.members.map((m: { email: string }) => m.email)).toContain(email("c1-agente"));
    expect(team.invitations).toHaveLength(0);
  });

  it("un agente no ve ni gestiona el equipo", async () => {
    const o = await register("c2");
    const token = tokenOf((await invite(o.cookie, email("c2-ag"), "agent")).body.inviteUrl);
    const ag = cookieOf(await inviteSignup(req("POST", "/api/invitations/signup", undefined, { token, password: PASSWORD })));
    expect((await teamGet(req("GET", "/api/team", ag))).status).toBe(403);
    expect((await teamInvite(req("POST", "/api/team/invite", ag, { email: email("x"), role: "agent" }))).status).toBe(403);
  });

  it("un admin solo invita y quita agentes; solo el dueño cambia roles; el dueño no se toca", async () => {
    const o = await register("c3");
    // Esta prueba necesita más de 3 personas: se pasa el negocio a un plan más grande (como haría un súper admin).
    const c = await owner.connect();
    try {
      await c.query("BEGIN");
      await c.query("SELECT set_config('app.tenant_id', $1, true)", [o.tenantId]);
      await c.query("ALTER TABLE tenants DISABLE TRIGGER tenants_plan_guard");
      await c.query("UPDATE tenants SET plan_id = (SELECT id FROM plans WHERE slug = 'plan-3') WHERE id = $1", [o.tenantId]);
      await c.query("ALTER TABLE tenants ENABLE TRIGGER tenants_plan_guard");
      await c.query("COMMIT");
    } catch (e) { await c.query("ROLLBACK"); throw e; } finally { c.release(); }
    const tAdmin = tokenOf((await invite(o.cookie, email("c3-adm"), "admin")).body.inviteUrl);
    const admin = cookieOf(await inviteSignup(req("POST", "/api/invitations/signup", undefined, { token: tAdmin, password: PASSWORD })));
    const tAg = tokenOf((await invite(o.cookie, email("c3-ag"), "agent")).body.inviteUrl);
    await inviteSignup(req("POST", "/api/invitations/signup", undefined, { token: tAg, password: PASSWORD }));

    expect((await invite(admin, email("c3-otro-adm"), "admin")).status).toBe(403);
    expect((await invite(admin, email("c3-otro-ag"), "agent")).status).toBe(201);

    const team = await (await teamGet(req("GET", "/api/team", o.cookie))).json();
    const idOf = (e: string) => team.members.find((m: { email: string }) => m.email === e).userId as string;

    expect((await teamRole(req("POST", "/api/team/role", admin, { userId: idOf(email("c3-ag")), role: "admin" }))).status).toBe(403);
    expect((await teamRemove(req("POST", "/api/team/remove", admin, { userId: o.userId }))).status).toBe(403);
    expect((await teamRemove(req("POST", "/api/team/remove", o.cookie, { userId: o.userId }))).status).toBe(400);
    expect((await teamRole(req("POST", "/api/team/role", o.cookie, { userId: o.userId, role: "agent" }))).status).toBe(403);

    expect((await teamRole(req("POST", "/api/team/role", o.cookie, { userId: idOf(email("c3-ag")), role: "admin" }))).status).toBe(200);
    // Ahora ese admin ya no puede ser quitado por otro admin.
    expect((await teamRemove(req("POST", "/api/team/remove", admin, { userId: idOf(email("c3-ag")) }))).status).toBe(403);
    expect((await teamRemove(req("POST", "/api/team/remove", o.cookie, { userId: idOf(email("c3-ag")) }))).status).toBe(200);
  });

  it("quitar a alguien le corta el acceso al negocio de inmediato", async () => {
    const o = await register("c4");
    const t = tokenOf((await invite(o.cookie, email("c4-ag"), "agent")).body.inviteUrl);
    const ag = cookieOf(await inviteSignup(req("POST", "/api/invitations/signup", undefined, { token: t, password: PASSWORD })));
    const team = await (await teamGet(req("GET", "/api/team", o.cookie))).json();
    const id = team.members.find((m: { email: string }) => m.email === email("c4-ag")).userId;
    expect((await teamRemove(req("POST", "/api/team/remove", o.cookie, { userId: id }))).status).toBe(200);
    const info = await (await me(req("GET", "/api/me", ag))).json();
    expect(info.tenant).toBeNull();
  });

  it("revocar invita­ción la invalida; no se puede invitar a un miembro ni pasar del tope del plan (3 personas)", async () => {
    const o = await register("c5");
    const inv = await invite(o.cookie, email("c5-x"), "agent");
    const list = await (await teamGet(req("GET", "/api/team", o.cookie))).json();
    const rev = await teamInvitation(req("POST", "/api/team/invitation", o.cookie, { invitationId: list.invitations[0].id }));
    expect(rev.status).toBe(200);
    const dead = await inviteSignup(req("POST", "/api/invitations/signup", undefined, { token: tokenOf(inv.body.inviteUrl), password: PASSWORD }));
    expect(dead.status).toBe(404);
    expect((await invite(o.cookie, o.email, "agent")).status).toBe(409);

    for (let i = 0; i < 2; i++) { // el dueño + 2 = 3, el tope del plan por defecto
      const r = await invite(o.cookie, email(`c5-m${i}`), "agent");
      expect(r.status).toBe(201);
    }
    expect((await invite(o.cookie, email("c5-extra"), "agent")).status).toBe(409);
  });

  it("invitación vencida no sirve", async () => {
    const o = await register("c6");
    const t = tokenOf((await invite(o.cookie, email("c6-x"), "agent")).body.inviteUrl);
    await owner.query("UPDATE invitations SET expires_at = now() - interval '1 minute' WHERE tenant_id = $1", [o.tenantId]);
    expect((await inviteSignup(req("POST", "/api/invitations/signup", undefined, { token: t, password: PASSWORD }))).status).toBe(404);
  });

  it("quien ya tiene cuenta acepta con su sesión; con otro correo no", async () => {
    const o = await register("c7");
    const other = await register("c7-b");
    const stranger = await register("c7-c");
    const t = tokenOf((await invite(o.cookie, other.email, "admin")).body.inviteUrl);

    const signupExisting = await inviteSignup(req("POST", "/api/invitations/signup", undefined, { token: t, password: PASSWORD }));
    expect(signupExisting.status).toBe(409);

    expect((await inviteAccept(req("POST", "/api/invitations/accept", stranger.cookie, { token: t }))).status).toBe(404);
    expect((await inviteAccept(req("POST", "/api/invitations/accept", undefined, { token: t }))).status).toBe(401);
    expect((await inviteAccept(req("POST", "/api/invitations/accept", other.cookie, { token: t }))).status).toBe(200);
    const info = await (await me(req("GET", "/api/me", other.cookie))).json();
    expect(info.tenant.id).toBe(o.tenantId);
    expect(info.tenant.role).toBe("admin");
  });

  it("aislamiento: llamar las funciones de equipo de OTRO negocio falla en la base", async () => {
    const a = await register("c8-a");
    const b = await register("c8-b");
    const hashB = hashToken(b.cookie.split("=")[1]!);
    const pool = getPool();
    await expect(pool.query("SELECT * FROM team_members($1, $2)", [hashB, a.tenantId])).rejects.toMatchObject({ code: "42501" });
    await expect(pool.query("SELECT team_invite($1, $2, 'x@y.zz', 'agent', $3)", [hashB, a.tenantId, Buffer.alloc(32, 1)])).rejects.toMatchObject({ code: "42501" });
    await expect(pool.query("SELECT team_remove($1, $2, $3)", [hashB, a.tenantId, a.userId])).rejects.toMatchObject({ code: "42501" });
  });
});

describe("defensa en la base (aunque falle la capa web)", () => {
  it("una sesión pendiente de 2FA no sirve ni llamando directo a las funciones", async () => {
    const u = await userWithMfa("d1");
    const pending = cookieOf(await loginRaw(u.email));
    const h = hashToken(pending.split("=")[1]!);
    await expect(getPool().query("SELECT * FROM team_members($1, $2)", [h, u.tenantId])).rejects.toMatchObject({ code: "42501" });
    expect((await getPool().query("SELECT * FROM mfa_status($1)", [h])).rowCount).toBe(0);
    await expect(getPool().query("SELECT mfa_setup_start($1, 'x', 1)", [h])).rejects.toMatchObject({ code: "42501" });
  });

  it("mfa_complete rechaza en la base un paso ya usado", async () => {
    const u = await userWithMfa("d2");
    await owner.query("UPDATE user_mfa SET last_step = 5000000000 WHERE user_id = $1", [u.userId]);
    const pending = cookieOf(await loginRaw(u.email));
    const h = hashToken(pending.split("=")[1]!);
    const r = await getPool().query("SELECT mfa_complete($1, 4999999999, $2, 'x') AS age", [h, Buffer.alloc(32, 9)]);
    expect(r.rows[0].age).toBeNull();
    const ok = await getPool().query("SELECT mfa_complete($1, 5000000001, $2, 'x') AS age", [h, Buffer.alloc(32, 9)]);
    expect(ok.rows[0].age).toBeGreaterThan(0);
  });

  it("la suplantación vencida ya no da rol en el negocio", async () => {
    const sa = await (async () => {
      const addr = email("d3-sa");
      const ins = await owner.query("INSERT INTO users (email, password_hash, is_super_admin) VALUES ($1, $2, true) RETURNING id", [addr, await hashPassword(PASSWORD)]);
      const secret = await enableMfaDirect(owner, ins.rows[0].id);
      const p = cookieOf(await loginRaw(addr));
      const c = cookieOf(await verify2fa(req("POST", "/api/auth/2fa/verify", p, { code: codeFor(secret) })));
      return c;
    })();
    const t = await register("d3-t");
    const h = hashToken(sa.split("=")[1]!);
    expect((await getPool().query("SELECT admin_start_impersonation($1, $2, 'soporte de prueba largo')", [h, t.tenantId])).rowCount).toBe(1);
    expect((await getPool().query("SELECT * FROM team_members($1, $2)", [h, t.tenantId])).rowCount).toBeGreaterThan(0);
    await owner.query("UPDATE sessions SET acting_until = now() - interval '1 minute' WHERE token_hash = $1", [h]);
    await expect(getPool().query("SELECT * FROM team_members($1, $2)", [h, t.tenantId])).rejects.toMatchObject({ code: "42501" });
  });
});
EOF_TESTS_MFA-TEAM_TEST_TS
echo "✔ tests/mfa-team.test.ts"

cat <<'FIN'

══════════════════════════════════════════════════════════
 Paso 18A aplicado. Ahora, en este orden:

   1) npm run db:up
   2) npm run db:migrate       # aplica 0023 (planes)
   3) npm run typecheck && npm run lint && npm test
   4) npm run dev:all          # reinícialo
   5) Prueba:
        - Entra como súper admin → «Administración»: arriba verás los PLANES (nombre, respuestas al mes,
          personas del equipo, módulos, activo). Abajo, cada negocio tiene su selector de plan.
        - Como dueño de un negocio → «Panel»: tarjeta «Tu plan» con el consumo del mes.

   Qué se aplica YA:
   - Respuestas del asistente por mes (mes calendario UTC): al llegar al tope el asistente deja de responder,
     no gasta IA, la conversación pasa a una persona y aparece una tarea en «Hoy». «Sin tope» = ilimitado.
   - Personas del equipo (miembros + invitaciones pendientes) según el plan (antes era 25 fijo).
   - Solo un súper admin puede cambiar el plan de un negocio (ni el dueño, ni con SQL directo).

   Qué NO se aplica todavía (es el Paso 18B): los «módulos incluidos» solo se guardan; aún no bloquean nada.

   Los tres planes («Plan 1/2/3», 300/2000/10000 respuestas, 3/6/15 personas) son PROVISIONALES: cámbialos
   desde Administración. Los negocios que ya existían quedan en Plan 1 (3 personas): si alguno tiene más
   gente, sube su plan antes de que intenten invitar a alguien más.
   Los precios y el cobro llegan en los siguientes pasos.
══════════════════════════════════════════════════════════
FIN