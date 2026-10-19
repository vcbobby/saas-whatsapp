import type { PoolClient } from "pg";
import { hasPlaceholders } from "@/lib/agent/style";
import { loadPlan } from "@/lib/plans/usage";
import { buildInstructions, COUNTRY_DEFAULTS, effectiveType, parseHourRange, type OnboardingInput } from "./schema";

type Db = Pick<PoolClient, "query">;

export type OnboardingResult =
  | { ok: true; businessType: string; services: number; products: number; hours: boolean; instructionsKept: boolean; downgraded: boolean }
  | { ok: false; code: "ya_completado" | "horario_invalido" | "sin_negocio"; message: string };

/**
 * Aplica TODO el asistente de bienvenida dentro de la transacción del llamador (si algo falla, no queda nada a medias).
 * Solo rellena: no pisa servicios, productos ni horarios que el negocio ya tenga.
 */
export async function applyOnboarding(db: Db, tenantId: string, userId: string, input: OnboardingInput): Promise<OnboardingResult> {
  const t = await db.query("SELECT name, onboarding_state FROM tenants WHERE id = $1 FOR UPDATE", [tenantId]);
  const tenant = t.rows[0] as { name: string; onboarding_state: string } | undefined;
  if (!tenant) return { ok: false, code: "sin_negocio", message: "No se encontró el negocio." };
  if (tenant.onboarding_state === "done") return { ok: false, code: "ya_completado", message: "Ya completaste la configuración inicial. Puedes cambiar todo desde el menú." };

  const mods = (await loadPlan(db, tenantId))?.modules ?? [];
  const type = effectiveType(input.businessType, mods);
  const defaults = COUNTRY_DEFAULTS[input.country];

  let range: { start: number; end: number } | null = null;
  if (type === "citas" && input.hours && input.hours.days.length > 0) {
    const r = parseHourRange(input.hours.start, input.hours.end);
    if (typeof r === "string") return { ok: false, code: "horario_invalido", message: r };
    range = r;
  }

  // Zona horaria: se usa para «hoy» en el panel y para la agenda, aunque el negocio no use citas.
  await db.query(
    `INSERT INTO agenda_settings (tenant_id, timezone, updated_by) VALUES ($1, $2, $3)
     ON CONFLICT (tenant_id) DO UPDATE SET timezone = EXCLUDED.timezone, updated_at = now(), updated_by = EXCLUDED.updated_by`,
    [tenantId, defaults.timezone, userId],
  );

  let services = 0;
  let hoursSet = false;
  if (type === "citas") {
    for (const s of input.services) {
      const r = await db.query(
        `INSERT INTO agenda_services (tenant_id, name, duration_minutes, price_text)
         SELECT $1, $2, $3, $4 WHERE NOT EXISTS (SELECT 1 FROM agenda_services WHERE tenant_id = $1 AND active AND lower(name) = lower($2))`,
        [tenantId, s.name, s.durationMinutes, s.priceText || null],
      );
      services += r.rowCount ?? 0;
    }
    if (range) {
      const has = await db.query("SELECT 1 FROM agenda_hours WHERE tenant_id = $1 LIMIT 1", [tenantId]);
      if (!has.rowCount) {
        for (const d of [...new Set(input.hours!.days)]) {
          await db.query("INSERT INTO agenda_hours (tenant_id, weekday, start_min, end_min) VALUES ($1,$2,$3,$4)", [tenantId, d, range.start, range.end]);
        }
        hoursSet = true;
      }
    }
  }

  let products = 0;
  if (type === "catalogo") {
    await db.query(
      `INSERT INTO catalog_settings (tenant_id, currency, updated_by) VALUES ($1, $2, $3)
       ON CONFLICT (tenant_id) DO UPDATE SET currency = EXCLUDED.currency, updated_at = now(), updated_by = EXCLUDED.updated_by`,
      [tenantId, defaults.currency, userId],
    );
    for (const p of input.products) {
      const r = await db.query(
        `INSERT INTO catalog_products (tenant_id, name, price_minor)
         SELECT $1, $2, $3 WHERE NOT EXISTS (SELECT 1 FROM catalog_products WHERE tenant_id = $1 AND active AND lower(name) = lower($2))`,
        [tenantId, p.name, p.priceMinor],
      );
      products += r.rowCount ?? 0;
    }
  }

  // Información del negocio: no se pisa un texto que la persona ya escribió (sí uno vacío o sin rellenar de la plantilla).
  const prev = await db.query("SELECT instructions FROM tenant_agents WHERE tenant_id = $1", [tenantId]);
  const old = String(prev.rows[0]?.instructions ?? "").trim();
  const keep = old !== "" && !hasPlaceholders(old);
  const instructions = keep ? old : buildInstructions(tenant.name, input.info);
  await db.query(
    `INSERT INTO tenant_agents (tenant_id, enabled, assistant_name, instructions, business_type, country, tone, emoji_level, updated_at, updated_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now(), $9)
     ON CONFLICT (tenant_id) DO UPDATE SET enabled = EXCLUDED.enabled, assistant_name = EXCLUDED.assistant_name, instructions = EXCLUDED.instructions,
       business_type = EXCLUDED.business_type, country = EXCLUDED.country, tone = EXCLUDED.tone, emoji_level = EXCLUDED.emoji_level,
       updated_at = now(), updated_by = EXCLUDED.updated_by`,
    [tenantId, input.activate, input.assistantName, instructions, type, input.country, input.tone, input.emojiLevel, userId],
  );

  await db.query("UPDATE tenants SET onboarding_state = 'done' WHERE id = $1", [tenantId]);
  await db.query("INSERT INTO audit_log (tenant_id, actor_id, action, target_type, metadata) VALUES ($1, $2, 'onboarding.completed', 'tenant', $3)", [
    tenantId, userId, JSON.stringify({ businessType: type, country: input.country, services, products, hours: hoursSet, activated: input.activate }),
  ]);
  return { ok: true, businessType: type, services, products, hours: hoursSet, instructionsKept: keep, downgraded: type !== input.businessType };
}
