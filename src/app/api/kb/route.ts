import type { PoolClient } from "pg";
import { z } from "zod";
import { requireTenant } from "@/lib/auth/guard";
import { checkOrigin, errorResponse, jsonResponse, readJson, route } from "@/lib/auth/http";
import { withTenant } from "@/lib/db";
import { cleanDocument } from "@/lib/kb/chunk";

/** Base de conocimiento del negocio: documentos de texto que el asistente consulta para responder. */
const MAX_BODY_CHARS = 250_000; // 50 000 caracteres de texto + escapes de JSON
const uuid = z.string().uuid();
const title = z.string().trim().min(1, "Ponle un título").max(120, "Máximo 120 caracteres");
const content = z.string().max(50_000, "Máximo 50 000 caracteres por documento");

const bodySchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("create"), title, content }),
  z.object({ action: z.literal("update"), id: uuid, title, content }),
  z.object({ action: z.literal("delete"), id: uuid }),
  z.object({ action: z.literal("reindex") }),
]);

export const GET = route(async (req) => {
  const auth = await requireTenant(req, "agent:manage");
  if (!auth.ok) return auth.response;
  const tenantId = auth.ctx.tenantId;
  const id = new URL(req.url).searchParams.get("id");

  if (id !== null) {
    if (!uuid.safeParse(id).success) return errorResponse(400, "datos_invalidos", "Datos inválidos.");
    const doc = await withTenant(tenantId, async (db) => {
      const r = await db.query("SELECT id, title, content FROM kb_documents WHERE tenant_id = $1 AND id = $2", [tenantId, id]);
      return r.rows[0];
    });
    return doc ? jsonResponse({ document: doc }) : errorResponse(404, "no_encontrado", "No encontrado.");
  }

  const documents = await withTenant(tenantId, async (db) => {
    const r = await db.query(
      `SELECT id, title, status, error, chunk_count, char_length(content) AS chars, created_at, updated_at
         FROM kb_documents WHERE tenant_id = $1 ORDER BY created_at DESC LIMIT 100`,
      [tenantId],
    );
    return r.rows;
  });
  return jsonResponse({ documents, maxDocuments: 50 });
});

export const POST = route(async (req) => {
  const blocked = checkOrigin(req);
  if (blocked) return blocked;
  const auth = await requireTenant(req, "agent:manage");
  if (!auth.ok) return auth.response;
  const body = await readJson(req, bodySchema, { maxChars: MAX_BODY_CHARS });
  if (!body.ok) return body.response;
  const tenantId = auth.ctx.tenantId;
  const actor = auth.session.userId;
  const b = body.data;

  const audit = (db: PoolClient, action: string, meta: Record<string, unknown>) =>
    db.query("INSERT INTO audit_log (tenant_id, actor_id, action, target_type, metadata) VALUES ($1, $2, $3, 'kb_document', $4)", [tenantId, actor, action, JSON.stringify(meta)]);

  if (b.action === "reindex") {
    const n = await withTenant(tenantId, async (db) => {
      const r = await db.query("UPDATE kb_documents SET status = 'pending', error = NULL, version = version + 1 WHERE tenant_id = $1", [tenantId]);
      await audit(db, "kb.reindexed", { documents: r.rowCount });
      return r.rowCount ?? 0;
    });
    return jsonResponse({ ok: true, documents: n });
  }

  if (b.action === "delete") {
    const ok = await withTenant(tenantId, async (db) => {
      const r = await db.query("DELETE FROM kb_documents WHERE tenant_id = $1 AND id = $2", [tenantId, b.id]);
      if (r.rowCount === 1) await audit(db, "kb.deleted", { documentId: b.id });
      return r.rowCount === 1;
    });
    return ok ? jsonResponse({ ok: true }) : errorResponse(404, "no_encontrado", "No encontrado.");
  }

  const text = cleanDocument(b.content);
  if (text.length === 0) return errorResponse(400, "datos_invalidos", "El documento no tiene texto.", { fields: ["content"] });

  try {
    if (b.action === "create") {
      const id = await withTenant(tenantId, async (db) => {
        const r = await db.query("INSERT INTO kb_documents (tenant_id, title, content) VALUES ($1, $2, $3) RETURNING id", [tenantId, b.title, text]);
        // En la auditoría va solo el tamaño, no el contenido.
        await audit(db, "kb.created", { documentId: r.rows[0].id, chars: text.length });
        return r.rows[0].id as string;
      });
      return jsonResponse({ ok: true, id }, 201);
    }
    const ok = await withTenant(tenantId, async (db) => {
      const r = await db.query(
        `UPDATE kb_documents SET title = $3, content = $4, version = version + 1, status = 'pending', error = NULL, updated_at = now()
          WHERE tenant_id = $1 AND id = $2`,
        [tenantId, b.id, b.title, text],
      );
      if (r.rowCount === 1) await audit(db, "kb.updated", { documentId: b.id, chars: text.length });
      return r.rowCount === 1;
    });
    return ok ? jsonResponse({ ok: true }) : errorResponse(404, "no_encontrado", "No encontrado.");
  } catch (err) {
    if ((err as { message?: string }).message === "kb_limite") {
      return errorResponse(409, "limite_documentos", "Llegaste al máximo de 50 documentos. Borra alguno para agregar otro.");
    }
    throw err;
  }
});
