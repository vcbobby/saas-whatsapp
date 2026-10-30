import { errorResponse } from "./http";
import { can, type Permission } from "./permissions";
import { moduleForPermission, tenantHasModule } from "@/lib/plans/modules";
import type { PlanModule } from "@/lib/plans/usage";
import { LEGAL_EXEMPT_PATHS, effectiveTenant, getSession, tokenHashOf, type Session, type TenantContext } from "./session";

type Guarded<T> = ({ ok: true } & T) | { ok: false; response: Response };

/** Con documentos legales nuevos sin aceptar, la cuenta queda congelada salvo para aceptar, salir y descargar sus datos. */
function legalBlock(req: Request, session: Session): Response | null {
  if (!session.legalPending) return null;
  let path = "";
  try { path = new URL(req.url).pathname; } catch { /* sin ruta: se bloquea */ }
  if (LEGAL_EXEMPT_PATHS.has(path)) return null;
  return errorResponse(403, "terminos_pendientes", "Para seguir usando el servicio debes aceptar los términos actualizados. Recarga la página para verlos.");
}

export async function requireSession(req: Request): Promise<Guarded<{ session: Session }>> {
  const session = await getSession(req);
  if (!session) {
    return { ok: false, response: errorResponse(401, "no_autenticado", "Inicia sesión.") };
  }
  const blocked = legalBlock(req, session);
  if (blocked) return { ok: false, response: blocked };
  return { ok: true, session };
}

/** Rutas del súper admin. A cualquier otra persona se le responde "no existe". */
export async function requireSuperAdmin(
  req: Request,
): Promise<Guarded<{ session: Session; tokenHash: Buffer }>> {
  const session = await getSession(req);
  const tokenHash = tokenHashOf(req);
  if (!session || !session.isSuperAdmin || !tokenHash) {
    return { ok: false, response: errorResponse(404, "no_encontrado", "No encontrado.") };
  }
  const blocked = legalBlock(req, session);
  if (blocked) return { ok: false, response: blocked };
  return { ok: true, session, tokenHash };
}

/**
 * Para rutas de un negocio: devuelve el negocio y rol con los que consultar.
 * El tenantId sale SIEMPRE de aquí (de la sesión del servidor), nunca de la petición.
 */
export async function requireTenant(
  req: Request,
  permission?: Permission,
  /** Módulo del plan que protege esta ruta. Si no se indica, se deduce del permiso (agenda, catálogo/pedidos, copiloto). */
  module?: PlanModule,
): Promise<Guarded<{ session: Session; ctx: TenantContext }>> {
  const auth = await requireSession(req);
  if (!auth.ok) return auth;
  const ctx = effectiveTenant(auth.session);
  if (!ctx) {
    return { ok: false, response: errorResponse(403, "sin_negocio", "No tienes acceso a un negocio.") };
  }
  if (!ctx.impersonating && auth.session.activeTenantStatus === "suspended") {
    return { ok: false, response: errorResponse(403, "cuenta_suspendida", "La cuenta está suspendida.") };
  }
  if (permission && !can(ctx.role, permission)) {
    return { ok: false, response: errorResponse(403, "sin_permiso", "No tienes permiso para esto.") };
  }
  const needed = module ?? moduleForPermission(permission);
  if (needed && !(await tenantHasModule(ctx.tenantId, needed))) {
    return { ok: false, response: errorResponse(403, "modulo_no_incluido", "Tu plan no incluye este módulo.") };
  }
  return { ok: true, session: auth.session, ctx };
}
