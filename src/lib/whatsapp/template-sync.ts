import { withTenant } from "@/lib/db";
import { explainTemplateError, listMetaTemplates } from "./templates";
import type { LoadedIntegration } from "./integration";

export type SyncResult = { ok: true; total: number; removed: number } | { ok: false; message: string };

/** Trae las plantillas de Meta y deja la copia local igual (Meta manda: estado, rechazos, plantillas creadas en su panel). */
export async function syncTemplates(tenantId: string, conn: LoadedIntegration, fetchImpl: typeof fetch = fetch): Promise<SyncResult> {
  if (!conn.wabaId) return { ok: false, message: "Falta el ID de tu cuenta de WhatsApp Business (WABA)." };
  const r = await listMetaTemplates(conn.wabaId, conn.accessToken, fetchImpl);
  if (!r.ok) return { ok: false, message: explainTemplateError(r.error, "network" in r ? r.network : undefined) };
  const list = r.data;
  const removed = await withTenant(tenantId, async (db) => {
    for (const t of list) {
      await db.query(
        `INSERT INTO whatsapp_templates (tenant_id, name, language, category, body, examples, sendable, status, reason, meta_id)
         VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9,$10)
         ON CONFLICT (tenant_id, name, language) DO UPDATE
           SET category = EXCLUDED.category, body = EXCLUDED.body, examples = EXCLUDED.examples, sendable = EXCLUDED.sendable,
               status = EXCLUDED.status, reason = EXCLUDED.reason, meta_id = EXCLUDED.meta_id, updated_at = now()`,
        [tenantId, t.name, t.language, t.category, t.body, JSON.stringify(t.examples), t.sendable, t.status, t.reason, t.id || null],
      );
    }
    // Lo que ya no existe en Meta se quita de la copia local (solo si Meta devolvió una lista completa).
    const names = list.map((t) => `${t.name}|${t.language}`);
    const del = await db.query("DELETE FROM whatsapp_templates WHERE tenant_id = $1 AND NOT (name || '|' || language = ANY($2::text[]))", [tenantId, names]);
    return del.rowCount ?? 0;
  });
  return { ok: true, total: list.length, removed };
}
