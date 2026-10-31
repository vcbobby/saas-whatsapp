import { z } from "zod";
import { requireTenant } from "@/lib/auth/guard";
import { checkOrigin, errorResponse, jsonResponse, readJson, route } from "@/lib/auth/http";
import { withTenant } from "@/lib/db";
import { CONSENT_SOURCES, MAX_TAGS, MAX_TAG_LENGTH, normalizeTags } from "@/lib/customers/tags";
import { CONTACT_LABELS } from "@/lib/work/labels";

const schema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("tags"), id: z.uuid(), tags: z.array(z.string().max(MAX_TAG_LENGTH * 3)).max(MAX_TAGS * 3) }),
  z.object({ action: z.literal("notes"), id: z.uuid(), notes: z.string().max(2000, "Máximo 2000 caracteres") }),
  z.object({ action: z.literal("baja"), id: z.uuid(), off: z.boolean() }),
  z.object({ action: z.literal("consent"), id: z.uuid(), source: z.enum(CONSENT_SOURCES).nullable() }),
  z.object({ action: z.literal("label"), id: z.uuid(), label: z.enum(CONTACT_LABELS) }),
]);

/** Cambia las etiquetas, la nota interna, el tipo o la baja de avisos de un cliente. */
export const POST = route(async (req) => {
  const blocked = checkOrigin(req);
  if (blocked) return blocked;
  const auth = await requireTenant(req, "contacts:edit");
  if (!auth.ok) return auth.response;
  const body = await readJson(req, schema);
  if (!body.ok) return body.response;
  const { tenantId } = auth.ctx;
  const d = body.data;

  let tags: string[] = [];
  if (d.action === "tags") {
    const n = normalizeTags(d.tags);
    if (!n.ok) return errorResponse(400, "datos_invalidos", n.message);
    tags = n.tags;
  }
  const notes = d.action === "notes" ? d.notes.replace(/\r\n/g, "\n").trim() : "";

  const found = await withTenant(tenantId, async (db) => {
    let sql: string; let args: unknown[];
    switch (d.action) {
      case "tags": sql = "UPDATE contacts SET tags = $3, updated_at = now() WHERE tenant_id = $1 AND id = $2"; args = [tenantId, d.id, tags]; break;
      case "notes": sql = "UPDATE contacts SET notes = NULLIF($3, ''), updated_at = now() WHERE tenant_id = $1 AND id = $2"; args = [tenantId, d.id, notes]; break;
      case "baja": sql = "UPDATE contacts SET notifications_off = $3, updated_at = now() WHERE tenant_id = $1 AND id = $2"; args = [tenantId, d.id, d.off]; break;
      case "consent": sql = "UPDATE contacts SET promo_consent_at = CASE WHEN $3::text IS NULL THEN NULL ELSE now() END, promo_consent_source = $3, updated_at = now() WHERE tenant_id = $1 AND id = $2"; args = [tenantId, d.id, d.source]; break;
      case "label": sql = "UPDATE contacts SET label = $3, updated_at = now() WHERE tenant_id = $1 AND id = $2"; args = [tenantId, d.id, d.label]; break;
    }
    const r = await db.query(sql, args);
    if (r.rowCount !== 1) return false;
    // La nota es privada del negocio: en el registro solo queda que cambió, no su texto.
    const meta = d.action === "tags" ? { tags } : d.action === "baja" ? { off: d.off } : d.action === "label" ? { label: d.label } : d.action === "consent" ? { source: d.source } : {};
    await db.query(
      "INSERT INTO audit_log (tenant_id, actor_id, action, target_type, target_id, metadata) VALUES ($1, $2, $3, 'contact', $4, $5::jsonb)",
      [tenantId, auth.session.userId, `customer.${d.action}`, d.id, JSON.stringify(meta)],
    );
    return true;
  });
  if (!found) return errorResponse(404, "no_encontrado", "No encontrado.");
  return jsonResponse({ ok: true, ...(d.action === "tags" ? { tags } : {}) });
});
