import type { PoolClient } from "pg";
import { BUSINESS_TYPES, type BusinessType } from "@/lib/agent/style";
import { loadPlan, type PlanModule } from "@/lib/plans/usage";

type Db = Pick<PoolClient, "query">;

/** Módulos opcionales del panel. «Hoy», «Conversaciones» y el resto de la base siempre se ven. */
export const OPTIONAL_MODULES = ["agenda", "catalogo", "pedidos"] as const;
export type OptionalModule = (typeof OPTIONAL_MODULES)[number];

export interface ModuleUse {
  type: BusinessType; hasServices: boolean; hasProducts: boolean;
  /** Módulos que incluye el plan. Sin indicar = todos (solo pruebas). Lo que el plan no incluye no aparece ni en «Más». */
  allowed?: readonly PlanModule[];
}
export interface ModuleLayout {
  main: OptionalModule[]; more: OptionalModule[];
  /** Enlaces del equipo que dependen del plan. */
  team: { copiloto: boolean; automatizaciones: boolean };
}
const PLAN_KEY: Record<OptionalModule, PlanModule> = { agenda: "agenda", catalogo: "catalogo", pedidos: "catalogo" };

/**
 * Qué módulos van en la barra y cuáles quedan en «Más».
 * Un módulo va a la barra si lo pide el tipo de negocio O si el negocio ya tiene datos ahí
 * (así nunca se esconde algo que ya se usa). Nada se bloquea: lo demás sigue a un clic, en «Más».
 */
export function layoutFor(u: ModuleUse): ModuleLayout {
  const show: Record<OptionalModule, boolean> = {
    agenda: u.type === "citas" || u.hasServices,
    catalogo: u.type === "catalogo" || u.hasProducts,
    pedidos: u.type === "catalogo" || u.hasProducts,
  };
  const ok = (m: OptionalModule) => !u.allowed || u.allowed.includes(PLAN_KEY[m]);
  return {
    main: OPTIONAL_MODULES.filter((m) => ok(m) && show[m]),
    more: OPTIONAL_MODULES.filter((m) => ok(m) && !show[m]),
    team: { copiloto: !u.allowed || u.allowed.includes("copiloto"), automatizaciones: !u.allowed || u.allowed.includes("automatizaciones") },
  };
}

export async function loadModuleLayout(db: Db, tenantId: string): Promise<ModuleLayout> {
  const t = await db.query("SELECT business_type FROM tenant_agents WHERE tenant_id = $1", [tenantId]);
  const raw = t.rows[0]?.business_type;
  const type = (BUSINESS_TYPES as readonly string[]).includes(raw) ? (raw as BusinessType) : "atencion";
  const s = await db.query("SELECT 1 FROM agenda_services WHERE tenant_id = $1 AND active LIMIT 1", [tenantId]);
  const p = await db.query("SELECT 1 FROM catalog_products WHERE tenant_id = $1 AND active LIMIT 1", [tenantId]);
  const plan = await loadPlan(db, tenantId);
  return layoutFor({ type, hasServices: (s.rowCount ?? 0) > 0, hasProducts: (p.rowCount ?? 0) > 0, allowed: plan?.modules ?? [] });
}
