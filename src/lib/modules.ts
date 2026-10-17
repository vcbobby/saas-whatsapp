import type { PoolClient } from "pg";
import { BUSINESS_TYPES, type BusinessType } from "@/lib/agent/style";

type Db = Pick<PoolClient, "query">;

/** Módulos opcionales del panel. «Hoy», «Conversaciones» y el resto de la base siempre se ven. */
export const OPTIONAL_MODULES = ["agenda", "catalogo", "pedidos"] as const;
export type OptionalModule = (typeof OPTIONAL_MODULES)[number];

export interface ModuleUse { type: BusinessType; hasServices: boolean; hasProducts: boolean }
export interface ModuleLayout { main: OptionalModule[]; more: OptionalModule[] }

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
  return {
    main: OPTIONAL_MODULES.filter((m) => show[m]),
    more: OPTIONAL_MODULES.filter((m) => !show[m]),
  };
}

export async function loadModuleLayout(db: Db, tenantId: string): Promise<ModuleLayout> {
  const t = await db.query("SELECT business_type FROM tenant_agents WHERE tenant_id = $1", [tenantId]);
  const raw = t.rows[0]?.business_type;
  const type = (BUSINESS_TYPES as readonly string[]).includes(raw) ? (raw as BusinessType) : "atencion";
  const s = await db.query("SELECT 1 FROM agenda_services WHERE tenant_id = $1 AND active LIMIT 1", [tenantId]);
  const p = await db.query("SELECT 1 FROM catalog_products WHERE tenant_id = $1 AND active LIMIT 1", [tenantId]);
  return layoutFor({ type, hasServices: (s.rowCount ?? 0) > 0, hasProducts: (p.rowCount ?? 0) > 0 });
}
