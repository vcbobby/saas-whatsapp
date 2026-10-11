-- Paso 9C: base de conocimiento por negocio (documentos → fragmentos → vectores).
-- Requiere la extensión pgvector. Crearla necesita un superusuario, por eso NO la crea esta migración:
--   en una base nueva la crea db/init/02-extensiones.sh; en una existente: npm run db:extensions
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'vector') THEN
    RAISE EXCEPTION 'Falta la extensión pgvector. Ejecuta primero: npm run db:extensions';
  END IF;
END
$$;

CREATE TABLE kb_documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  title text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 120),
  content text NOT NULL CHECK (char_length(content) BETWEEN 1 AND 50000),
  -- Sube en cada edición: el indexador descarta el trabajo si el documento cambió mientras trabajaba.
  version integer NOT NULL DEFAULT 1,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'indexing', 'ready', 'failed')),
  error text CHECK (char_length(error) <= 300),
  chunk_count integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  indexed_at timestamptz,
  UNIQUE (tenant_id, id)
);
CREATE INDEX kb_documents_tenant_idx ON kb_documents (tenant_id, created_at DESC);

CREATE TABLE kb_chunks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  document_id uuid NOT NULL,
  position integer NOT NULL,
  content text NOT NULL CHECK (char_length(content) BETWEEN 1 AND 2000),
  embedding vector(384) NOT NULL,
  -- Con qué modelo se calculó: nunca se comparan vectores de modelos distintos.
  embedding_model text NOT NULL CHECK (char_length(embedding_model) <= 100),
  FOREIGN KEY (tenant_id, document_id) REFERENCES kb_documents (tenant_id, id) ON DELETE CASCADE,
  UNIQUE (document_id, position)
);
-- Búsqueda exacta por negocio (rápida con miles de fragmentos por negocio). Un índice vectorial global
-- (HNSW) filtrado por negocio puede devolver menos resultados de los pedidos; se revisa si algún negocio
-- pasa de ~50 000 fragmentos.
CREATE INDEX kb_chunks_tenant_idx ON kb_chunks (tenant_id, embedding_model);

ALTER TABLE kb_documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE kb_documents FORCE ROW LEVEL SECURITY;
CREATE POLICY kb_documents_aislamiento ON kb_documents
  USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());
ALTER TABLE kb_chunks ENABLE ROW LEVEL SECURITY;
ALTER TABLE kb_chunks FORCE ROW LEVEL SECURITY;
CREATE POLICY kb_chunks_aislamiento ON kb_chunks
  USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());

-- Tope por negocio: 50 documentos. El candado evita que dos altas simultáneas se pasen del tope.
CREATE FUNCTION kb_documents_limite() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('kb:' || NEW.tenant_id::text));
  IF (SELECT count(*) FROM kb_documents WHERE tenant_id = NEW.tenant_id) >= 50 THEN
    RAISE EXCEPTION 'kb_limite' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER kb_documents_limite BEFORE INSERT ON kb_documents
  FOR EACH ROW EXECUTE FUNCTION kb_documents_limite();

-- ------------------------------------------------------------------ cola de indexado
-- Postgres es la fuente de verdad (igual que con los mensajes). Solo guarda ids; nadie de la aplicación
-- escribe aquí directamente: la llena un disparador y la consume el worker con kb_claim/kb_finish.
CREATE SEQUENCE kb_queue_ticket_seq;
CREATE TABLE kb_queue (
  document_id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  ticket bigint NOT NULL,
  enqueued_at timestamptz NOT NULL DEFAULT now(),
  claimed_at timestamptz,
  attempts integer NOT NULL DEFAULT 0,
  FOREIGN KEY (tenant_id, document_id) REFERENCES kb_documents (tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX kb_queue_pendientes_idx ON kb_queue (enqueued_at);
REVOKE ALL ON kb_queue FROM PUBLIC, app_user;
REVOKE ALL ON SEQUENCE kb_queue_ticket_seq FROM PUBLIC, app_user;

CREATE FUNCTION kb_enqueue_trg() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  INSERT INTO kb_queue (document_id, tenant_id, ticket, enqueued_at, claimed_at, attempts)
  VALUES (NEW.id, NEW.tenant_id, nextval('kb_queue_ticket_seq'), now(), NULL, 0)
  ON CONFLICT (document_id) DO UPDATE
    SET ticket = EXCLUDED.ticket, enqueued_at = now(), claimed_at = NULL, attempts = 0;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION kb_enqueue_trg() FROM PUBLIC;
CREATE TRIGGER kb_documents_encolar AFTER INSERT OR UPDATE OF status ON kb_documents
  FOR EACH ROW WHEN (NEW.status = 'pending') EXECUTE FUNCTION kb_enqueue_trg();

-- Toma el siguiente documento (o uno cuyo trabajador murió hace más de p_stale_seconds). Devuelve solo ids.
CREATE FUNCTION kb_claim(p_stale_seconds integer)
RETURNS TABLE (out_tenant_id uuid, out_document_id uuid, out_ticket bigint, out_attempts integer)
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  UPDATE kb_queue q SET claimed_at = now(), attempts = q.attempts + 1
   WHERE q.document_id = (
     SELECT k.document_id FROM kb_queue k
      WHERE k.claimed_at IS NULL OR k.claimed_at < now() - make_interval(secs => GREATEST(COALESCE(p_stale_seconds, 180), 30))
      ORDER BY k.enqueued_at
      FOR UPDATE SKIP LOCKED
      LIMIT 1)
  RETURNING q.tenant_id, q.document_id, q.ticket, q.attempts;
$$;
REVOKE ALL ON FUNCTION kb_claim(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION kb_claim(integer) TO app_user;

-- Termina el trabajo SOLO si nadie volvió a encolar el documento mientras tanto (mismo ticket) y es de este negocio.
CREATE FUNCTION kb_finish(p_document uuid, p_ticket bigint) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  DELETE FROM kb_queue WHERE document_id = p_document AND ticket = p_ticket AND tenant_id = app_current_tenant();
$$;
REVOKE ALL ON FUNCTION kb_finish(uuid, bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION kb_finish(uuid, bigint) TO app_user;
