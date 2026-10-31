import { getPool, withTenant } from "@/lib/db";
import { appLink, enqueueEmail } from "@/lib/email/outbox";
import { emailTemplates } from "@/lib/email/templates";
import { HANDOFF_REASON_TEXT } from "@/lib/work/labels";

/**
 * Avisa por correo al equipo cuando una conversación pasa a una persona.
 * A quien quedó asignada; si nadie (reparto manual), al dueño y a los administradores.
 * Un aviso por conversación y persona; si el negocio apagó los avisos, no se manda nada. Nunca lanza.
 */
export async function notifyHandoffs(max = 20): Promise<number> {
  let sent = 0;
  try {
    const claimed = await getPool().query<{ out_id: string; out_tenant_id: string; out_conversation_id: string; out_assigned_to: string | null; out_reason: string | null }>(
      "SELECT * FROM handoff_alert_claim($1)", [max],
    );
    for (const a of claimed.rows) {
      try {
        const info = await withTenant(a.out_tenant_id, async (db) => {
          const r = await db.query<{ business: string; customer: string; notify: boolean | null }>(
            `SELECT t.name AS business, COALESCE(NULLIF(ct.display_name, ''), '+' || ct.wa_id) AS customer,
                    (SELECT s.notify_email FROM team_settings s WHERE s.tenant_id = t.id) AS notify
               FROM conversations c
               JOIN contacts ct ON ct.tenant_id = c.tenant_id AND ct.id = c.contact_id
               JOIN tenants t ON t.id = c.tenant_id
              WHERE c.tenant_id = $1 AND c.id = $2 AND c.status = 'human'`,
            [a.out_tenant_id, a.out_conversation_id],
          );
          return r.rows[0];
        });
        // Ya la atendieron, la cerraron o el negocio apagó los avisos.
        if (!info || info.notify === false) continue;
        const to = await getPool().query<{ out_email: string }>("SELECT out_email FROM handoff_recipients($1, $2)", [a.out_tenant_id, a.out_assigned_to]);
        const msg = emailTemplates.chatToAttend({
          business: info.business, customer: info.customer, mine: a.out_assigned_to !== null,
          reason: HANDOFF_REASON_TEXT[a.out_reason ?? ""] ?? "El asistente pasó esta conversación a una persona.",
          url: appLink(`/conversaciones?c=${a.out_conversation_id}`),
        });
        for (const r of to.rows) {
          if (await enqueueEmail(r.out_email, msg, { tenantId: a.out_tenant_id, dedupeKey: `chat:${a.out_id}:${r.out_email}` })) sent++;
        }
      } catch (err) {
        console.error("[avisos] chat por atender:", err instanceof Error ? err.message : err);
      }
    }
  } catch (err) {
    console.error("[avisos] chats por atender:", err instanceof Error ? err.message : err);
  }
  return sent;
}
