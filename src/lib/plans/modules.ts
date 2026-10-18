import { withTenant } from "@/lib/db";
import type { Permission } from "@/lib/auth/permissions";
import type { PlanModule } from "./usage";

/** Qué módulo del plan protege cada permiso. Los que no están aquí (conversaciones, equipo, asistente…) siempre se permiten. */
export function moduleForPermission(permission: Permission | undefined): PlanModule | null {
  if (!permission) return null;
  if (permission.startsWith("agenda:")) return "agenda";
  if (permission.startsWith("catalog:") || permission.startsWith("orders:")) return "catalogo";
  if (permission.startsWith("copilot:")) return "copiloto";
  return null;
}

/** Módulos que incluye el plan del negocio. Si no se puede saber, lista vacía (cerrado por defecto). */
export async function planModulesOf(tenantId: string): Promise<PlanModule[]> {
  const rows = await withTenant(tenantId, async (db) => (await db.query("SELECT p.modules FROM tenants t JOIN plans p ON p.id = t.plan_id WHERE t.id = $1", [tenantId])).rows);
  return (rows[0]?.modules ?? []) as PlanModule[];
}

export async function tenantHasModule(tenantId: string, module: PlanModule): Promise<boolean> {
  return (await planModulesOf(tenantId)).includes(module);
}
