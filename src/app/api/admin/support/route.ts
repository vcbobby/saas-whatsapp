import { getPool } from "@/lib/db";
import { errorResponse, jsonResponse, route } from "@/lib/auth/http";
import { requireSuperAdmin } from "@/lib/auth/guard";
import { adminListStatusSchema } from "@/lib/support/schema";

/** Bandeja de soporte (todos los negocios). ?status=open|answered|closed para filtrar. */
export const GET = route(async (req) => {
  const auth = await requireSuperAdmin(req);
  if (!auth.ok) return auth.response;
  const raw = new URL(req.url).searchParams.get("status");
  let status: string | null = null;
  if (raw) {
    const p = adminListStatusSchema.safeParse(raw);
    if (!p.success) return errorResponse(400, "datos_invalidos", "Estado no válido.");
    status = p.data;
  }
  const r = await getPool().query("SELECT * FROM admin_support_list($1, $2)", [auth.tokenHash, status]);
  return jsonResponse({
    tickets: r.rows.map((t) => ({
      id: t.t_id, tenantId: t.t_tenant_id, tenantName: t.t_tenant_name, email: t.t_email, subject: t.t_subject, status: t.t_status,
      lastFrom: t.t_last_from, createdAt: t.t_created_at, lastMessageAt: t.t_last_message_at, messages: Number(t.t_messages),
    })),
  });
});
