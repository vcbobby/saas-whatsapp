import { decryptSecret, encryptSecret } from "@/lib/crypto";
import { withTenant } from "@/lib/db";

export interface SaveIntegration {
  tenantId: string;
  actorId: string;
  phoneNumberId: string;
  accessToken: string;
  display: string;
  via: "manual" | "embedded";
  wabaId?: string | null;
  expiresAt?: Date | null;
}

/** Guarda el número del negocio (token cifrado y atado al negocio y al número). Lanza el error de la base si ya hay uno (23505). */
export async function saveIntegration(i: SaveIntegration) {
  const { payload, keyVersion } = encryptSecret(i.accessToken, `wa:${i.tenantId}:${i.phoneNumberId}`);
  await withTenant(i.tenantId, async (db) => {
    await db.query(
      `INSERT INTO tenant_integrations (tenant_id, provider, external_id, secret_enc, key_version, waba_id, connected_via, token_expires_at)
       VALUES ($1, 'whatsapp', $2, $3, $4, $5, $6, $7)`,
      [i.tenantId, i.phoneNumberId, payload, keyVersion, i.wabaId ?? null, i.via, i.expiresAt ?? null],
    );
    await db.query(
      `INSERT INTO audit_log (tenant_id, actor_id, action, target_type, target_id, metadata)
       VALUES ($1, $2, 'whatsapp.connected', 'integration', $3, $4)`,
      [i.tenantId, i.actorId, i.phoneNumberId, JSON.stringify({ display: i.display, via: i.via })],
    );
  });
}

export interface LoadedIntegration { phoneNumberId: string; accessToken: string; wabaId: string | null; via: "manual" | "embedded"; expiresAt: Date | null }

/** Lee y descifra el número conectado del negocio (solo servidor). */
export async function loadIntegration(tenantId: string): Promise<LoadedIntegration | null> {
  const row = await withTenant(tenantId, async (db) =>
    (await db.query<{ external_id: string; secret_enc: string; key_version: number; waba_id: string | null; connected_via: "manual" | "embedded"; token_expires_at: Date | null }>(
      "SELECT external_id, secret_enc, key_version, waba_id, connected_via, token_expires_at FROM tenant_integrations WHERE tenant_id = $1 AND provider = 'whatsapp'", [tenantId])).rows[0]);
  if (!row) return null;
  try {
    return { phoneNumberId: row.external_id, accessToken: decryptSecret(row.secret_enc, `wa:${tenantId}:${row.external_id}`, row.key_version), wabaId: row.waba_id, via: row.connected_via, expiresAt: row.token_expires_at };
  } catch {
    return null;
  }
}
