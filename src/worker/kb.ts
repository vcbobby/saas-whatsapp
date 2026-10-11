import { getPool, withTenant } from "@/lib/db";
import { chunkText } from "@/lib/kb/chunk";
import { getEmbedder, toVectorLiteral, type Embedder } from "@/lib/kb/embeddings";

const STALE_SECONDS = 180; // si un worker muere a mitad de un documento, otro lo retoma pasado este tiempo
const MAX_ATTEMPTS = 3;

export type IndexOutcome = "idle" | "indexed" | "skipped_changed" | "skipped_gone" | "failed" | "retry";

/**
 * Indexa UN documento pendiente: lo parte en fragmentos, calcula sus vectores y reemplaza los anteriores
 * de forma atómica. Seguro con varios workers (kb_claim usa SKIP LOCKED) y con ediciones a mitad de camino
 * (la versión del documento debe seguir igual al guardar; si cambió, el nuevo trabajo ya está en cola).
 * En los registros solo van ids, nunca el contenido.
 */
export async function indexNextDocument(deps: { embedder?: Embedder } = {}): Promise<IndexOutcome> {
  const claimed = await getPool().query<{ out_tenant_id: string; out_document_id: string; out_ticket: string; out_attempts: number }>(
    "SELECT out_tenant_id, out_document_id, out_ticket, out_attempts FROM kb_claim($1)",
    [STALE_SECONDS],
  );
  const job = claimed.rows[0];
  if (!job) return "idle";
  const tenantId = job.out_tenant_id;
  const docId = job.out_document_id;
  const ticket = job.out_ticket;

  const finish = () => withTenant(tenantId, (db) => db.query("SELECT kb_finish($1, $2)", [docId, ticket]));
  const doc = await withTenant(tenantId, async (db) => {
    const r = await db.query<{ title: string; content: string; version: number }>("SELECT title, content, version FROM kb_documents WHERE tenant_id = $1 AND id = $2", [tenantId, docId]);
    return r.rows[0];
  });
  if (!doc) {
    await finish();
    return "skipped_gone";
  }

  const markFailed = async (message: string) => {
    await withTenant(tenantId, (db) =>
      db.query("UPDATE kb_documents SET status = 'failed', error = $4 WHERE tenant_id = $1 AND id = $2 AND version = $3", [tenantId, docId, doc.version, message.slice(0, 300)]),
    );
    await finish();
  };

  if (job.out_attempts > MAX_ATTEMPTS) {
    await markFailed("El indexado se interrumpió varias veces. Vuelve a guardar el documento.");
    console.error(`[kb] documento ${docId} (negocio ${tenantId.slice(0, 8)}…) → abandonado tras ${MAX_ATTEMPTS} intentos`);
    return "failed";
  }

  try {
    await withTenant(tenantId, (db) =>
      db.query("UPDATE kb_documents SET status = 'indexing', error = NULL WHERE tenant_id = $1 AND id = $2 AND version = $3 AND status <> 'indexing'", [tenantId, docId, doc.version]),
    );
    const chunks = chunkText(doc.content);
    if (chunks.length === 0) throw new Error("El documento no tiene texto");
    const embedder = deps.embedder ?? getEmbedder();
    // El título va delante: ayuda a encontrar el fragmento correcto aunque el texto no repita el tema.
    const vectors = await embedder.embed(chunks.map((c) => `${doc.title}: ${c}`), "passage");
    if (vectors.length !== chunks.length) throw new Error("Cantidad de vectores inesperada");

    const saved = await withTenant(tenantId, async (db) => {
      const cur = await db.query<{ version: number }>("SELECT version FROM kb_documents WHERE tenant_id = $1 AND id = $2 FOR UPDATE", [tenantId, docId]);
      if (!cur.rows[0] || cur.rows[0].version !== doc.version) return false; // se editó o borró mientras trabajábamos
      await db.query("DELETE FROM kb_chunks WHERE tenant_id = $1 AND document_id = $2", [tenantId, docId]);
      await db.query(
        `INSERT INTO kb_chunks (tenant_id, document_id, position, content, embedding, embedding_model)
         SELECT $1, $2, t.p, t.c, t.e::vector, $3 FROM unnest($4::int[], $5::text[], $6::text[]) AS t(p, c, e)`,
        [tenantId, docId, embedder.model, chunks.map((_, i) => i), chunks, vectors.map(toVectorLiteral)],
      );
      await db.query(
        "UPDATE kb_documents SET status = 'ready', error = NULL, chunk_count = $3, indexed_at = now() WHERE tenant_id = $1 AND id = $2",
        [tenantId, docId, chunks.length],
      );
      return true;
    });
    if (!saved) return "skipped_changed"; // el ticket nuevo sigue en cola: no se llama a finish
    await finish();
    console.log(`[kb] documento ${docId} (negocio ${tenantId.slice(0, 8)}…) → ${chunks.length} fragmentos`);
    return "indexed";
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[kb] documento ${docId} falló (intento ${job.out_attempts}/${MAX_ATTEMPTS}): ${msg}`);
    if (job.out_attempts >= MAX_ATTEMPTS) {
      await markFailed(`No se pudo indexar: ${msg}`);
      return "failed";
    }
    // Se reintenta solo, cuando venza el plazo de la reserva (kb_claim).
    await withTenant(tenantId, (db) =>
      db.query("UPDATE kb_documents SET error = $4 WHERE tenant_id = $1 AND id = $2 AND version = $3", [tenantId, docId, doc.version, `Reintentando: ${msg}`.slice(0, 300)]),
    );
    return "retry";
  }
}

/** Procesa todo lo pendiente (de a uno) y devuelve cuántos documentos se tocaron. */
export async function indexPending(deps: { embedder?: Embedder } = {}, max = 20): Promise<number> {
  let n = 0;
  while (n < max) {
    const r = await indexNextDocument(deps);
    if (r === "idle") break;
    n++;
    if (r === "retry") break; // no insistir en el mismo documento en el mismo ciclo
  }
  return n;
}
