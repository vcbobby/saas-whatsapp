import { requireTenant } from "@/lib/auth/guard";
import { checkOrigin, errorResponse, jsonResponse, readJson, route } from "@/lib/auth/http";
import { withTenant } from "@/lib/db";
import { createTicketSchema, supportDbError } from "@/lib/support/schema";

/** Mis consultas a soporte (las del negocio), las abiertas primero. */
export const GET = route(async (req) => {
  const auth = await requireTenant(req, "support:use");
  if (!auth.ok) return auth.response;
  const { tenantId } = auth.ctx;
  const rows = await withTenant(tenantId, async (db) =>
    (await db.query(
      `SELECT id, subject, status, last_from, created_at, last_message_at FROM support_tickets
        WHERE tenant_id = $1 ORDER BY (status = 'closed'), last_message_at DESC LIMIT 100`,
      [tenantId],
    )).rows,
  );
  return jsonResponse({
    tickets: rows.map((t) => ({ id: t.id, subject: t.subject, status: t.status, lastFrom: t.last_from, createdAt: t.created_at, lastMessageAt: t.last_message_at })),
  });
});

/** Nueva consulta. Tope: 5 abiertas por negocio. */
export const POST = route(async (req) => {
  const blocked = checkOrigin(req);
  if (blocked) return blocked;
  const auth = await requireTenant(req, "support:use");
  if (!auth.ok) return auth.response;
  if (auth.ctx.impersonating) return errorResponse(403, "sin_permiso", "El soporte no puede abrir consultas en nombre de un negocio.");
  const body = await readJson(req, createTicketSchema);
  if (!body.ok) return body.response;
  try {
    const id = await withTenant(auth.ctx.tenantId, async (db) =>
      (await db.query("SELECT support_create($1, $2, $3) AS id", [auth.session.userId, body.data.subject, body.data.body])).rows[0].id as string,
    );
    return jsonResponse({ ok: true, id }, 201);
  } catch (e) {
    const known = supportDbError(e);
    if (known) return errorResponse(known.status, known.code, known.message);
    throw e;
  }
}, { limit: "support" });
