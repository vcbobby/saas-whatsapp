import { redirect } from "next/navigation";
import { getPool } from "@/lib/db";
import { getConsentMode } from "@/lib/env";
import { LEGAL_VERSION } from "@/lib/legal/docs";
import { buildClearCookie, buildSessionCookie, readSessionToken } from "./cookies";
import type { Role } from "./permissions";
import { hashToken, newSessionToken } from "./tokens";

export interface Session {
  sessionId: string;
  userId: string;
  email: string;
  isSuperAdmin: boolean;
  activeTenantId: string | null;
  activeTenantStatus: string | null;
  role: Role | null;
  actingTenantId: string | null;
  /** El usuario tiene 2FA activado. */
  mfaEnabled: boolean;
  /** Es súper admin pero aún no activó 2FA: no tiene poderes hasta hacerlo. */
  needsMfaSetup: boolean;
  /**
   * Hay documentos legales nuevos que esta persona aún no acepta. Mientras sea true, solo puede aceptar, salir o descargar sus datos
   * (las rutas lo comprueban en los guards y las páginas en getSessionFromHeaders). Solo se aplica con LEGAL_CONSENT=required.
   */
  legalPending: boolean;
}

/** Quienes ya aceptaron la versión vigente se recuerdan 60 s para no consultar la base en cada petición. */
const legalOk = new Map<string, number>();
async function isLegalPending(userId: string): Promise<boolean> {
  if (getConsentMode() !== "required") return false;
  const key = `${userId}:${LEGAL_VERSION}`;
  const until = legalOk.get(key);
  if (until && until > Date.now()) return false;
  const r = await getPool().query<{ version: string }>("SELECT version FROM legal_latest($1)", [userId]);
  if (r.rows[0]?.version === LEGAL_VERSION) {
    if (legalOk.size > 5_000) legalOk.clear();
    legalOk.set(key, Date.now() + 60_000);
    return false;
  }
  return true;
}
/** Lo que se puede hacer aun sin haber aceptado: aceptar, ver quién soy, salir y llevarse sus datos. */
export const LEGAL_EXEMPT_PATHS = new Set(["/api/legal/accept", "/api/me", "/api/auth/logout", "/api/auth/logout-all", "/api/privacy/export"]);

/** Negocio con el que se debe consultar la base y rol con el que se actúa. */
export interface TenantContext {
  tenantId: string;
  role: Role;
  impersonating: boolean;
}

export async function getSession(req: Request): Promise<Session | null> {
  const token = readSessionToken(req);
  if (!token) return null;
  const r = await getPool().query("SELECT * FROM auth_get_session($1)", [hashToken(token)]);
  const row = r.rows[0];
  if (!row) return null;
  return {
    sessionId: row.sess_id,
    userId: row.sess_user_id,
    email: row.sess_email,
    isSuperAdmin: row.sess_super,
    activeTenantId: row.sess_active_tenant,
    activeTenantStatus: row.sess_tenant_status,
    role: row.sess_role,
    actingTenantId: row.sess_acting_tenant,
    mfaEnabled: row.sess_mfa_enabled,
    needsMfaSetup: row.sess_needs_mfa_setup,
    legalPending: await isLegalPending(row.sess_user_id),
  };
}

/** Crea una sesión nueva (siempre un token nuevo: evita fijación de sesión). */
export async function startSession(
  userId: string,
  req: Request,
): Promise<{ setCookie: string; pending: boolean }> {
  const { token, hash } = newSessionToken();
  const r = await getPool().query<{ max_age_seconds: number; is_pending: boolean }>(
    "SELECT * FROM auth_create_session($1, $2, $3)",
    [userId, hash, req.headers.get("user-agent") ?? ""],
  );
  const row = r.rows[0]!;
  // Si el usuario tiene 2FA, la sesión nace "pendiente" (10 min) y solo sirve para el 2FA.
  return { setCookie: buildSessionCookie(token, row.max_age_seconds), pending: row.is_pending };
}

export async function endSession(req: Request): Promise<void> {
  const token = readSessionToken(req);
  if (token) await getPool().query("SELECT auth_revoke_session($1)", [hashToken(token)]);
}

export async function endAllSessions(req: Request): Promise<void> {
  const token = readSessionToken(req);
  if (token) await getPool().query("SELECT auth_revoke_all_sessions($1)", [hashToken(token)]);
}

/** Para páginas del servidor (Server Components): lee la sesión desde las cabeceras. */
export async function getSessionFromHeaders(
  h: Headers,
  opts: { allowLegalPending?: boolean } = {},
): Promise<{ session: Session; tokenHash: Buffer } | null> {
  const cookie = h.get("cookie");
  if (!cookie) return null;
  const req = new Request("http://interno.local/", { headers: { cookie } });
  const session = await getSession(req);
  const tokenHash = tokenHashOf(req);
  if (session && session.legalPending && !opts.allowLegalPending) redirect("/terminos-nuevos");
  return session && tokenHash ? { session, tokenHash } : null;
}

export function clearCookie(): string {
  return buildClearCookie();
}

export function tokenHashOf(req: Request): Buffer | null {
  const token = readSessionToken(req);
  return token ? hashToken(token) : null;
}

export function effectiveTenant(session: Session): TenantContext | null {
  if (session.isSuperAdmin && session.actingTenantId) {
    // Soporte: actúa como "admin" (no puede tocar facturación ni borrar el negocio).
    return { tenantId: session.actingTenantId, role: "admin", impersonating: true };
  }
  if (session.activeTenantId && session.role) {
    return { tenantId: session.activeTenantId, role: session.role, impersonating: false };
  }
  return null;
}
