import { requireTenant } from "@/lib/auth/guard";
import { errorResponse, jsonResponse, route } from "@/lib/auth/http";
import { withTenant } from "@/lib/db";
import { CUSTOMER_STATUS_LABEL, idQuerySchema } from "@/lib/support/schema";

/** Una consulta con todos sus mensajes. */
export const GET = route(async (req) => {
  const auth = await requireTenant(req, "support:use");
  if (!auth.ok) return auth.response;
  const id = idQuerySchema.safeParse(new URL(req.url).searchParams.get("id"));
  if (!id.success) return errorResponse(400, "datos_invalidos", "Consulta no válida.");
  const { tenantId } = auth.ctx;
  const data = await withTenant(tenantId, async (db) => {
    const t = await db.query("SELECT id, subject, status, created_at, last_message_at FROM support_tickets WHERE tenant_id = $1 AND id = $2", [tenantId, id.data]);
    if (t.rowCount !== 1) return null;
    const m = await db.query("SELECT id, from_support, body, created_at FROM support_messages WHERE tenant_id = $1 AND ticket_id = $2 ORDER BY created_at, id", [tenantId, id.data]);
    return { t: t.rows[0], m: m.rows };
  });
  if (!data) return errorResponse(404, "no_encontrado", "No encontrado.");
  return jsonResponse({
    ticket: { id: data.t.id, subject: data.t.subject, status: data.t.status, statusLabel: CUSTOMER_STATUS_LABEL[data.t.status as keyof typeof CUSTOMER_STATUS_LABEL], createdAt: data.t.created_at, lastMessageAt: data.t.last_message_at },
    messages: data.m.map((x) => ({ id: x.id, fromSupport: x.from_support, body: x.body, createdAt: x.created_at })),
  });
});
