import { z } from "zod";
import { requireTenant } from "@/lib/auth/guard";
import { checkOrigin, errorResponse, jsonResponse, readJson, route } from "@/lib/auth/http";
import { withTenant } from "@/lib/db";

const schema = z.object({ id: z.uuid(), body: z.string().trim().min(1, "Escribe la nota").max(2000, "Máximo 2000 caracteres") });

/** Nota privada en una conversación: solo la ve el equipo y nunca se envía al cliente. */
export const POST = route(async (req) => {
  const blocked = checkOrigin(req);
  if (blocked) return blocked;
  const auth = await requireTenant(req, "conversations:reply");
  if (!auth.ok) return auth.response;
  const body = await readJson(req, schema);
  if (!body.ok) return body.response;
  const { tenantId } = auth.ctx;
  const label = (auth.session.email.split("@")[0] ?? "equipo").slice(0, 80) || "equipo";
  const note = await withTenant(tenantId, async (db) => {
    const c = await db.query("SELECT 1 FROM conversations WHERE tenant_id = $1 AND id = $2", [tenantId, body.data.id]);
    if (c.rowCount !== 1) return null;
    const r = await db.query<{ id: string; created_at: Date }>(
      "INSERT INTO conversation_notes (tenant_id, conversation_id, author_id, author_label, body) VALUES ($1, $2, $3, $4, $5) RETURNING id, created_at",
      [tenantId, body.data.id, auth.session.userId, label, body.data.body],
    );
    return r.rows[0]!;
  });
  if (!note) return errorResponse(404, "no_encontrado", "No encontrado.");
  return jsonResponse({ ok: true, id: note.id }, 201);
});
