import { requireSession } from "@/lib/auth/guard";
import { errorResponse, jsonResponse, route } from "@/lib/auth/http";
import { getPool } from "@/lib/db";
import { devToolsEnabled } from "@/lib/env";

/** Bandeja de correos de DESARROLLO (solo en tu computadora): aquí aparecen los correos que en producción irían a la gente. */
export const GET = route(async (req) => {
  if (!devToolsEnabled()) return errorResponse(404, "no_encontrado", "No encontrado.");
  const auth = await requireSession(req);
  if (!auth.ok) return auth.response;
  const r = await getPool().query("SELECT * FROM email_dev_list(40)");
  return jsonResponse({ emails: r.rows.map((e) => ({ id: e.out_id, to: e.out_to, subject: e.out_subject, text: e.out_text, status: e.out_status, template: e.out_template, createdAt: e.out_created })) });
});
