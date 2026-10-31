-- Paso 39: difusiones (promociones por WhatsApp con plantilla aprobada).
-- Solo van a clientes con permiso registrado (contacts.promo_consent_at), sin baja y sin atención personal en curso.

CREATE TABLE broadcasts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 80),
  template_name text NOT NULL CHECK (template_name ~ '^[a-z0-9_]{1,100}$'),
  template_language text NOT NULL CHECK (template_language ~ '^[a-z]{2,3}(_[A-Z]{2})?$'),
  -- Copia del texto de la plantilla al crear la difusión (lo que recibirá el cliente, con {{1}}, {{2}}…).
  template_text text NOT NULL CHECK (char_length(template_text) BETWEEN 1 AND 1024),
  -- Una entrada por variable: {"kind":"nombre"} (primer nombre del cliente) o {"kind":"texto","value":"…"}.
  params jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(params) = 'array' AND jsonb_array_length(params) <= 10),
  -- Filtros: {"tag":"vip","label":"cliente","from":{"broadcastId":"…","who":"no_leyeron"|"no_respondieron"}}.
  audience jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(audience) = 'object'),
  status text NOT NULL DEFAULT 'borrador' CHECK (status IN ('borrador', 'enviando', 'pausada', 'terminada', 'cancelada')),
  pause_reason text CHECK (char_length(pause_reason) <= 300),
  total integer NOT NULL DEFAULT 0 CHECK (total >= 0),
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  finished_at timestamptz,
  UNIQUE (tenant_id, id)
);
CREATE INDEX broadcasts_negocio_idx ON broadcasts (tenant_id, created_at DESC);
ALTER TABLE broadcasts ENABLE ROW LEVEL SECURITY;
ALTER TABLE broadcasts FORCE ROW LEVEL SECURITY;
CREATE POLICY broadcasts_aislamiento ON broadcasts
  USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());

-- Lo que se envía no cambia una vez que sale del borrador.
CREATE FUNCTION broadcasts_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status <> 'borrador' AND (NEW.name IS DISTINCT FROM OLD.name OR NEW.template_name IS DISTINCT FROM OLD.template_name
     OR NEW.template_language IS DISTINCT FROM OLD.template_language OR NEW.template_text IS DISTINCT FROM OLD.template_text
     OR NEW.params IS DISTINCT FROM OLD.params OR NEW.audience IS DISTINCT FROM OLD.audience) THEN
    RAISE EXCEPTION 'una difusión que ya empezó no se puede modificar' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER broadcasts_immutable_trg BEFORE UPDATE ON broadcasts FOR EACH ROW EXECUTE FUNCTION broadcasts_immutable();

CREATE TABLE broadcast_recipients (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  broadcast_id uuid NOT NULL,
  contact_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'pendiente' CHECK (status IN ('pendiente', 'enviado', 'fallido', 'omitido')),
  reason text CHECK (char_length(reason) <= 300),
  attempts smallint NOT NULL DEFAULT 0,
  next_at timestamptz NOT NULL DEFAULT now(),
  message_id uuid,
  sent_at timestamptz,
  UNIQUE (tenant_id, broadcast_id, contact_id),
  FOREIGN KEY (tenant_id, broadcast_id) REFERENCES broadcasts (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, contact_id) REFERENCES contacts (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, message_id) REFERENCES messages (tenant_id, id) ON DELETE SET NULL (message_id)
);
CREATE INDEX broadcast_recipients_cola_idx ON broadcast_recipients (tenant_id, broadcast_id, status, next_at);
CREATE INDEX broadcast_recipients_contacto_idx ON broadcast_recipients (tenant_id, contact_id, sent_at DESC);
ALTER TABLE broadcast_recipients ENABLE ROW LEVEL SECURITY;
ALTER TABLE broadcast_recipients FORCE ROW LEVEL SECURITY;
CREATE POLICY broadcast_recipients_aislamiento ON broadcast_recipients
  USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());

-- Índice global (sin RLS) de las difusiones que están enviando, para que el worker sepa a qué negocios visitar.
CREATE TABLE broadcast_index (
  broadcast_id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  last_tick_at timestamptz
);
REVOKE ALL ON broadcast_index FROM PUBLIC, app_user;

CREATE FUNCTION broadcasts_index_sync() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF NEW.status = 'enviando' THEN
    INSERT INTO broadcast_index (broadcast_id, tenant_id) VALUES (NEW.id, NEW.tenant_id) ON CONFLICT (broadcast_id) DO NOTHING;
  ELSE
    DELETE FROM broadcast_index WHERE broadcast_id = NEW.id;
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER broadcasts_index_sync_trg AFTER INSERT OR UPDATE OF status ON broadcasts FOR EACH ROW EXECUTE FUNCTION broadcasts_index_sync();

CREATE FUNCTION broadcast_claim(p_limit integer, p_every_seconds integer) RETURNS TABLE (out_tenant_id uuid, out_broadcast_id uuid)
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  UPDATE broadcast_index i SET last_tick_at = now()
   WHERE i.broadcast_id IN (
     SELECT k.broadcast_id FROM broadcast_index k
      WHERE k.last_tick_at IS NULL OR k.last_tick_at < now() - make_interval(secs => GREATEST(COALESCE(p_every_seconds, 10), 2))
      ORDER BY k.last_tick_at NULLS FIRST
      FOR UPDATE SKIP LOCKED
      LIMIT LEAST(GREATEST(COALESCE(p_limit, 1), 1), 20))
  RETURNING i.tenant_id, i.broadcast_id;
$$;
REVOKE ALL ON FUNCTION broadcast_claim(integer, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION broadcast_claim(integer, integer) TO app_user;
