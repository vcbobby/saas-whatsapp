import { errorResponse } from "./http";
import { can, type Permission } from "./permissions";
import { effectiveTenant, getSession, tokenHashOf, type Session, type TenantContext } from "./session";

type Guarded<T> = ({ ok: true } & T) | { ok: false; response: Response };

export async function requireSession(req: Request): Promise<Guarded<{ session: Session }>> {
  const session = await getSession(req);
  if (!session) {
    return { ok: false, response: errorResponse(401, "no_autenticado", "Inicia sesión.") };
  }
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
  return { ok: true, session, tokenHash };
}

/**
 * Para rutas de un negocio: devuelve el negocio y rol con los que consultar.
 * El tenantId sale SIEMPRE de aquí (de la sesión del servidor), nunca de la petición.
 */
export async function requireTenant(
  req: Request,
  permission?: Permission,
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
  return { ok: true, session: auth.session, ctx };
}
