import { getPool, withTenant } from "@/lib/db";

export interface DeletionStatus {
  requestedAt: string | null;
  scheduledFor: string | null;
}

export async function getDeletionStatus(tenantId: string): Promise<DeletionStatus> {
  return withTenant(tenantId, async (db) => {
    const r = await db.query<{ a: Date | null; b: Date | null }>("SELECT deletion_requested_at AS a, deletion_scheduled_for AS b FROM tenants WHERE id = $1", [tenantId]);
    return { requestedAt: r.rows[0]?.a?.toISOString() ?? null, scheduledFor: r.rows[0]?.b?.toISOString() ?? null };
  });
}

export async function requestDeletion(tenantId: string, userId: string): Promise<string> {
  const r = await getPool().query<{ w: Date }>("SELECT tenant_request_deletion($1, $2) AS w", [tenantId, userId]);
  return r.rows[0]!.w.toISOString();
}

export async function cancelDeletion(tenantId: string, userId: string): Promise<boolean> {
  const r = await getPool().query<{ ok: boolean }>("SELECT tenant_cancel_deletion($1, $2) AS ok", [tenantId, userId]);
  return r.rows[0]?.ok === true;
}

/** Lo usa el worker: borra de forma definitiva los negocios cuyos 7 días ya pasaron. */
export async function purgeDueTenants(limit = 5): Promise<number> {
  const r = await getPool().query<{ n: number }>("SELECT tenant_purge_due($1) AS n", [limit]);
  return Number(r.rows[0]?.n ?? 0);
}
