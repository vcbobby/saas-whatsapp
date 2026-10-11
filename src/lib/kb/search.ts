import { withTenant } from "@/lib/db";
import { toVectorLiteral, type Embedder } from "./embeddings";

export interface Snippet {
  title: string;
  content: string;
}

export const KB_TOP_K = 4;
const MAX_SNIPPET_CHARS = 1_000;
const MAX_TOTAL_CHARS = 3_000;

/**
 * Busca en la base de conocimiento DEL NEGOCIO (la RLS impide ver otra) los fragmentos más parecidos a la pregunta.
 * Devuelve [] si el negocio no tiene fragmentos del modelo actual (sin gastar cómputo en vectorizar).
 */
export async function searchKnowledge(tenantId: string, query: string, embedder: Embedder, k = KB_TOP_K): Promise<Snippet[]> {
  const q = query.trim().slice(0, 600);
  if (!q) return [];
  const has = await withTenant(tenantId, async (db) => {
    const r = await db.query("SELECT 1 FROM kb_chunks WHERE tenant_id = $1 AND embedding_model = $2 LIMIT 1", [tenantId, embedder.model]);
    return r.rowCount === 1;
  });
  if (!has) return [];
  const [vec] = await embedder.embed([q], "query");
  if (!vec) return [];
  const rows = await withTenant(tenantId, async (db) => {
    const r = await db.query<{ title: string; content: string }>(
      `SELECT d.title, c.content
         FROM kb_chunks c JOIN kb_documents d ON d.tenant_id = c.tenant_id AND d.id = c.document_id
        WHERE c.tenant_id = $1 AND c.embedding_model = $2
        ORDER BY c.embedding <=> $3::vector, c.id
        LIMIT $4`,
      [tenantId, embedder.model, toVectorLiteral(vec), Math.min(Math.max(k, 1), 10)],
    );
    return r.rows;
  });
  const out: Snippet[] = [];
  let total = 0;
  for (const r of rows) {
    const content = r.content.slice(0, MAX_SNIPPET_CHARS);
    if (total + content.length > MAX_TOTAL_CHARS) break;
    total += content.length;
    out.push({ title: r.title, content });
  }
  return out;
}
