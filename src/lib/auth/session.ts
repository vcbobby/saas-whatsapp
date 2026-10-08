import { getPool } from "@/lib/db";
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
}

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
  };
}

/** Crea una sesión nueva (siempre un token nuevo: evita fijación de sesión). */
export async function startSession(
  userId: string,
  req: Request,
): Promise<{ setCookie: string }> {
  const { token, hash } = newSessionToken();
  const r = await getPool().query<{ max_age_seconds: number }>(
    "SELECT * FROM auth_create_session($1, $2, $3)",
    [userId, hash, req.headers.get("user-agent") ?? ""],
  );
  return { setCookie: buildSessionCookie(token, r.rows[0]!.max_age_seconds) };
}

export async function endSession(req: Request): Promise<void> {
  const token = readSessionToken(req);
  if (token) await getPool().query("SELECT auth_revoke_session($1)", [hashToken(token)]);
}

export async function endAllSessions(req: Request): Promise<void> {
  const token = readSessionToken(req);
  if (token) await getPool().query("SELECT auth_revoke_all_sessions($1)", [hashToken(token)]);
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

/** Para páginas del servidor (Server Components): lee la sesión desde las cabeceras. */
export async function getSessionFromHeaders(
  h: Headers,
): Promise<{ session: Session; tokenHash: Buffer } | null> {
  const cookie = h.get("cookie");
  if (!cookie) return null;
  const req = new Request("http://interno.local/", { headers: { cookie } });
  const session = await getSession(req);
  const tokenHash = tokenHashOf(req);
  return session && tokenHash ? { session, tokenHash } : null;
}
