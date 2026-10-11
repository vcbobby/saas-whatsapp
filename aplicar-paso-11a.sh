#!/usr/bin/env bash
# Paso 11A: Centro de trabajo (tareas, pantalla «Hoy», bandeja de «Conversaciones», contactos «personales»).
# Ejecútalo desde la raíz del proyecto:  bash aplicar-paso-11a.sh
set -euo pipefail

[ -f package.json ] && grep -q '"name": "saas-whatsapp"' package.json || { echo "✖ Ejecuta esto dentro de ~/proyectos/saas-whatsapp"; exit 1; }
[ -f src/proxy.ts ] || { echo "✖ Falta el Paso 10. ¿Fusionaste su PR y hiciste git pull en main?"; exit 1; }
[ -f src/lib/kb/search.ts ] || { echo "✖ Falta el Paso 9C"; exit 1; }

if [ "$(git rev-parse --abbrev-ref HEAD 2>/dev/null)" = "main" ]; then
  git checkout -b paso-11a 2>/dev/null || git checkout paso-11a
  echo "✔ Rama paso-11a lista"
fi

BK=".paso11a-backup"
mkdir -p "$BK"
backup() { if [ -f "$1" ]; then mkdir -p "$BK/$(dirname "$1")"; cp "$1" "$BK/$1"; fi; }
grep -q "^.paso11a-backup" .gitignore 2>/dev/null || printf "\n.paso11a-backup/\n" >> .gitignore
backup db/migrations/0010_centro_trabajo.sql
backup src/lib/work/labels.ts
backup src/lib/work/time.ts
backup src/app/api/work/route.ts
backup src/app/api/work/update/route.ts
backup src/app/api/conversations/route.ts
backup src/app/api/conversations/messages/route.ts
backup src/app/api/conversations/update/route.ts
backup src/components/WorkQueue.tsx
backup src/components/Inbox.tsx
backup src/app/hoy/page.tsx
backup src/app/conversaciones/page.tsx
backup src/lib/agent/run.ts
backup src/components/AppHeader.tsx
backup src/app/panel/page.tsx
backup src/app/admin/page.tsx
backup src/app/seguridad/page.tsx
backup tests/work.test.ts
backup tests/work-time.test.ts

mkdir -p db/migrations
cat > db/migrations/0010_centro_trabajo.sql <<'EOF_DB_MIGRATIONS_0010_CENTRO_TRABAJO_SQL'
-- Paso 11A: Centro de trabajo. Convierte las conversaciones en cosas por hacer (tareas),
-- con un registro de qué pasó con cada una, y permite clasificar a los contactos.

-- ------------------------------------------------------------ etiqueta de contacto
-- "personal": el asistente NO responde a ese contacto (familia, amistades, proveedores…).
ALTER TABLE contacts
  ADD COLUMN label text NOT NULL DEFAULT 'sin_clasificar'
    CHECK (label IN ('sin_clasificar', 'cliente', 'prospecto', 'personal'));

-- Para la bandeja: conversaciones de un negocio, las más recientes primero.
CREATE INDEX conversations_recientes_idx ON conversations (tenant_id, last_message_at DESC NULLS LAST);

-- ---------------------------------------------------------------------- tareas
CREATE TABLE work_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  type text NOT NULL CHECK (type IN ('atencion_humana', 'cita', 'pedido', 'pago_por_verificar', 'seguimiento', 'tarea')),
  status text NOT NULL DEFAULT 'abierto' CHECK (status IN ('abierto', 'en_proceso', 'resuelto', 'descartado')),
  priority smallint NOT NULL DEFAULT 2 CHECK (priority BETWEEN 1 AND 3), -- 1 alta, 2 normal, 3 baja
  title text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 200),
  detail text CHECK (char_length(detail) <= 2000),
  due_at timestamptz,
  conversation_id uuid,
  contact_id uuid,
  source text NOT NULL CHECK (source IN ('agente', 'sistema', 'manual')),
  -- Para que los módulos futuros (citas, pedidos…) no creen la misma tarea dos veces.
  dedupe_key text CHECK (char_length(dedupe_key) <= 200),
  assigned_to uuid,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  resolved_by uuid,
  UNIQUE (tenant_id, id),
  -- Llaves compuestas: una tarea no puede apuntar a una conversación o contacto de OTRO negocio.
  FOREIGN KEY (tenant_id, conversation_id) REFERENCES conversations (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, contact_id) REFERENCES contacts (tenant_id, id) ON DELETE CASCADE,
  CHECK ((status IN ('resuelto', 'descartado')) = (resolved_at IS NOT NULL))
);

-- Una sola tarea "atención personal" abierta por conversación (los reintentos no la duplican).
CREATE UNIQUE INDEX work_items_atencion_unica_idx
  ON work_items (tenant_id, conversation_id)
  WHERE type = 'atencion_humana' AND status IN ('abierto', 'en_proceso');
CREATE UNIQUE INDEX work_items_dedupe_idx ON work_items (tenant_id, dedupe_key) WHERE dedupe_key IS NOT NULL;
-- La cola "Hoy": lo abierto, ordenado por urgencia.
CREATE INDEX work_items_cola_idx ON work_items (tenant_id, priority, due_at NULLS LAST, created_at)
  WHERE status IN ('abierto', 'en_proceso');
CREATE INDEX work_items_conv_idx ON work_items (tenant_id, conversation_id);

ALTER TABLE work_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE work_items FORCE ROW LEVEL SECURITY;
CREATE POLICY work_items_aislamiento ON work_items
  USING (tenant_id = app_current_tenant())
  WITH CHECK (tenant_id = app_current_tenant());

-- ---------------------------------------------------------- historial de cada tarea
CREATE TABLE work_item_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  work_item_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('creado', 'estado', 'asignado')),
  from_status text,
  to_status text,
  actor_user_id uuid, -- NULL = el sistema o el asistente
  -- clock_timestamp(): dos eventos de una misma transacción (estado + responsable) deben quedar en orden.
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (tenant_id, work_item_id) REFERENCES work_items (tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX work_item_events_item_idx ON work_item_events (tenant_id, work_item_id, created_at);
ALTER TABLE work_item_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE work_item_events FORCE ROW LEVEL SECURITY;
CREATE POLICY work_item_events_aislamiento ON work_item_events
  USING (tenant_id = app_current_tenant())
  WITH CHECK (tenant_id = app_current_tenant());
REVOKE UPDATE, DELETE ON work_item_events FROM app_user; -- solo se agregan registros

-- ------------------------------------------------------ triggers de las tareas
-- Quién hizo el cambio: la API fija app.actor (id de usuario) dentro de su transacción; vacío = sistema.
CREATE FUNCTION work_actor() RETURNS uuid
LANGUAGE sql STABLE
AS $$ SELECT NULLIF(current_setting('app.actor', true), '')::uuid $$;

CREATE FUNCTION work_items_before_update() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END
$$;
CREATE TRIGGER work_items_before_update BEFORE UPDATE ON work_items
  FOR EACH ROW EXECUTE FUNCTION work_items_before_update();

-- Cada creación y cada cambio de estado o de responsable queda en el historial, pase por donde pase.
CREATE FUNCTION work_items_log() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO work_item_events (tenant_id, work_item_id, kind, to_status, actor_user_id)
      VALUES (NEW.tenant_id, NEW.id, 'creado', NEW.status, COALESCE(work_actor(), NEW.created_by));
    RETURN NEW;
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    INSERT INTO work_item_events (tenant_id, work_item_id, kind, from_status, to_status, actor_user_id)
      VALUES (NEW.tenant_id, NEW.id, 'estado', OLD.status, NEW.status, work_actor());
  END IF;
  IF NEW.assigned_to IS DISTINCT FROM OLD.assigned_to THEN
    INSERT INTO work_item_events (tenant_id, work_item_id, kind, actor_user_id)
      VALUES (NEW.tenant_id, NEW.id, 'asignado', work_actor());
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER work_items_log_ins AFTER INSERT ON work_items FOR EACH ROW EXECUTE FUNCTION work_items_log();
CREATE TRIGGER work_items_log_upd AFTER UPDATE ON work_items FOR EACH ROW EXECUTE FUNCTION work_items_log();

-- ------------------------------------------- conversación ⇄ tarea de atención personal
-- Cuando el asistente pasa la conversación a una persona se crea la tarea (alta prioridad);
-- cuando la conversación vuelve al asistente o se cierra, esa tarea se resuelve sola.
-- Si alguien "toma" la conversación a propósito (handoff_reason = tomada_por_persona) no hace falta avisarle a sí mismo.
CREATE FUNCTION conversations_work_sync() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_name text;
  v_reason text;
BEGIN
  IF NEW.status = 'human' AND OLD.status = 'bot' AND COALESCE(NEW.handoff_reason, '') <> 'tomada_por_persona' THEN
    SELECT COALESCE(NULLIF(display_name, ''), '+' || wa_id) INTO v_name
      FROM contacts WHERE tenant_id = NEW.tenant_id AND id = NEW.contact_id;
    v_reason := CASE NEW.handoff_reason
      WHEN 'pedido_de_persona' THEN 'El cliente pidió hablar con una persona.'
      WHEN 'limite_diario' THEN 'El asistente llegó a su límite diario de respuestas.'
      WHEN 'limite_contacto' THEN 'Este cliente escribió muchísimo en poco tiempo; el asistente se detuvo.'
      WHEN 'intentos_de_manipulacion' THEN 'El cliente intentó manipular al asistente; revisa el chat con cuidado.'
      WHEN 'envio_rechazado' THEN 'WhatsApp rechazó la respuesta del asistente.'
      WHEN 'envio_incierto' THEN 'No se pudo confirmar si la respuesta llegó al cliente.'
      WHEN 'agente_fallo' THEN 'El asistente tuvo un fallo y no pudo responder.'
      WHEN 'fuga_de_instrucciones' THEN 'El asistente iba a revelar sus instrucciones; se detuvo.'
      WHEN 'salida_bloqueada' THEN 'Se bloqueó una respuesta del asistente por seguridad.'
      WHEN 'respuesta_vacia' THEN 'El asistente no pudo generar una respuesta.'
      ELSE 'El asistente pasó esta conversación a una persona.'
    END;
    INSERT INTO work_items (tenant_id, type, priority, title, detail, conversation_id, contact_id, source)
      VALUES (NEW.tenant_id, 'atencion_humana', 1, 'Atender a ' || v_name, v_reason, NEW.id, NEW.contact_id, 'agente')
      ON CONFLICT (tenant_id, conversation_id) WHERE type = 'atencion_humana' AND status IN ('abierto', 'en_proceso')
      DO NOTHING;
  ELSIF (NEW.status = 'bot' AND OLD.status = 'human') OR (NEW.status = 'closed' AND OLD.status <> 'closed') THEN
    UPDATE work_items SET status = 'resuelto', resolved_at = now()
      WHERE tenant_id = NEW.tenant_id AND conversation_id = NEW.id
        AND type = 'atencion_humana' AND status IN ('abierto', 'en_proceso');
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER conversations_work_sync AFTER UPDATE OF status ON conversations
  FOR EACH ROW WHEN (OLD.status IS DISTINCT FROM NEW.status) EXECUTE FUNCTION conversations_work_sync();
EOF_DB_MIGRATIONS_0010_CENTRO_TRABAJO_SQL
echo "✔ db/migrations/0010_centro_trabajo.sql"
mkdir -p src/lib/work
cat > src/lib/work/labels.ts <<'EOF_SRC_LIB_WORK_LABELS_TS'
// Textos y valores compartidos entre el servidor y las pantallas (sin dependencias).

export const WORK_TYPES = ["atencion_humana", "cita", "pedido", "pago_por_verificar", "seguimiento", "tarea"] as const;
export type WorkType = (typeof WORK_TYPES)[number];
/** Tipos que una persona puede crear a mano (la "atención personal" la crea el sistema). */
export const MANUAL_WORK_TYPES = ["tarea", "seguimiento", "cita", "pedido", "pago_por_verificar"] as const;

export const WORK_TYPE_LABEL: Record<WorkType, string> = {
  atencion_humana: "Atención personal",
  cita: "Cita",
  pedido: "Pedido",
  pago_por_verificar: "Pago por verificar",
  seguimiento: "Seguimiento",
  tarea: "Tarea",
};

export const WORK_STATUS_LABEL: Record<string, string> = {
  abierto: "Pendiente",
  en_proceso: "En proceso",
  resuelto: "Resuelta",
  descartado: "Descartada",
};

export const PRIORITY_LABEL: Record<number, string> = { 1: "Alta", 2: "Normal", 3: "Baja" };

export const CONTACT_LABELS = ["sin_clasificar", "cliente", "prospecto", "personal"] as const;
export type ContactLabel = (typeof CONTACT_LABELS)[number];
export const CONTACT_LABEL_TEXT: Record<ContactLabel, string> = {
  sin_clasificar: "Sin clasificar",
  cliente: "Cliente",
  prospecto: "Prospecto",
  personal: "Personal (el asistente no responde)",
};

/** Nombre de cada tipo de mensaje que no es texto. */
export const MEDIA_LABEL: Record<string, string> = {
  image: "Imagen", audio: "Audio", video: "Video", document: "Documento", sticker: "Sticker",
  location: "Ubicación", contacts: "Contacto", reaction: "Reacción", button: "Botón", interactive: "Respuesta",
};

export const CONVERSATION_STATUS_LABEL: Record<string, string> = {
  bot: "Con el asistente",
  human: "Con una persona",
  closed: "Cerrada",
};
EOF_SRC_LIB_WORK_LABELS_TS
echo "✔ src/lib/work/labels.ts"
mkdir -p src/lib/work
cat > src/lib/work/time.ts <<'EOF_SRC_LIB_WORK_TIME_TS'
// Fechas legibles en español (sin dependencias; se usa en las pantallas).

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/** "ahora", "hace 5 min", "hace 3 h", "hace 2 días" o la fecha si pasó más de una semana. */
export function relativeTime(value: string | Date | null | undefined, now: number = Date.now()): string {
  if (!value) return "";
  const t = typeof value === "string" ? Date.parse(value) : value.getTime();
  if (Number.isNaN(t)) return "";
  const diff = now - t;
  if (diff < -MIN) return "en el futuro";
  if (diff < MIN) return "ahora";
  if (diff < HOUR) return `hace ${Math.floor(diff / MIN)} min`;
  if (diff < DAY) return `hace ${Math.floor(diff / HOUR)} h`;
  if (diff < 7 * DAY) {
    const d = Math.floor(diff / DAY);
    return d === 1 ? "hace 1 día" : `hace ${d} días`;
  }
  return new Intl.DateTimeFormat("es-VE", { day: "numeric", month: "short" }).format(t);
}

/** Fecha límite: "Venció hace 2 h" (atrasada) o "Vence hoy, 3:00 p. m." / "Vence el 5 oct, 10:00 a. m.". */
export function dueInfo(value: string | null | undefined, now: number = Date.now()): { text: string; overdue: boolean } | null {
  if (!value) return null;
  const t = Date.parse(value);
  if (Number.isNaN(t)) return null;
  if (t < now) return { text: `Venció ${relativeTime(value, now)}`, overdue: true };
  const time = new Intl.DateTimeFormat("es-VE", { hour: "numeric", minute: "2-digit" }).format(t);
  const sameDay = new Date(t).toDateString() === new Date(now).toDateString();
  if (sameDay) return { text: `Vence hoy, ${time}`, overdue: false };
  const date = new Intl.DateTimeFormat("es-VE", { day: "numeric", month: "short" }).format(t);
  return { text: `Vence el ${date}, ${time}`, overdue: false };
}

/** Hora de un mensaje: "3:05 p. m." hoy, o "5 oct, 3:05 p. m." otro día. */
export function messageTime(value: string, now: number = Date.now()): string {
  const t = Date.parse(value);
  if (Number.isNaN(t)) return "";
  const time = new Intl.DateTimeFormat("es-VE", { hour: "numeric", minute: "2-digit" }).format(t);
  if (new Date(t).toDateString() === new Date(now).toDateString()) return time;
  return `${new Intl.DateTimeFormat("es-VE", { day: "numeric", month: "short" }).format(t)}, ${time}`;
}
EOF_SRC_LIB_WORK_TIME_TS
echo "✔ src/lib/work/time.ts"
mkdir -p src/app/api/work
cat > src/app/api/work/route.ts <<'EOF_SRC_APP_API_WORK_ROUTE_TS'
import { z } from "zod";
import { requireTenant } from "@/lib/auth/guard";
import { checkOrigin, errorResponse, jsonResponse, readJson, route } from "@/lib/auth/http";
import { withTenant } from "@/lib/db";
import { MANUAL_WORK_TYPES } from "@/lib/work/labels";

const MAX_OPEN_MANUAL = 500;

const createSchema = z.object({
  type: z.enum(MANUAL_WORK_TYPES),
  title: z.string().trim().min(1, "Escribe un título").max(200, "Máximo 200 caracteres"),
  detail: z.string().trim().max(2000, "Máximo 2000 caracteres").optional(),
  priority: z.number().int().min(1).max(3).default(2),
  dueAt: z.iso.datetime({ offset: true }).optional(),
  conversationId: z.uuid().optional(),
});

/** Lista de tareas: lo pendiente (ordenado por urgencia) o lo ya resuelto. */
export const GET = route(async (req) => {
  const auth = await requireTenant(req, "conversations:read");
  if (!auth.ok) return auth.response;
  const { tenantId } = auth.ctx;
  const done = new URL(req.url).searchParams.get("scope") === "done";

  const data = await withTenant(tenantId, async (db) => {
    const items = await db.query(
      `SELECT w.id, w.type, w.status, w.priority, w.title, w.detail, w.due_at, w.conversation_id, w.source,
              w.assigned_to, w.created_at, w.updated_at, w.resolved_at,
              COALESCE(NULLIF(c.display_name, ''), '+' || c.wa_id) AS contact_name
         FROM work_items w
         LEFT JOIN contacts c ON c.tenant_id = w.tenant_id AND c.id = w.contact_id
        WHERE w.tenant_id = $1 AND ${done ? "w.status IN ('resuelto', 'descartado')" : "w.status IN ('abierto', 'en_proceso')"}
        ORDER BY ${done ? "w.resolved_at DESC" : "w.priority, w.due_at NULLS LAST, w.created_at"}
        LIMIT ${done ? 50 : 200}`,
      [tenantId],
    );
    const counts = await db.query(
      "SELECT type, count(*)::int AS n FROM work_items WHERE tenant_id = $1 AND status IN ('abierto', 'en_proceso') GROUP BY type",
      [tenantId],
    );
    return { items: items.rows, counts: Object.fromEntries(counts.rows.map((r) => [r.type, r.n])) };
  });

  return jsonResponse({
    me: auth.session.userId,
    counts: data.counts,
    items: data.items.map((w) => ({
      id: w.id,
      type: w.type,
      status: w.status,
      priority: w.priority,
      title: w.title,
      detail: w.detail,
      dueAt: w.due_at,
      conversationId: w.conversation_id,
      source: w.source,
      assignedToMe: w.assigned_to === auth.session.userId,
      assigned: !!w.assigned_to,
      contactName: w.contact_name,
      createdAt: w.created_at,
      resolvedAt: w.resolved_at,
    })),
  });
});

/** Crear una tarea a mano. */
export const POST = route(async (req) => {
  const blocked = checkOrigin(req);
  if (blocked) return blocked;
  const auth = await requireTenant(req, "conversations:reply");
  if (!auth.ok) return auth.response;
  const body = await readJson(req, createSchema);
  if (!body.ok) return body.response;
  const { tenantId } = auth.ctx;
  const d = body.data;

  const result = await withTenant(tenantId, async (db) => {
    await db.query("SELECT set_config('app.actor', $1, true)", [auth.session.userId]);
    const open = await db.query(
      "SELECT count(*)::int AS n FROM work_items WHERE tenant_id = $1 AND source = 'manual' AND status IN ('abierto', 'en_proceso')",
      [tenantId],
    );
    if (open.rows[0].n >= MAX_OPEN_MANUAL) return "limite" as const;

    let contactId: string | null = null;
    if (d.conversationId) {
      const c = await db.query("SELECT contact_id FROM conversations WHERE tenant_id = $1 AND id = $2", [tenantId, d.conversationId]);
      if (c.rowCount !== 1) return "sin_conversacion" as const;
      contactId = c.rows[0].contact_id;
    }
    const r = await db.query(
      `INSERT INTO work_items (tenant_id, type, priority, title, detail, due_at, conversation_id, contact_id, source, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'manual', $9) RETURNING id`,
      [tenantId, d.type, d.priority, d.title, d.detail || null, d.dueAt ?? null, d.conversationId ?? null, contactId, auth.session.userId],
    );
    return r.rows[0].id as string;
  });

  if (result === "limite") return errorResponse(409, "limite_tareas", `Tienes ${MAX_OPEN_MANUAL} tareas manuales pendientes. Resuelve algunas antes de crear más.`);
  if (result === "sin_conversacion") return errorResponse(404, "no_encontrado", "No encontrado.");
  return jsonResponse({ ok: true, id: result }, 201);
});
EOF_SRC_APP_API_WORK_ROUTE_TS
echo "✔ src/app/api/work/route.ts"
mkdir -p src/app/api/work/update
cat > src/app/api/work/update/route.ts <<'EOF_SRC_APP_API_WORK_UPDATE_ROUTE_TS'
import { z } from "zod";
import { requireTenant } from "@/lib/auth/guard";
import { checkOrigin, errorResponse, jsonResponse, readJson, route } from "@/lib/auth/http";
import { withTenant } from "@/lib/db";

const schema = z.object({
  id: z.uuid(),
  action: z.enum(["start", "resolve", "dismiss", "reopen", "take", "release"]),
});

const OPEN = ["abierto", "en_proceso"];

/** Cambios sobre una tarea: empezar, resolver, descartar, reabrir, tomarla o soltarla. */
export const POST = route(async (req) => {
  const blocked = checkOrigin(req);
  if (blocked) return blocked;
  const auth = await requireTenant(req, "conversations:reply");
  if (!auth.ok) return auth.response;
  const body = await readJson(req, schema);
  if (!body.ok) return body.response;
  const { tenantId } = auth.ctx;
  const { id, action } = body.data;
  const me = auth.session.userId;

  const outcome = await withTenant(tenantId, async (db) => {
    await db.query("SELECT set_config('app.actor', $1, true)", [me]);
    const cur = await db.query<{ status: string }>("SELECT status FROM work_items WHERE tenant_id = $1 AND id = $2 FOR UPDATE", [tenantId, id]);
    if (cur.rowCount !== 1) return "no_existe" as const;
    const status = cur.rows[0]!.status;
    const isOpen = OPEN.includes(status);

    switch (action) {
      case "start":
        if (status !== "abierto") return "transicion" as const;
        await db.query("UPDATE work_items SET status = 'en_proceso', assigned_to = COALESCE(assigned_to, $3) WHERE tenant_id = $1 AND id = $2", [tenantId, id, me]);
        return "ok" as const;
      case "resolve":
      case "dismiss":
        if (!isOpen) return "transicion" as const;
        await db.query(
          "UPDATE work_items SET status = $3, resolved_at = now(), resolved_by = $4 WHERE tenant_id = $1 AND id = $2",
          [tenantId, id, action === "resolve" ? "resuelto" : "descartado", me],
        );
        return "ok" as const;
      case "reopen":
        if (isOpen) return "transicion" as const;
        await db.query("UPDATE work_items SET status = 'abierto', resolved_at = NULL, resolved_by = NULL WHERE tenant_id = $1 AND id = $2", [tenantId, id]);
        return "ok" as const;
      case "take":
        if (!isOpen) return "transicion" as const;
        await db.query("UPDATE work_items SET assigned_to = $3 WHERE tenant_id = $1 AND id = $2", [tenantId, id, me]);
        return "ok" as const;
      case "release":
        if (!isOpen) return "transicion" as const;
        await db.query("UPDATE work_items SET assigned_to = NULL WHERE tenant_id = $1 AND id = $2", [tenantId, id]);
        return "ok" as const;
    }
  }).catch((err: { code?: string }) => {
    // Reabrir una "atención personal" cuando ya hay otra abierta para la misma conversación.
    if (err.code === "23505") return "duplicada" as const;
    throw err;
  });

  if (outcome === "no_existe") return errorResponse(404, "no_encontrado", "No encontrado.");
  if (outcome === "transicion") return errorResponse(409, "transicion_invalida", "Esa tarea ya cambió. Actualiza la lista.");
  if (outcome === "duplicada") return errorResponse(409, "tarea_duplicada", "Ya hay otra tarea abierta para esta conversación.");
  return jsonResponse({ ok: true });
});
EOF_SRC_APP_API_WORK_UPDATE_ROUTE_TS
echo "✔ src/app/api/work/update/route.ts"
mkdir -p src/app/api/conversations
cat > src/app/api/conversations/route.ts <<'EOF_SRC_APP_API_CONVERSATIONS_ROUTE_TS'
import { z } from "zod";
import { requireTenant } from "@/lib/auth/guard";
import { errorResponse, jsonResponse, route } from "@/lib/auth/http";
import { withTenant } from "@/lib/db";
import { CONTACT_LABELS, MEDIA_LABEL } from "@/lib/work/labels";

const PAGE = 40;

const querySchema = z.object({
  filter: z.enum(["activas", "persona", "asistente", "cerradas"]).default("activas"),
  label: z.enum(CONTACT_LABELS).optional(),
  before: z.iso.datetime({ offset: true }).optional(),
});

const FILTER_SQL = {
  activas: "c.status <> 'closed'",
  persona: "c.status = 'human'",
  asistente: "c.status = 'bot'",
  cerradas: "c.status = 'closed'",
} as const;

/** Bandeja: conversaciones del negocio, la más reciente primero. */
export const GET = route(async (req) => {
  const auth = await requireTenant(req, "conversations:read");
  if (!auth.ok) return auth.response;
  const sp = new URL(req.url).searchParams;
  const q = querySchema.safeParse({
    filter: sp.get("filter") ?? undefined,
    label: sp.get("label") ?? undefined,
    before: sp.get("before") ?? undefined,
  });
  if (!q.success) return errorResponse(400, "datos_invalidos", "Filtro inválido.");
  const { tenantId } = auth.ctx;
  const { filter, label, before } = q.data;

  const rows = await withTenant(tenantId, async (db) => {
    const params: unknown[] = [tenantId];
    let extra = "";
    if (label) {
      params.push(label);
      extra += ` AND ct.label = $${params.length}`;
    }
    if (before) {
      params.push(before);
      extra += ` AND c.last_message_at < $${params.length}`;
    }
    const r = await db.query(
      `SELECT c.id, c.status, c.handoff_reason, c.last_message_at, c.created_at,
              ct.id AS contact_id, ct.wa_id, ct.label,
              COALESCE(NULLIF(ct.display_name, ''), '+' || ct.wa_id) AS contact_name,
              lm.body AS last_body, lm.msg_type AS last_type, lm.direction AS last_direction,
              EXISTS (SELECT 1 FROM work_items w WHERE w.tenant_id = c.tenant_id AND w.conversation_id = c.id
                         AND w.type = 'atencion_humana' AND w.status IN ('abierto', 'en_proceso')) AS needs_attention
         FROM conversations c
         JOIN contacts ct ON ct.tenant_id = c.tenant_id AND ct.id = c.contact_id
         LEFT JOIN LATERAL (
           SELECT m.body, m.msg_type, m.direction FROM messages m
            WHERE m.tenant_id = c.tenant_id AND m.conversation_id = c.id
            ORDER BY m.received_at DESC, m.id DESC LIMIT 1
         ) lm ON true
        WHERE c.tenant_id = $1 AND ${FILTER_SQL[filter]}${extra}
        ORDER BY c.last_message_at DESC NULLS LAST, c.id
        LIMIT ${PAGE + 1}`,
      params,
    );
    return r.rows;
  });

  const page = rows.slice(0, PAGE);
  return jsonResponse({
    conversations: page.map((c) => ({
      id: c.id,
      status: c.status,
      handoffReason: c.handoff_reason,
      lastMessageAt: c.last_message_at,
      contact: { id: c.contact_id, name: c.contact_name, waId: c.wa_id, label: c.label },
      lastPreview: c.last_body ? String(c.last_body).slice(0, 140) : c.last_type && c.last_type !== "text" ? `[${MEDIA_LABEL[c.last_type as string] ?? c.last_type}]` : "",
      lastDirection: c.last_direction,
      needsAttention: c.needs_attention,
    })),
    nextBefore: rows.length > PAGE ? (page[page.length - 1]!.last_message_at as Date | null)?.toISOString() ?? null : null,
  });
});
EOF_SRC_APP_API_CONVERSATIONS_ROUTE_TS
echo "✔ src/app/api/conversations/route.ts"
mkdir -p src/app/api/conversations/messages
cat > src/app/api/conversations/messages/route.ts <<'EOF_SRC_APP_API_CONVERSATIONS_MESSAGES_ROUTE_TS'
import { z } from "zod";
import { requireTenant } from "@/lib/auth/guard";
import { errorResponse, jsonResponse, route } from "@/lib/auth/http";
import { withTenant } from "@/lib/db";

const MAX_MESSAGES = 100;

/** Una conversación con sus últimos mensajes y sus tareas abiertas. */
export const GET = route(async (req) => {
  const auth = await requireTenant(req, "conversations:read");
  if (!auth.ok) return auth.response;
  const id = z.uuid().safeParse(new URL(req.url).searchParams.get("id"));
  if (!id.success) return errorResponse(400, "datos_invalidos", "Conversación inválida.");
  const { tenantId } = auth.ctx;

  const data = await withTenant(tenantId, async (db) => {
    const c = await db.query(
      `SELECT c.id, c.status, c.handoff_reason, c.assigned_to, c.last_message_at,
              ct.id AS contact_id, ct.wa_id, ct.label, COALESCE(NULLIF(ct.display_name, ''), '+' || ct.wa_id) AS contact_name
         FROM conversations c JOIN contacts ct ON ct.tenant_id = c.tenant_id AND ct.id = c.contact_id
        WHERE c.tenant_id = $1 AND c.id = $2`,
      [tenantId, id.data],
    );
    if (c.rowCount !== 1) return null;
    const msgs = await db.query(
      `SELECT id, direction, msg_type, body, send_state, delivery_status, received_at FROM (
         SELECT * FROM messages WHERE tenant_id = $1 AND conversation_id = $2
          ORDER BY received_at DESC, id DESC LIMIT ${MAX_MESSAGES}
       ) t ORDER BY received_at, id`,
      [tenantId, id.data],
    );
    const work = await db.query(
      `SELECT id, type, status, priority, title, detail FROM work_items
        WHERE tenant_id = $1 AND conversation_id = $2 AND status IN ('abierto', 'en_proceso')
        ORDER BY priority, created_at`,
      [tenantId, id.data],
    );
    return { c: c.rows[0], msgs: msgs.rows, work: work.rows };
  });
  if (!data) return errorResponse(404, "no_encontrado", "No encontrado.");

  const { c } = data;
  return jsonResponse({
    conversation: {
      id: c.id,
      status: c.status,
      handoffReason: c.handoff_reason,
      assignedToMe: c.assigned_to === auth.session.userId,
      contact: { id: c.contact_id, name: c.contact_name, waId: c.wa_id, label: c.label },
    },
    messages: data.msgs.map((m) => ({
      id: m.id,
      direction: m.direction,
      type: m.msg_type,
      body: m.body,
      sendState: m.send_state,
      deliveryStatus: m.delivery_status,
      at: m.received_at,
    })),
    work: data.work,
  });
});
EOF_SRC_APP_API_CONVERSATIONS_MESSAGES_ROUTE_TS
echo "✔ src/app/api/conversations/messages/route.ts"
mkdir -p src/app/api/conversations/update
cat > src/app/api/conversations/update/route.ts <<'EOF_SRC_APP_API_CONVERSATIONS_UPDATE_ROUTE_TS'
import { z } from "zod";
import { requireTenant } from "@/lib/auth/guard";
import { checkOrigin, errorResponse, jsonResponse, readJson, route } from "@/lib/auth/http";
import { withTenant } from "@/lib/db";
import { CONTACT_LABELS } from "@/lib/work/labels";

const schema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("take"), id: z.uuid() }),
  z.object({ action: z.literal("release"), id: z.uuid() }),
  z.object({ action: z.literal("close"), id: z.uuid() }),
  z.object({ action: z.literal("label"), id: z.uuid(), label: z.enum(CONTACT_LABELS) }),
]);

/**
 * Tomar la conversación (el asistente deja de responder), devolverla al asistente, cerrarla,
 * o clasificar al contacto. La tarea de "atención personal" se crea y se cierra sola (trigger de la base).
 */
export const POST = route(async (req) => {
  const blocked = checkOrigin(req);
  if (blocked) return blocked;
  const auth = await requireTenant(req, "conversations:reply");
  if (!auth.ok) return auth.response;
  const body = await readJson(req, schema);
  if (!body.ok) return body.response;
  const { tenantId } = auth.ctx;
  const d = body.data;
  const me = auth.session.userId;

  const outcome = await withTenant(tenantId, async (db) => {
    await db.query("SELECT set_config('app.actor', $1, true)", [me]);
    const cur = await db.query<{ status: string; contact_id: string }>(
      "SELECT status, contact_id FROM conversations WHERE tenant_id = $1 AND id = $2 FOR UPDATE",
      [tenantId, d.id],
    );
    if (cur.rowCount !== 1) return "no_existe" as const;
    const { status, contact_id: contactId } = cur.rows[0]!;

    switch (d.action) {
      case "label":
        await db.query("UPDATE contacts SET label = $3 WHERE tenant_id = $1 AND id = $2", [tenantId, contactId, d.label]);
        return "ok" as const;
      case "take":
        if (status === "closed") return "cerrada" as const;
        // Desde "bot": pasa a una persona. Desde "human": solo queda asignada a quien la toma.
        await db.query(
          `UPDATE conversations SET status = 'human', assigned_to = $3,
                  handoff_reason = CASE WHEN status = 'bot' THEN 'tomada_por_persona' ELSE handoff_reason END
            WHERE tenant_id = $1 AND id = $2`,
          [tenantId, d.id, me],
        );
        return "ok" as const;
      case "release":
        if (status !== "human") return "estado" as const;
        await db.query("UPDATE conversations SET status = 'bot', assigned_to = NULL, handoff_reason = NULL WHERE tenant_id = $1 AND id = $2", [tenantId, d.id]);
        return "ok" as const;
      case "close":
        if (status === "closed") return "ok" as const;
        await db.query("UPDATE conversations SET status = 'closed' WHERE tenant_id = $1 AND id = $2", [tenantId, d.id]);
        return "ok" as const;
    }
  });

  if (outcome === "no_existe") return errorResponse(404, "no_encontrado", "No encontrado.");
  if (outcome === "cerrada") return errorResponse(409, "conversacion_cerrada", "La conversación está cerrada.");
  if (outcome === "estado") return errorResponse(409, "estado_invalido", "La conversación ya cambió. Actualiza la lista.");
  return jsonResponse({ ok: true });
});
EOF_SRC_APP_API_CONVERSATIONS_UPDATE_ROUTE_TS
echo "✔ src/app/api/conversations/update/route.ts"
mkdir -p src/components
cat > src/components/WorkQueue.tsx <<'EOF_SRC_COMPONENTS_WORKQUEUE_TSX'
"use client";

import Link from "next/link";
import { useCallback, useEffect, useId, useState, type FormEvent } from "react";
import { dueInfo, relativeTime } from "@/lib/work/time";
import { MANUAL_WORK_TYPES, PRIORITY_LABEL, WORK_STATUS_LABEL, WORK_TYPE_LABEL, WORK_TYPES, type WorkType } from "@/lib/work/labels";

interface Item {
  id: string;
  type: WorkType;
  status: "abierto" | "en_proceso" | "resuelto" | "descartado";
  priority: 1 | 2 | 3;
  title: string;
  detail: string | null;
  dueAt: string | null;
  conversationId: string | null;
  source: "agente" | "sistema" | "manual";
  assignedToMe: boolean;
  assigned: boolean;
  contactName: string | null;
  createdAt: string;
  resolvedAt: string | null;
}

type Action = "start" | "resolve" | "dismiss" | "reopen" | "take" | "release";
const REFRESH_MS = 15_000;
const chip = { background: "var(--color-pure-white)", color: "var(--color-ink)", border: "1px solid var(--color-field-border)" } as const;
const urgent = { background: "var(--color-signal-yellow)", color: "var(--color-ink)" } as const;

export function WorkQueue() {
  const uid = useId();
  const [scope, setScope] = useState<"open" | "done">("open");
  const [items, setItems] = useState<Item[] | null>(null);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [filter, setFilter] = useState<WorkType | "todo">("todo");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [formOpen, setFormOpen] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/work?scope=${scope}`, { cache: "no-store" });
      if (!res.ok) return;
      const d = (await res.json()) as { items: Item[]; counts: Record<string, number> };
      setItems(d.items);
      setCounts(d.counts);
      setNow(Date.now());
    } catch {
      /* sin conexión: se reintenta en el siguiente ciclo */
    }
  }, [scope]);

  useEffect(() => {
    const first = setTimeout(() => void load(), 0);
    const t = setInterval(() => void load(), REFRESH_MS);
    return () => {
      clearTimeout(first);
      clearInterval(t);
    };
  }, [load]);

  async function act(id: string, action: Action) {
    if (busy) return;
    setBusy(id);
    setError(null);
    try {
      const res = await fetch("/api/work/update", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id, action }) });
      if (!res.ok) {
        const d = (await res.json().catch(() => ({}))) as { message?: string };
        setError(d.message ?? "No se pudo completar la acción.");
      }
      await load();
    } catch {
      setError("No hay conexión con el servidor. Revisa tu internet e intenta de nuevo.");
    } finally {
      setBusy(null);
    }
  }

  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  const shown = (items ?? []).filter((i) => scope === "done" || filter === "todo" || i.type === filter);

  return (
    <div>
      <div className="flex flex-wrap items-center gap-3" role="tablist" aria-label="Qué mostrar">
        {(["open", "done"] as const).map((s) => (
          <button
            key={s}
            type="button"
            role="tab"
            aria-selected={scope === s}
            className={`btn btn-sm ${scope === s ? "btn-primary" : "btn-ghost-dark"}`}
            onClick={() => {
              setItems(null);
              setScope(s);
            }}
          >
            {s === "open" ? `Pendientes${scope === "open" || total ? ` (${total})` : ""}` : "Resueltas"}
          </button>
        ))}
        <button type="button" className="btn btn-sm btn-ghost-dark ml-auto" aria-expanded={formOpen} aria-controls={`${uid}-form`} onClick={() => setFormOpen((v) => !v)}>
          {formOpen ? "Cerrar formulario" : "Nueva tarea"}
        </button>
      </div>

      {formOpen && (
        <div id={`${uid}-form`} className="mt-6">
          <NewTask
            onCreated={() => {
              setFormOpen(false);
              setScope("open");
              void load();
            }}
          />
        </div>
      )}

      {scope === "open" && total > 0 && (
        <div className="mt-6 flex flex-wrap gap-2" role="group" aria-label="Filtrar por tipo">
          <button type="button" className={`btn btn-sm ${filter === "todo" ? "btn-primary" : "btn-ghost-dark"}`} aria-pressed={filter === "todo"} onClick={() => setFilter("todo")}>
            Todo ({total})
          </button>
          {WORK_TYPES.filter((t) => counts[t]).map((t) => (
            <button key={t} type="button" className={`btn btn-sm ${filter === t ? "btn-primary" : "btn-ghost-dark"}`} aria-pressed={filter === t} onClick={() => setFilter(t)}>
              {WORK_TYPE_LABEL[t]} ({counts[t]})
            </button>
          ))}
        </div>
      )}

      <div aria-live="assertive" role="alert" className="mt-4">
        {error && <p className="alert-error">{error}</p>}
      </div>

      {items === null ? (
        <p className="muted-dark mt-8" role="status">Cargando…</p>
      ) : shown.length === 0 ? (
        <section className="card-light mt-8" style={{ maxWidth: 640 }}>
          <p className="eyebrow">{scope === "open" ? "Todo al día" : "Sin historial"}</p>
          <h2 className="mt-3 text-[24px]">{scope === "open" ? "No tienes nada pendiente" : "Aún no hay tareas resueltas"}</h2>
          <p className="muted mt-3">
            {scope === "open"
              ? "Cuando el asistente pase una conversación a una persona, o crees una tarea, aparecerá aquí ordenada por urgencia."
              : "Las tareas que resuelvas o descartes se guardan aquí."}
          </p>
        </section>
      ) : (
        <ul className="mt-8 flex flex-col gap-4">
          {shown.map((i) => (
            <li key={i.id} className="card-light" style={{ padding: 24 }}>
              <div className="flex flex-wrap items-center gap-2">
                <span className="badge" style={chip}>{WORK_TYPE_LABEL[i.type]}</span>
                {i.priority === 1 && scope === "open" && <span className="badge" style={urgent}>Prioridad alta</span>}
                {i.priority === 3 && scope === "open" && <span className="badge" style={chip}>{PRIORITY_LABEL[3]}</span>}
                {i.status === "en_proceso" && <span className="badge" style={chip}>{WORK_STATUS_LABEL.en_proceso}{i.assignedToMe ? " · tú" : i.assigned ? " · otra persona" : ""}</span>}
                {scope === "done" && <span className="badge" style={chip}>{WORK_STATUS_LABEL[i.status]}</span>}
              </div>
              <h2 className="mt-3 text-[20px]">{i.title}</h2>
              {i.detail && <p className="muted mt-1 text-[15px]">{i.detail}</p>}
              <p className="muted mt-2 text-[14px]">
                {[i.contactName, scope === "done" ? `Resuelta ${relativeTime(i.resolvedAt, now)}` : relativeTime(i.createdAt, now)].filter(Boolean).join(" · ")}
                {scope === "open" && dueInfo(i.dueAt, now) && (
                  <>
                    {" · "}
                    <strong>{dueInfo(i.dueAt, now)!.text}</strong>
                  </>
                )}
              </p>
              <div className="mt-4 flex flex-wrap items-center gap-2">
                {i.conversationId && (
                  <Link href={`/conversaciones?c=${i.conversationId}`} className="btn btn-sm btn-ghost-light">
                    Abrir conversación
                  </Link>
                )}
                {scope === "open" ? (
                  <>
                    {i.status === "abierto" && <Btn disabled={busy === i.id} onClick={() => act(i.id, "start")}>Empezar</Btn>}
                    <Btn primary disabled={busy === i.id} onClick={() => act(i.id, "resolve")}>Resolver</Btn>
                    {!i.assignedToMe && <Btn disabled={busy === i.id} onClick={() => act(i.id, "take")}>Tomar</Btn>}
                    {i.assignedToMe && <Btn disabled={busy === i.id} onClick={() => act(i.id, "release")}>Soltar</Btn>}
                    <Btn disabled={busy === i.id} onClick={() => act(i.id, "dismiss")}>Descartar</Btn>
                  </>
                ) : (
                  <Btn disabled={busy === i.id} onClick={() => act(i.id, "reopen")}>Reabrir</Btn>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function Btn({ children, onClick, disabled, primary }: { children: React.ReactNode; onClick: () => void; disabled?: boolean; primary?: boolean }) {
  return (
    <button type="button" className={`btn btn-sm ${primary ? "btn-primary" : "btn-text"}`} style={primary ? undefined : { color: "var(--color-ink)", textDecoration: "underline" }} disabled={disabled} onClick={onClick}>
      {children}
    </button>
  );
}

function NewTask({ onCreated }: { onCreated: () => void }) {
  const uid = useId();
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (pending) return;
    const f = new FormData(e.currentTarget);
    const due = String(f.get("due") ?? "");
    const body: Record<string, unknown> = {
      type: String(f.get("type")),
      title: String(f.get("title") ?? ""),
      priority: Number(f.get("priority")),
    };
    const detail = String(f.get("detail") ?? "").trim();
    if (detail) body.detail = detail;
    if (due) body.dueAt = new Date(due).toISOString();
    setPending(true);
    setError(null);
    try {
      const res = await fetch("/api/work", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      if (res.ok) {
        onCreated();
        return;
      }
      const d = (await res.json().catch(() => ({}))) as { message?: string };
      setError(d.message ?? "No se pudo crear la tarea.");
    } catch {
      setError("No hay conexión con el servidor. Revisa tu internet e intenta de nuevo.");
    } finally {
      setPending(false);
    }
  }

  return (
    <form onSubmit={submit} className="card-light flex flex-col gap-5" style={{ padding: 24 }} aria-label="Nueva tarea">
      <div className="field">
        <label htmlFor={`${uid}-title`}>¿Qué hay que hacer?</label>
        <input id={`${uid}-title`} name="title" className="input" required maxLength={200} placeholder="Ej.: Confirmar el pago de María" />
      </div>
      <div className="field">
        <label htmlFor={`${uid}-detail`}>Detalles (opcional)</label>
        <textarea id={`${uid}-detail`} name="detail" className="input" rows={3} maxLength={2000} />
      </div>
      <div className="grid gap-5 sm:grid-cols-3">
        <div className="field">
          <label htmlFor={`${uid}-type`}>Tipo</label>
          <select id={`${uid}-type`} name="type" className="input" defaultValue="tarea">
            {MANUAL_WORK_TYPES.map((t) => (
              <option key={t} value={t}>{WORK_TYPE_LABEL[t]}</option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor={`${uid}-prio`}>Prioridad</label>
          <select id={`${uid}-prio`} name="priority" className="input" defaultValue="2">
            <option value="1">{PRIORITY_LABEL[1]}</option>
            <option value="2">{PRIORITY_LABEL[2]}</option>
            <option value="3">{PRIORITY_LABEL[3]}</option>
          </select>
        </div>
        <div className="field">
          <label htmlFor={`${uid}-due`}>Para cuándo (opcional)</label>
          <input id={`${uid}-due`} name="due" type="datetime-local" className="input" />
        </div>
      </div>
      <div role="alert" aria-live="assertive">{error && <p className="alert-error">{error}</p>}</div>
      <div>
        <button type="submit" className="btn btn-primary" disabled={pending}>{pending ? "Guardando…" : "Crear tarea"}</button>
      </div>
    </form>
  );
}
EOF_SRC_COMPONENTS_WORKQUEUE_TSX
echo "✔ src/components/WorkQueue.tsx"
mkdir -p src/components
cat > src/components/Inbox.tsx <<'EOF_SRC_COMPONENTS_INBOX_TSX'
"use client";

import Link from "next/link";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { CONTACT_LABELS, CONTACT_LABEL_TEXT, CONVERSATION_STATUS_LABEL, MEDIA_LABEL, WORK_TYPE_LABEL, type ContactLabel, type WorkType } from "@/lib/work/labels";
import { messageTime, relativeTime } from "@/lib/work/time";

type Status = "bot" | "human" | "closed";
interface ConvRow {
  id: string;
  status: Status;
  handoffReason: string | null;
  lastMessageAt: string | null;
  contact: { id: string; name: string; waId: string; label: ContactLabel };
  lastPreview: string;
  lastDirection: "in" | "out" | null;
  needsAttention: boolean;
}
interface Msg {
  id: string;
  direction: "in" | "out";
  type: string;
  body: string | null;
  sendState: string | null;
  deliveryStatus: string | null;
  at: string;
}
interface Detail {
  conversation: { id: string; status: Status; handoffReason: string | null; assignedToMe: boolean; contact: { id: string; name: string; waId: string; label: ContactLabel } };
  messages: Msg[];
  work: { id: string; type: WorkType; title: string }[];
}

const FILTERS = [
  { id: "activas", label: "Activas" },
  { id: "persona", label: "Con una persona" },
  { id: "asistente", label: "Con el asistente" },
  { id: "cerradas", label: "Cerradas" },
] as const;
type FilterId = (typeof FILTERS)[number]["id"];

const DELIVERY: Record<string, string> = { sent: "Enviado", delivered: "Entregado", read: "Leído", failed: "No se entregó" };
const chip = { background: "var(--color-pure-white)", color: "var(--color-ink)", border: "1px solid var(--color-field-border)" } as const;
const urgent = { background: "var(--color-signal-yellow)", color: "var(--color-ink)" } as const;
const LIST_MS = 10_000;
const DETAIL_MS = 5_000;

export function Inbox({ initialId }: { initialId: string | null }) {
  const uid = useId();
  const [filter, setFilter] = useState<FilterId>("activas");
  const [label, setLabel] = useState<ContactLabel | "">("");
  const [first, setFirst] = useState<ConvRow[] | null>(null);
  const [more, setMore] = useState<ConvRow[]>([]);
  const [next, setNext] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(initialId);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmClose, setConfirmClose] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const bottomRef = useRef<HTMLDivElement>(null);
  const lastCount = useRef(0);

  const qs = useCallback((before?: string) => {
    const p = new URLSearchParams({ filter });
    if (label) p.set("label", label);
    if (before) p.set("before", before);
    return p.toString();
  }, [filter, label]);

  const loadList = useCallback(async () => {
    try {
      const res = await fetch(`/api/conversations?${qs()}`, { cache: "no-store" });
      if (!res.ok) return;
      const d = (await res.json()) as { conversations: ConvRow[]; nextBefore: string | null };
      setFirst(d.conversations);
      setNext((cur) => (more.length ? cur : d.nextBefore));
      setNow(Date.now());
    } catch {
      /* se reintenta */
    }
  }, [qs, more.length]);

  useEffect(() => {
    const t0 = setTimeout(() => void loadList(), 0);
    const t = setInterval(() => void loadList(), LIST_MS);
    return () => {
      clearTimeout(t0);
      clearInterval(t);
    };
  }, [loadList]);

  async function loadMore() {
    if (!next) return;
    const res = await fetch(`/api/conversations?${qs(next)}`, { cache: "no-store" });
    if (!res.ok) return;
    const d = (await res.json()) as { conversations: ConvRow[]; nextBefore: string | null };
    setMore((m) => [...m, ...d.conversations]);
    setNext(d.nextBefore);
  }

  const loadDetail = useCallback(async (id: string) => {
    try {
      const res = await fetch(`/api/conversations/messages?id=${id}`, { cache: "no-store" });
      if (res.status === 404 || res.status === 400) {
        setNotFound(true);
        setDetail(null);
        return;
      }
      if (!res.ok) return;
      setNotFound(false);
      setDetail((await res.json()) as Detail);
    } catch {
      /* se reintenta */
    }
  }, []);

  useEffect(() => {
    if (!selected) return;
    const t0 = setTimeout(() => void loadDetail(selected), 0);
    const t = setInterval(() => void loadDetail(selected), DETAIL_MS);
    return () => {
      clearTimeout(t0);
      clearInterval(t);
    };
  }, [selected, loadDetail]);

  // Al llegar mensajes nuevos, baja al final.
  useEffect(() => {
    const n = detail?.messages.length ?? 0;
    if (n !== lastCount.current) {
      lastCount.current = n;
      bottomRef.current?.scrollIntoView({ block: "end" });
    }
  }, [detail]);

  function open(id: string) {
    setSelected(id);
    setDetail(null);
    setNotFound(false);
    setConfirmClose(false);
    setError(null);
    lastCount.current = 0;
    window.history.replaceState(null, "", `/conversaciones?c=${id}`);
  }
  function back() {
    setSelected(null);
    setDetail(null);
    setNotFound(false);
    window.history.replaceState(null, "", "/conversaciones");
  }

  async function act(body: Record<string, unknown>) {
    if (!selected || busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/conversations/update", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: selected, ...body }) });
      if (!res.ok) {
        const d = (await res.json().catch(() => ({}))) as { message?: string };
        setError(d.message ?? "No se pudo completar la acción.");
      }
      setConfirmClose(false);
      await Promise.all([loadDetail(selected), loadList()]);
    } catch {
      setError("No hay conexión con el servidor. Revisa tu internet e intenta de nuevo.");
    } finally {
      setBusy(false);
    }
  }

  const rows = [...(first ?? []), ...more.filter((m) => !(first ?? []).some((f) => f.id === m.id))];
  const c = detail?.conversation;

  return (
    <div className="grid gap-6 lg:grid-cols-[380px_1fr]">
      {/* ------------------------------------------------------------ lista */}
      <section className={selected ? "hidden lg:block" : ""} aria-label="Lista de conversaciones">
        <div className="flex flex-wrap gap-2" role="group" aria-label="Filtrar conversaciones">
          {FILTERS.map((f) => (
            <button key={f.id} type="button" aria-pressed={filter === f.id} className={`btn btn-sm ${filter === f.id ? "btn-primary" : "btn-ghost-dark"}`} onClick={() => { setFilter(f.id); setFirst(null); setMore([]); setNext(null); }}>
              {f.label}
            </button>
          ))}
        </div>
        <div className="field mt-4">
          <label htmlFor={`${uid}-lab`} className="muted-dark" style={{ color: "rgba(255,255,255,0.78)" }}>Tipo de contacto</label>
          <select id={`${uid}-lab`} className="input" value={label} onChange={(e) => { setLabel(e.target.value as ContactLabel | ""); setFirst(null); setMore([]); setNext(null); }}>
            <option value="">Todos</option>
            {CONTACT_LABELS.map((l) => (
              <option key={l} value={l}>{CONTACT_LABEL_TEXT[l].replace(" (el asistente no responde)", "")}</option>
            ))}
          </select>
        </div>

        {first === null ? (
          <p className="muted-dark mt-6" role="status">Cargando…</p>
        ) : rows.length === 0 ? (
          <div className="card-light mt-6" style={{ padding: 24 }}>
            <p className="muted">No hay conversaciones con este filtro.</p>
          </div>
        ) : (
          <ul className="mt-6 flex flex-col gap-3">
            {rows.map((r) => (
              <li key={r.id}>
                <button
                  type="button"
                  onClick={() => open(r.id)}
                  aria-current={selected === r.id ? "true" : undefined}
                  className="card-light w-full text-left"
                  style={{ padding: 16, borderRadius: 20, border: selected === r.id ? "2px solid var(--color-ink)" : "2px solid transparent", cursor: "pointer" }}
                >
                  <span className="flex items-baseline justify-between gap-3">
                    <strong className="truncate text-[16px]">{r.contact.name}</strong>
                    <span className="muted shrink-0 text-[13px]">{relativeTime(r.lastMessageAt, now)}</span>
                  </span>
                  <span className="muted mt-1 block truncate text-[14px]">
                    {r.lastDirection === "out" ? "Asistente: " : ""}
                    {r.lastPreview || "Sin mensajes"}
                  </span>
                  <span className="mt-2 flex flex-wrap gap-2">
                    {r.needsAttention && <span className="badge" style={urgent}>Necesita atención</span>}
                    {r.status !== "bot" && <span className="badge" style={chip}>{CONVERSATION_STATUS_LABEL[r.status]}</span>}
                    {r.contact.label !== "sin_clasificar" && <span className="badge" style={chip}>{CONTACT_LABEL_TEXT[r.contact.label].replace(" (el asistente no responde)", "")}</span>}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
        {next && (
          <button type="button" className="btn btn-sm btn-ghost-dark mt-4 w-full" onClick={() => void loadMore()}>
            Ver más antiguas
          </button>
        )}
      </section>

      {/* ---------------------------------------------------------- detalle */}
      <section className={selected ? "" : "hidden lg:block"} aria-label="Conversación">
        {!selected ? (
          <div className="card-light" style={{ padding: 32 }}>
            <p className="eyebrow">Conversaciones</p>
            <h2 className="mt-3 text-[24px]">Elige una conversación</h2>
            <p className="muted mt-3">Aquí verás todo lo que se habló, podrás tomarla para que el asistente deje de responder y clasificar a la persona.</p>
          </div>
        ) : notFound ? (
          <div className="card-light" style={{ padding: 32 }}>
            <h2 className="text-[24px]">No encontramos esa conversación</h2>
            <button type="button" className="btn btn-sm btn-ghost-light mt-4" onClick={back}>Volver a la lista</button>
          </div>
        ) : !c ? (
          <p className="muted-dark" role="status">Cargando…</p>
        ) : (
          <div className="card-light" style={{ padding: 24 }}>
            <div className="lg:hidden">
              <button type="button" className="btn btn-text btn-sm" style={{ color: "var(--color-ink)", textDecoration: "underline" }} onClick={back}>← Volver a la lista</button>
            </div>
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div>
                <h2 className="text-[24px]">{c.contact.name}</h2>
                <p className="muted mt-1 text-[14px]">+{c.contact.waId} · {CONVERSATION_STATUS_LABEL[c.status]}{c.status === "human" && c.assignedToMe ? " · la tienes tú" : ""}</p>
              </div>
              <div className="field" style={{ minWidth: 220 }}>
                <label htmlFor={`${uid}-tipo`}>Tipo de contacto</label>
                <select id={`${uid}-tipo`} className="input" value={c.contact.label} disabled={busy} onChange={(e) => void act({ action: "label", label: e.target.value })}>
                  {CONTACT_LABELS.map((l) => (
                    <option key={l} value={l}>{CONTACT_LABEL_TEXT[l]}</option>
                  ))}
                </select>
              </div>
            </div>

            {c.contact.label === "personal" && (
              <p className="alert-warn mt-4" role="note">Este contacto está marcado como personal: el asistente no le responde.</p>
            )}
            {detail!.work.length > 0 && (
              <p className="alert-warn mt-4" role="note">
                Pendiente: <strong>{detail!.work[0]!.title}</strong> ({WORK_TYPE_LABEL[detail!.work[0]!.type]}).{" "}
                <Link href="/hoy" className="link">Ver en Hoy</Link>
              </p>
            )}

            <div className="mt-5 flex flex-wrap items-center gap-2">
              {c.status !== "closed" && !(c.status === "human" && c.assignedToMe) && (
                <button type="button" className="btn btn-sm btn-primary" disabled={busy} onClick={() => void act({ action: "take" })}>
                  Tomar la conversación
                </button>
              )}
              {c.status === "human" && (
                <button type="button" className="btn btn-sm btn-ghost-light" disabled={busy} onClick={() => void act({ action: "release" })}>
                  Devolver al asistente
                </button>
              )}
              {c.status !== "closed" &&
                (confirmClose ? (
                  <>
                    <span className="text-[14px]">¿Cerrar la conversación?</span>
                    <button type="button" className="btn btn-sm btn-ghost-light" disabled={busy} onClick={() => void act({ action: "close" })}>Sí, cerrar</button>
                    <button type="button" className="btn btn-sm btn-text" style={{ color: "var(--color-ink)", textDecoration: "underline" }} onClick={() => setConfirmClose(false)}>Cancelar</button>
                  </>
                ) : (
                  <button type="button" className="btn btn-sm btn-text" style={{ color: "var(--color-ink)", textDecoration: "underline" }} disabled={busy} onClick={() => setConfirmClose(true)}>Cerrar</button>
                ))}
            </div>
            <div role="alert" aria-live="assertive">{error && <p className="alert-error mt-4">{error}</p>}</div>

            <div className="mt-6 flex max-h-[60vh] flex-col gap-3 overflow-y-auto rounded-[20px] p-4" style={{ background: "var(--color-pure-white)", border: "1px solid var(--color-fog-border)" }} role="log" aria-label="Mensajes" tabIndex={0}>
              {detail!.messages.length === 0 && <p className="muted text-[14px]">Todavía no hay mensajes.</p>}
              {detail!.messages.map((m) => {
                const out = m.direction === "out";
                const media = m.type !== "text" ? `[${MEDIA_LABEL[m.type] ?? m.type}]` : "";
                const status = out ? (m.sendState === "failed" ? "No se pudo enviar" : m.sendState === "unknown" ? "Envío incierto" : m.deliveryStatus ? DELIVERY[m.deliveryStatus] : "") : "";
                return (
                  <div key={m.id} className={`flex ${out ? "justify-end" : "justify-start"}`}>
                    <div
                      className="max-w-[85%] rounded-[18px] px-4 py-3"
                      style={{ background: out ? "var(--color-mint-whisper)" : "var(--color-mint-frost)", color: "var(--color-ink)", border: "1px solid var(--color-fog-border)" }}
                    >
                      {out && <p className="text-[12px] font-medium" style={{ color: "var(--color-ink-muted)" }}>Asistente</p>}
                      {media && <p className="text-[14px] font-medium">{media}</p>}
                      {m.body && <p className="text-[15px]" style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{m.body}</p>}
                      <p className="mt-1 text-[12px]" style={{ color: "var(--color-ink-muted)" }}>
                        {messageTime(m.at, now)}
                        {status && ` · ${status}`}
                      </p>
                    </div>
                  </div>
                );
              })}
              <div ref={bottomRef} />
            </div>
            {c.status !== "closed" && (
              <p className="muted mt-4 text-[14px]">
                Responder desde aquí llega en el próximo paso. Mientras tanto, «Tomar la conversación» hace que el asistente deje de responder.
              </p>
            )}
          </div>
        )}
      </section>
    </div>
  );
}
EOF_SRC_COMPONENTS_INBOX_TSX
echo "✔ src/components/Inbox.tsx"
mkdir -p src/app/hoy
cat > src/app/hoy/page.tsx <<'EOF_SRC_APP_HOY_PAGE_TSX'
import type { Metadata } from "next";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { Suspense } from "react";
import { AppHeader, ROLE_LABEL } from "@/components/AppHeader";
import { WorkQueue } from "@/components/WorkQueue";
import { can } from "@/lib/auth/permissions";
import { effectiveTenant, getSessionFromHeaders } from "@/lib/auth/session";

export const metadata: Metadata = { title: "Hoy" };

export default function TodayPage() {
  return (
    <Suspense fallback={<div className="container-app py-24 muted-dark" role="status">Cargando…</div>}>
      <TodayContent />
    </Suspense>
  );
}

async function TodayContent() {
  const auth = await getSessionFromHeaders(await headers());
  if (!auth) redirect("/entrar");
  const { session } = auth;
  if (session.needsMfaSetup) redirect("/seguridad");
  const ctx = effectiveTenant(session);
  if (!ctx) redirect("/panel");

  return (
    <div className="flex min-h-screen flex-col">
      <AppHeader
        email={session.email}
        roleLabel={ctx.impersonating ? "Soporte" : ROLE_LABEL[ctx.role]}
        showAdmin={session.isSuperAdmin}
        showTeam={can(ctx.role, "team:manage")}
      />
      <main className="container-app flex-1 pb-24 pt-8">
        <p className="eyebrow eyebrow--dark">Tu negocio</p>
        <h1 className="mt-3 text-[32px] sm:text-[48px]">Hoy</h1>
        <p className="muted-dark mt-3 max-w-[640px]">Lo que necesita a una persona, ordenado por urgencia. Se actualiza solo.</p>
        <div className="mt-10">
          <WorkQueue />
        </div>
      </main>
    </div>
  );
}
EOF_SRC_APP_HOY_PAGE_TSX
echo "✔ src/app/hoy/page.tsx"
mkdir -p src/app/conversaciones
cat > src/app/conversaciones/page.tsx <<'EOF_SRC_APP_CONVERSACIONES_PAGE_TSX'
import type { Metadata } from "next";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { Suspense } from "react";
import { AppHeader, ROLE_LABEL } from "@/components/AppHeader";
import { Inbox } from "@/components/Inbox";
import { can } from "@/lib/auth/permissions";
import { effectiveTenant, getSessionFromHeaders } from "@/lib/auth/session";

export const metadata: Metadata = { title: "Conversaciones" };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export default function ConversationsPage({ searchParams }: { searchParams: Promise<{ c?: string | string[] }> }) {
  return (
    <Suspense fallback={<div className="container-app py-24 muted-dark" role="status">Cargando…</div>}>
      <ConversationsContent searchParams={searchParams} />
    </Suspense>
  );
}

async function ConversationsContent({ searchParams }: { searchParams: Promise<{ c?: string | string[] }> }) {
  const auth = await getSessionFromHeaders(await headers());
  if (!auth) redirect("/entrar");
  const { session } = auth;
  if (session.needsMfaSetup) redirect("/seguridad");
  const ctx = effectiveTenant(session);
  if (!ctx) redirect("/panel");
  const c = (await searchParams).c;
  const initialId = typeof c === "string" && UUID.test(c) ? c : null;

  return (
    <div className="flex min-h-screen flex-col">
      <AppHeader
        email={session.email}
        roleLabel={ctx.impersonating ? "Soporte" : ROLE_LABEL[ctx.role]}
        showAdmin={session.isSuperAdmin}
        showTeam={can(ctx.role, "team:manage")}
      />
      <main className="container-app flex-1 pb-24 pt-8">
        <p className="eyebrow eyebrow--dark">Tu negocio</p>
        <h1 className="mt-3 text-[32px] sm:text-[48px]">Conversaciones</h1>
        <div className="mt-10">
          <Inbox initialId={initialId} />
        </div>
      </main>
    </div>
  );
}
EOF_SRC_APP_CONVERSACIONES_PAGE_TSX
echo "✔ src/app/conversaciones/page.tsx"
mkdir -p src/lib/agent
cat > src/lib/agent/run.ts <<'EOF_SRC_LIB_AGENT_RUN_TS'
import { getLlmProvider } from "@/lib/ai";
import type { LlmProvider } from "@/lib/ai/provider";
import { decryptSecret } from "@/lib/crypto";
import { withTenant } from "@/lib/db";
import { getLlmEnv } from "@/lib/env";
import { withLock } from "@/lib/queue/lock";
import type { InboundJob } from "@/lib/queue/producer";
import { sendText } from "@/lib/whatsapp/graph";
import { FIXED, RULES_LINES, buildSystemPrompt, buildTurns, customerWantsHuman, parseReply, type HistoryRow } from "./prompt";
import { getEmbedder, type Embedder } from "@/lib/kb/embeddings";
import { searchKnowledge, type Snippet } from "@/lib/kb/search";
import { allowedContacts, checkOutput, looksLikeInjection, newCanary } from "./safety";

export type AgentOutcome =
  | "replied"
  | "handoff"
  | "already_replied"
  | "limit_reached"
  | "contact_limited"
  | "send_failed"
  | "send_unknown"
  | "skipped_not_found"
  | "skipped_ignored_type"
  | "skipped_disabled"
  | "skipped_inactive_tenant"
  | "skipped_human"
  | "skipped_personal"
  | "skipped_superseded"
  | "skipped_no_whatsapp";

export interface AgentDeps {
  llm: LlmProvider;
  send: typeof sendText;
  /** Para pruebas: el generador de vectores de la base de conocimiento. */
  embedder: Embedder;
}

const LOCK_TTL_MS = 90_000; // mayor que IA (30 s) + envío (10 s) + base de datos
const LLM_MAX_TOKENS = 400;
const TEXT_TYPES = new Set(["text", "button", "interactive"]);
const IGNORED_TYPES = new Set(["reaction"]);

interface Ctx {
  messageId: string;
  conversationId: string;
  contactId: string;
  msgType: string;
  body: string | null;
  convStatus: string;
  contactLabel: string;
  waId: string;
  tenantName: string;
  tenantStatus: string;
  trialEndsAt: Date | null;
  enabled: boolean;
  assistantName: string;
  instructions: string;
  phoneId: string | null;
  secretEnc: string | null;
  keyVersion: number | null;
}

async function loadContext(job: InboundJob): Promise<Ctx | null> {
  return withTenant(job.tenantId, async (db) => {
    const r = await db.query(
      `SELECT m.id AS message_id, m.conversation_id, c.contact_id, m.msg_type, m.body,
              c.status AS conv_status, ct.wa_id, ct.label AS contact_label,
              t.name AS tenant_name, t.status AS tenant_status, t.trial_ends_at,
              COALESCE(a.enabled, false) AS enabled,
              COALESCE(a.assistant_name, 'Asistente') AS assistant_name,
              COALESCE(a.instructions, '') AS instructions,
              i.external_id AS phone_id, i.secret_enc, i.key_version
         FROM messages m
         JOIN conversations c ON c.tenant_id = m.tenant_id AND c.id = m.conversation_id
         JOIN contacts ct ON ct.tenant_id = c.tenant_id AND ct.id = c.contact_id
         JOIN tenants t ON t.id = m.tenant_id
         LEFT JOIN tenant_agents a ON a.tenant_id = m.tenant_id
         LEFT JOIN tenant_integrations i ON i.tenant_id = m.tenant_id AND i.provider = 'whatsapp'
        WHERE m.tenant_id = $1 AND m.id = $2 AND m.direction = 'in'`,
      [job.tenantId, job.messageId],
    );
    const x = r.rows[0];
    if (!x) return null;
    return {
      messageId: x.message_id, conversationId: x.conversation_id, contactId: x.contact_id, msgType: x.msg_type, body: x.body,
       convStatus: x.conv_status, contactLabel: x.contact_label, waId: x.wa_id,
      tenantName: x.tenant_name, tenantStatus: x.tenant_status, trialEndsAt: x.trial_ends_at,
      enabled: x.enabled, assistantName: x.assistant_name, instructions: x.instructions,
      phoneId: x.phone_id, secretEnc: x.secret_enc, keyVersion: x.key_version,
    } satisfies Ctx;
  });
}

function tenantActive(c: Ctx): boolean {
  if (c.tenantStatus === "active") return true;
  if (c.tenantStatus === "trial") return !c.trialEndsAt || c.trialEndsAt.getTime() > Date.now();
  return false;
}

type EventKind = "inyeccion" | "fuga_prompt" | "salida_bloqueada" | "limite_contacto";

/** Anota un incidente (solo tipo, mensaje y conversación; nunca el texto). Un reintento no lo duplica. */
async function recordEvent(tenantId: string, conversationId: string, messageId: string, kind: EventKind) {
  await withTenant(tenantId, (db) =>
    db.query(
      "INSERT INTO agent_events (tenant_id, conversation_id, message_id, kind) VALUES ($1, $2, $3, $4) ON CONFLICT (tenant_id, message_id, kind) DO NOTHING",
      [tenantId, conversationId, messageId, kind],
    ),
  );
}

/** Tras este número de mensajes de manipulación en una conversación, se deja de gastar IA y pasa a una persona. */
const INJECTION_STRIKES = 3;

async function handoff(tenantId: string, conversationId: string, reason: string) {
  await withTenant(tenantId, (db) =>
    db.query(
      "UPDATE conversations SET status = 'human', handoff_reason = $3 WHERE tenant_id = $1 AND id = $2 AND status = 'bot'",
      [tenantId, conversationId, reason],
    ),
  );
}

/**
 * Atiende un mensaje entrante: decide si responde, genera la respuesta y la envía.
 * Garantías:
 *  - Una conversación a la vez (candado en Redis).
 *  - Si el cliente escribe varios mensajes seguidos, solo el último genera respuesta (con todo el contexto).
 *  - Una respuesta por mensaje (índice único) y nunca se reenvía a ciegas: si no sabemos si Meta lo recibió, pasa a una persona.
 */
export async function runAgent(job: InboundJob, deps: Partial<AgentDeps> = {}): Promise<AgentOutcome> {
  const first = await loadContext(job);
  if (!first) return "skipped_not_found";
  return withLock(`agent-${first.conversationId}`, LOCK_TTL_MS, () => attend(job, deps));
}

async function attend(job: InboundJob, deps: Partial<AgentDeps>): Promise<AgentOutcome> {
  const { tenantId } = job;
  const ctx = await loadContext(job);
  if (!ctx) return "skipped_not_found";
  if (IGNORED_TYPES.has(ctx.msgType)) return "skipped_ignored_type";
  // Contactos marcados como "personal" (familia, amistades, proveedores…): el asistente nunca les responde.
  if (ctx.contactLabel === "personal") return "skipped_personal";
  if (!ctx.enabled) return "skipped_disabled";
  if (!tenantActive(ctx)) return "skipped_inactive_tenant";
  if (!ctx.phoneId || !ctx.secretEnc || ctx.keyVersion === null) return "skipped_no_whatsapp";

  // ¿Ya hay una respuesta para este mensaje (reintento)?
  const prev = await withTenant(tenantId, async (db) => {
    const r = await db.query("SELECT id, send_state FROM messages WHERE tenant_id = $1 AND reply_to = $2 AND direction = 'out'", [tenantId, ctx.messageId]);
    return r.rows[0] as { id: string; send_state: string } | undefined;
  });
  if (prev) {
    if (prev.send_state === "sending") {
      // Un intento anterior murió a mitad del envío: no sabemos si Meta lo recibió.
      await withTenant(tenantId, (db) =>
        db.query("UPDATE messages SET send_state = 'unknown', send_error = 'el proceso se interrumpió durante el envío' WHERE tenant_id = $1 AND id = $2", [tenantId, prev.id]),
      );
      await handoff(tenantId, ctx.conversationId, "envio_incierto");
      return "send_unknown";
    }
    return prev.send_state === "failed" ? "send_failed" : prev.send_state === "unknown" ? "send_unknown" : "already_replied";
  }

  if (ctx.convStatus !== "bot") return "skipped_human";

  // Intentos de manipulación: se registran y, si la persona insiste, se corta antes de gastar IA.
  if (looksLikeInjection(ctx.body)) {
    await recordEvent(tenantId, ctx.conversationId, ctx.messageId, "inyeccion");
  }
  const strikes = await withTenant(tenantId, async (db) => {
    const r = await db.query("SELECT count(*)::int AS n FROM agent_events WHERE tenant_id = $1 AND conversation_id = $2 AND kind = 'inyeccion'", [tenantId, ctx.conversationId]);
    return r.rows[0].n as number;
  });

  // Si el cliente ya escribió algo más reciente, esa otra tarea responderá con todo el contexto.
  const newer = await withTenant(tenantId, async (db) => {
    const r = await db.query(
      `SELECT 1 FROM messages WHERE tenant_id = $1 AND conversation_id = $2 AND direction = 'in' AND msg_type <> 'reaction'
          AND (received_at, id) > (SELECT received_at, id FROM messages WHERE tenant_id = $1 AND id = $3) LIMIT 1`,
      [tenantId, ctx.conversationId, ctx.messageId],
    );
    return r.rowCount === 1;
  });
  if (newer) return "skipped_superseded";

  // Tope diario de respuestas por negocio.
  const env = getLlmEnv();
  const today = await withTenant(tenantId, async (db) => {
    const r = await db.query(
      `SELECT count(*)::int AS n FROM messages
        WHERE tenant_id = $1 AND direction = 'out' AND reply_to IS NOT NULL AND send_state <> 'failed'
          AND created_at >= (date_trunc('day', now() AT TIME ZONE 'utc') AT TIME ZONE 'utc')`,
      [tenantId],
    );
    return r.rows[0].n as number;
  });
  if (today >= env.AGENT_DAILY_REPLY_LIMIT) {
    await handoff(tenantId, ctx.conversationId, "limite_diario");
    return "limit_reached";
  }

  // Tope por cliente: cuántas respuestas del asistente recibió esta persona en la última hora y en las últimas 24 horas.
  const perContact = await withTenant(tenantId, async (db) => {
    const r = await db.query(
      `SELECT count(*) FILTER (WHERE m.created_at >= now() - interval '1 hour')::int AS hora,
              count(*)::int AS dia
         FROM messages m JOIN conversations c ON c.tenant_id = m.tenant_id AND c.id = m.conversation_id
        WHERE m.tenant_id = $1 AND c.contact_id = $2 AND m.direction = 'out' AND m.reply_to IS NOT NULL
          AND m.send_state <> 'failed' AND m.created_at >= now() - interval '24 hours'`,
      [tenantId, ctx.contactId],
    );
    return r.rows[0] as { hora: number; dia: number };
  });
  const contactLimited = perContact.hora >= env.AGENT_CONTACT_HOURLY_LIMIT || perContact.dia >= env.AGENT_CONTACT_DAILY_LIMIT;

  // Qué responder.
  let text: string;
  let wantsHandoff = false;
  let handoffReason = "pedido_de_persona";
  let usage = { input: 0, output: 0 };
  if (!(TEXT_TYPES.has(ctx.msgType) && ctx.body)) {
    text = FIXED.nonText;
  } else if (contactLimited) {
    await recordEvent(tenantId, ctx.conversationId, ctx.messageId, "limite_contacto");
    text = FIXED.rateLimited;
    wantsHandoff = true;
    handoffReason = "limite_contacto";
  } else if (strikes >= INJECTION_STRIKES) {
    text = FIXED.handoff;
    wantsHandoff = true;
    handoffReason = "intentos_de_manipulacion";
  } else if (customerWantsHuman(ctx.body)) {
    text = FIXED.handoff;
    wantsHandoff = true;
  } else {
    const history = await withTenant(tenantId, async (db) => {
      const r = await db.query(
        `SELECT direction, msg_type, body FROM messages
          WHERE tenant_id = $1 AND conversation_id = $2
            AND (direction = 'in' OR send_state = 'sent' OR send_state IS NULL)
          ORDER BY received_at DESC, id DESC LIMIT $3`,
        [tenantId, ctx.conversationId, env.AGENT_HISTORY_MESSAGES],
      );
      return (r.rows as HistoryRow[]).reverse();
    });
    const llm = deps.llm ?? getLlmProvider();
    // Base de conocimiento: si falla (modelo no disponible), se responde sin ella en vez de fallar la respuesta.
    let knowledge: Snippet[] = [];
    try {
      const questions = history.filter((h) => h.direction === "in" && h.msg_type === "text" && h.body).slice(-2).map((h) => h.body as string);
      knowledge = await searchKnowledge(tenantId, questions.join("\n"), deps.embedder ?? getEmbedder());
    } catch (err) {
      console.error("[agente] base de conocimiento no disponible:", err instanceof Error ? err.message : err);
    }
    const canary = newCanary();
    const out = await llm.generate({
      system: buildSystemPrompt({ assistantName: ctx.assistantName, businessName: ctx.tenantName, instructions: ctx.instructions, canary, knowledge }),
      messages: buildTurns(history),
      maxTokens: LLM_MAX_TOKENS,
    });
    usage = { input: out.inputTokens, output: out.outputTokens };
    const parsed = parseReply(out.text);
    // Revisión de salida: si el modelo filtró sus reglas o inventó enlaces/correos, NO se envía; pasa a una persona.
    const verdict = checkOutput(parsed.text, { canary, rulesLines: RULES_LINES, allowed: allowedContacts([ctx.instructions, ...knowledge.map((k) => k.content)].join("\n")) });
    if (!verdict.ok) {
      await recordEvent(tenantId, ctx.conversationId, ctx.messageId, verdict.kind);
      text = FIXED.fallback;
      wantsHandoff = true;
      handoffReason = verdict.kind === "fuga_prompt" ? "fuga_de_instrucciones" : "salida_bloqueada";
    } else if (!parsed.text) {
      text = FIXED.fallback;
      wantsHandoff = true;
      handoffReason = "respuesta_vacia";
    } else {
      text = parsed.text;
      wantsHandoff = parsed.handoff;
    }
  }

  // Descifrar el token ANTES de crear la fila "sending": si falla aquí, no hay nada a medias.
  const token = decryptSecret(ctx.secretEnc, `wa:${tenantId}:${ctx.phoneId}`, ctx.keyVersion);

  // Anotar la respuesta como "sending" ANTES de enviar (bandeja de salida). Si el proceso muere
  // después del envío, el reintento verá esta fila y no volverá a mandar el mensaje.
  const reserved = await withTenant(tenantId, async (db) => {
    const c = await db.query("SELECT status FROM conversations WHERE tenant_id = $1 AND id = $2 FOR SHARE", [tenantId, ctx.conversationId]);
    if (c.rows[0]?.status !== "bot") return "human" as const; // una persona tomó la conversación mientras pensábamos
    const r = await db.query(
      `INSERT INTO messages (tenant_id, conversation_id, direction, msg_type, body, reply_to, send_state)
       VALUES ($1, $2, 'out', 'text', $3, $4, 'sending')
       ON CONFLICT (tenant_id, reply_to) WHERE direction = 'out' AND reply_to IS NOT NULL DO NOTHING
       RETURNING id`,
      [tenantId, ctx.conversationId, text, ctx.messageId],
    );
    return r.rowCount ? (r.rows[0].id as string) : ("dup" as const);
  });
  if (reserved === "human") return "skipped_human";
  if (reserved === "dup") return "already_replied";
  const outId = reserved;

  const result = await (deps.send ?? sendText)(ctx.phoneId, token, ctx.waId, text);

  switch (result.kind) {
    case "sent": {
      await withTenant(tenantId, async (db) => {
        await db.query("UPDATE messages SET wa_message_id = $3, send_state = 'sent' WHERE tenant_id = $1 AND id = $2", [tenantId, outId, result.waMessageId]);
        await db.query("UPDATE conversations SET last_message_at = now() WHERE tenant_id = $1 AND id = $2", [tenantId, ctx.conversationId]);
        await db.query(
          `INSERT INTO agent_usage_daily (tenant_id, day, replies, input_tokens, output_tokens)
           VALUES ($1, (now() AT TIME ZONE 'utc')::date, 1, $2, $3)
           ON CONFLICT (tenant_id, day) DO UPDATE SET replies = agent_usage_daily.replies + 1,
             input_tokens = agent_usage_daily.input_tokens + EXCLUDED.input_tokens,
             output_tokens = agent_usage_daily.output_tokens + EXCLUDED.output_tokens`,
          [tenantId, usage.input, usage.output],
        );
      });
      if (wantsHandoff) {
        await handoff(tenantId, ctx.conversationId, handoffReason);
        return "handoff";
      }
      return "replied";
    }
    case "retry": {
      // No llegó a Meta: se borra la fila y se reintenta todo el trabajo más tarde.
      await withTenant(tenantId, (db) => db.query("DELETE FROM messages WHERE tenant_id = $1 AND id = $2 AND send_state = 'sending'", [tenantId, outId]));
      throw new Error(`No se pudo enviar todavía (${result.reason}); se reintentará`);
    }
    case "rejected": {
      await withTenant(tenantId, (db) =>
        db.query("UPDATE messages SET send_state = 'failed', send_error = $3 WHERE tenant_id = $1 AND id = $2", [tenantId, outId, `${result.code ?? result.status}: ${result.message}`.slice(0, 300)]),
      );
      await handoff(tenantId, ctx.conversationId, "envio_rechazado");
      return "send_failed";
    }
    case "unknown": {
      await withTenant(tenantId, (db) =>
        db.query("UPDATE messages SET send_state = 'unknown', send_error = $3 WHERE tenant_id = $1 AND id = $2", [tenantId, outId, result.reason.slice(0, 300)]),
      );
      await handoff(tenantId, ctx.conversationId, "envio_incierto");
      return "send_unknown";
    }
  }
}
EOF_SRC_LIB_AGENT_RUN_TS
echo "✔ src/lib/agent/run.ts"
mkdir -p src/components
cat > src/components/AppHeader.tsx <<'EOF_SRC_COMPONENTS_APPHEADER_TSX'
import Link from "next/link";
import { brand } from "@/config/brand";
import { LogoutButton } from "./LogoutButton";

export const ROLE_LABEL: Record<string, string> = {
  owner: "Dueño",
  admin: "Administrador",
  agent: "Agente",
};

export function AppHeader({
  email,
  roleLabel,
  showAdmin,
  showTeam,
  showWork = true,
}: {
  email: string;
  roleLabel?: string;
  showAdmin?: boolean;
  showTeam?: boolean;
  /** Enlaces «Hoy» y «Conversaciones». Se ocultan donde no hay negocio (p. ej. administración). */
  showWork?: boolean;
}) {
  return (
    <header className="container-app flex min-h-20 flex-wrap items-center justify-between gap-4 py-4">
      <Link href="/panel" className="text-lg font-medium" style={{ letterSpacing: "-0.01em" }}>
        {brand.name}
      </Link>
      <div className="flex flex-wrap items-center gap-3">
        {showWork && (
          <>
            <Link href="/hoy" className="btn btn-text btn-sm">
              Hoy
            </Link>
            <Link href="/conversaciones" className="btn btn-text btn-sm">
              Conversaciones
            </Link>
          </>
        )}
        {showAdmin && (
          <Link href="/admin" className="btn btn-text btn-sm">
            Administración
          </Link>
        )}
        {showTeam && (
          // Quien puede gestionar el equipo (dueño y administrador) también gestiona el asistente.
          <>
            <Link href="/agente" className="btn btn-text btn-sm">
              Asistente
            </Link>
            <Link href="/conocimiento" className="btn btn-text btn-sm">
              Conocimiento
            </Link>
            <Link href="/equipo" className="btn btn-text btn-sm">
              Equipo
            </Link>
          </>
        )}
        <Link href="/seguridad" className="btn btn-text btn-sm">
          Seguridad
        </Link>
        <span className="muted-dark text-sm">{email}</span>
        {roleLabel && <span className="badge badge-neutral">{roleLabel}</span>}
        <LogoutButton />
      </div>
    </header>
  );
}
EOF_SRC_COMPONENTS_APPHEADER_TSX
echo "✔ src/components/AppHeader.tsx"
mkdir -p src/app/panel
cat > src/app/panel/page.tsx <<'EOF_SRC_APP_PANEL_PAGE_TSX'
import type { Metadata } from "next";
import { headers } from "next/headers";
import Link from "next/link";
import { redirect } from "next/navigation";
import { Suspense } from "react";
import { AppHeader, ROLE_LABEL } from "@/components/AppHeader";
import { StopImpersonationButton } from "@/components/StopImpersonationButton";
import { effectiveTenant, getSessionFromHeaders } from "@/lib/auth/session";
import { can } from "@/lib/auth/permissions";
import { withTenant } from "@/lib/db";

export const metadata: Metadata = { title: "Panel" };

const STATUS_LABEL: Record<string, string> = {
  trial: "Prueba gratis",
  active: "Activa",
  past_due: "Pago pendiente",
  suspended: "Suspendida",
};

export default function PanelPage() {
  return (
    <Suspense fallback={<div className="container-app py-24 muted-dark" role="status">Cargando…</div>}>
      <PanelContent />
    </Suspense>
  );
}

async function PanelContent() {
  const auth = await getSessionFromHeaders(await headers());
  if (!auth) redirect("/entrar");
  const { session } = auth;
  if (session.needsMfaSetup) redirect("/seguridad");
  const ctx = effectiveTenant(session);

  const tenant = ctx
    ? await withTenant(ctx.tenantId, async (db) => {
        const r = await db.query<{ name: string; status: string; days_left: number | null }>(
          `SELECT name, status,
                  GREATEST(0, CEIL(EXTRACT(EPOCH FROM (trial_ends_at - now())) / 86400))::int AS days_left
           FROM tenants`,
        );
        return r.rows[0] ?? null;
      })
    : null;

  const daysLeft = tenant?.status === "trial" ? tenant.days_left : null;

  return (
    <div className="flex min-h-screen flex-col">
      {ctx?.impersonating && tenant && (
        <div className="alert-warn flex flex-wrap items-center justify-between gap-3" style={{ borderRadius: 0 }} role="status">
          <span>
            Estás viendo <strong>{tenant.name}</strong> como soporte (máximo 30 minutos). Todo queda registrado y el dueño puede verlo.
          </span>
          <StopImpersonationButton />
        </div>
      )}

      <AppHeader
        email={session.email}
        roleLabel={ctx ? (ctx.impersonating ? "Soporte" : ROLE_LABEL[ctx.role]) : "Súper admin"}
        showAdmin={session.isSuperAdmin}
        showTeam={!!ctx && can(ctx.role, "team:manage")}
        showWork={!!ctx}
      />

      <main className="container-app flex-1 pb-24 pt-8">
        {!ctx || !tenant ? (
          <section className="card-light" style={{ maxWidth: 640 }}>
            <p className="eyebrow">Sin negocio</p>
            <h1 className="mt-3 text-[32px]">No tienes un negocio activo</h1>
            <p className="muted mt-3">
              {session.isSuperAdmin ? (
                <>
                  Entra desde <Link href="/admin" className="link">Administración</Link> para ver un negocio como soporte.
                </>
              ) : (
                "Pide acceso a quien administra tu negocio."
              )}
            </p>
          </section>
        ) : (
          <>
            <p className="eyebrow eyebrow--dark">Tu negocio</p>
            <h1 className="mt-3 text-[32px] sm:text-[48px]" style={{ lineHeight: 1.12 }}>
              {tenant.name}
            </h1>
            <div className="mt-4 flex flex-wrap items-center gap-3">
              <span className="badge">{STATUS_LABEL[tenant.status] ?? tenant.status}</span>
              {daysLeft !== null && (
                <span className="muted-dark text-sm">
                  {daysLeft === 1 ? "Queda 1 día de prueba" : `Quedan ${daysLeft} días de prueba`}
                </span>
              )}
            </div>

            {tenant.status === "suspended" && !ctx.impersonating && (
              <p className="alert-warn mt-8" role="alert">
                Esta cuenta está suspendida. Escríbenos para reactivarla.
              </p>
            )}

            <section className="mt-12 grid gap-6 md:grid-cols-3" aria-label="Próximos pasos">
              <article className="card-dark">
                <p className="eyebrow eyebrow--dark">Paso 1</p>
                <h2 className="mt-2 text-xl">Conecta tu WhatsApp</h2>
                <p className="muted-dark mt-2 text-sm">
                  <Link href="/whatsapp" className="link">Conectar mi número</Link>
                </p>
              </article>
              <article className="card-dark">
                <p className="eyebrow eyebrow--dark">Paso 2</p>
                <h2 className="mt-2 text-xl">Cuéntale a tu agente cómo atiendes</h2>
                <p className="muted-dark mt-2 text-sm">
                  Horarios, servicios y preguntas frecuentes. <Link href="/agente" className="link">Configurar el asistente</Link>
                </p>
              </article>
              <article className="card-dark">
                <p className="eyebrow eyebrow--dark">Paso 3</p>
                <h2 className="mt-2 text-xl">Invita a tu equipo</h2>
                <p className="muted-dark mt-2 text-sm">
                  {can(ctx.role, "team:manage") ? "Podrás añadir agentes y administradores." : "Solo administradores y dueños pueden invitar personas."}
                </p>
              </article>
            </section>
          </>
        )}
      </main>
    </div>
  );
}
EOF_SRC_APP_PANEL_PAGE_TSX
echo "✔ src/app/panel/page.tsx"
mkdir -p src/app/admin
cat > src/app/admin/page.tsx <<'EOF_SRC_APP_ADMIN_PAGE_TSX'
import type { Metadata } from "next";
import { headers } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { Suspense } from "react";
import { AppHeader } from "@/components/AppHeader";
import { TenantActions } from "@/components/TenantActions";
import { getPool } from "@/lib/db";
import { getSessionFromHeaders } from "@/lib/auth/session";

export const metadata: Metadata = { title: "Administración" };

const STATUS_LABEL: Record<string, string> = {
  trial: "Prueba",
  active: "Activa",
  past_due: "Pago pendiente",
  suspended: "Suspendida",
};

export default function AdminPage() {
  return (
    <Suspense fallback={<div className="container-app py-24 muted-dark" role="status">Cargando…</div>}>
      <AdminContent />
    </Suspense>
  );
}

async function AdminContent() {
  const auth = await getSessionFromHeaders(await headers());
  // Defensa en profundidad: el proxy ya responde 404 real a quien no es súper admin; aquí se repite la comprobación.
  if (!auth) notFound();
  if (auth.session.needsMfaSetup) redirect("/seguridad"); // súper admin sin 2FA
  if (!auth.session.isSuperAdmin) notFound(); // para el resto, esta página "no existe"

  const r = await getPool().query("SELECT * FROM admin_list_tenants($1)", [auth.tokenHash]);
  const fmt = new Intl.DateTimeFormat("es-VE", { dateStyle: "medium" });

  return (
    <div className="flex min-h-screen flex-col">
      <AppHeader email={auth.session.email} roleLabel="Súper admin" showWork={false} />
      <main className="container-app flex-1 pb-24 pt-8">
        <p className="eyebrow eyebrow--dark">Administración</p>
        <h1 className="mt-3 text-[32px] sm:text-[48px]">Negocios</h1>
        <p className="muted-dark mt-3 max-w-xl text-sm">
          Entrar como soporte exige un motivo, dura 30 minutos como máximo y queda en el registro de auditoría del negocio.
        </p>

        {r.rows.length === 0 ? (
          <p className="card-dark mt-10 muted-dark">Todavía no hay negocios registrados.</p>
        ) : (
          <ul className="mt-10 flex flex-col gap-4">
            {r.rows.map((t) => (
              <li key={t.t_id} className="card-dark grid gap-4 md:grid-cols-[1fr_auto] md:items-start">
                <div>
                  <h2 className="text-xl">{t.t_name}</h2>
                  <p className="muted-dark mt-1 text-sm">
                    {t.t_slug} · {Number(t.t_members)} {Number(t.t_members) === 1 ? "persona" : "personas"} · creado {fmt.format(t.t_created_at)}
                  </p>
                  <p className="mt-3">
                    <span className="badge">{STATUS_LABEL[t.t_status] ?? t.t_status}</span>
                  </p>
                </div>
                <TenantActions tenantId={t.t_id} status={t.t_status} />
              </li>
            ))}
          </ul>
        )}
      </main>
    </div>
  );
}
EOF_SRC_APP_ADMIN_PAGE_TSX
echo "✔ src/app/admin/page.tsx"
mkdir -p src/app/seguridad
cat > src/app/seguridad/page.tsx <<'EOF_SRC_APP_SEGURIDAD_PAGE_TSX'
import type { Metadata } from "next";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { Suspense } from "react";
import { AppHeader, ROLE_LABEL } from "@/components/AppHeader";
import { SecurityPanel } from "@/components/SecurityPanel";
import { getPool } from "@/lib/db";
import { can } from "@/lib/auth/permissions";
import { effectiveTenant, getSessionFromHeaders } from "@/lib/auth/session";

export const metadata: Metadata = { title: "Seguridad" };

export default function SeguridadPage() {
  return (
    <Suspense fallback={<div className="container-app py-24 muted-dark" role="status">Cargando…</div>}>
      <SeguridadContent />
    </Suspense>
  );
}

async function SeguridadContent() {
  const auth = await getSessionFromHeaders(await headers());
  if (!auth) redirect("/entrar");
  const { session, tokenHash } = auth;
  const ctx = effectiveTenant(session);
  const st = await getPool().query("SELECT * FROM mfa_status($1)", [tokenHash]);
  const row = st.rows[0] ?? { st_enabled: false, st_codes_left: 0 };
  const isSuper = session.isSuperAdmin || session.needsMfaSetup;

  return (
    <div className="flex min-h-screen flex-col">
      <AppHeader
        email={session.email}
        roleLabel={ctx ? ROLE_LABEL[ctx.role] : isSuper ? "Súper admin" : undefined}
        showAdmin={session.isSuperAdmin}
        showTeam={!!ctx && can(ctx.role, "team:manage")}
        showWork={!!ctx}
      />
      <main className="container-app flex-1 pb-24 pt-8">
        <p className="eyebrow eyebrow--dark">Tu cuenta</p>
        <h1 className="mt-3 text-[32px] sm:text-[48px]">Seguridad</h1>
        <div className="mt-10">
          <SecurityPanel
            enabled={row.st_enabled}
            codesLeft={row.st_codes_left}
            isSuperAdmin={isSuper}
            mustEnable={session.needsMfaSetup}
          />
        </div>
      </main>
    </div>
  );
}
EOF_SRC_APP_SEGURIDAD_PAGE_TSX
echo "✔ src/app/seguridad/page.tsx"
mkdir -p tests
cat > tests/work.test.ts <<'EOF_TESTS_WORK_TEST_TS'
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { POST as signup } from "@/app/api/auth/signup/route";
import { GET as listConversations } from "@/app/api/conversations/route";
import { GET as conversationDetail } from "@/app/api/conversations/messages/route";
import { POST as updateConversation } from "@/app/api/conversations/update/route";
import { GET as me } from "@/app/api/me/route";
import { GET as listWork, POST as createWork } from "@/app/api/work/route";
import { POST as updateWork } from "@/app/api/work/update/route";
import { runAgent } from "@/lib/agent/run";
import type { LlmProvider } from "@/lib/ai/provider";
import { encryptSecret } from "@/lib/crypto";
import { getPool, withTenant } from "@/lib/db";
import { closeLockClient } from "@/lib/queue/lock";
import { ingestBatch } from "@/lib/whatsapp/ingest";
import type { SendResult } from "@/lib/whatsapp/graph";

const RUN = randomUUID().slice(0, 8);
process.env.QUEUE_PREFIX = `test-w-${RUN}`;
const ORIGIN = new URL(process.env.APP_URL!).origin;
const PASSWORD = "contraseña-de-prueba-123";
const TOKEN = "EAAtoken-de-prueba-del-negocio-1234567890";
const owner = new Pool({ connectionString: process.env.MIGRATION_DATABASE_URL, max: 2 });
const tenantIds: string[] = [];
let seq = 0;
const newPhoneId = () => `7${RUN.replace(/\D/g, "").padEnd(4, "5").slice(0, 4)}${Date.now() % 100000}${seq++}`.slice(0, 18);
const newWaId = () => `58414${String(Date.now()).slice(-6)}${seq++}`.slice(0, 15);

function api(method: string, path: string, cookie?: string, body?: unknown) {
  return new Request(`${ORIGIN}${path}`, {
    method,
    headers: { origin: ORIGIN, ...(body !== undefined ? { "content-type": "application/json" } : {}), ...(cookie ? { cookie } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

async function register(name: string, opts: { agent?: boolean } = {}) {
  const email = `wk-${RUN}-${name}@example.test`;
  const res = await signup(api("POST", "/api/auth/signup", undefined, { email, password: PASSWORD, businessName: `Negocio ${name}` }));
  expect(res.status).toBe(201);
  const cookie = (res.headers.get("set-cookie") ?? "").split(";")[0]!;
  const info = await (await me(api("GET", "/api/me", cookie))).json();
  const tenantId = info.tenant.id as string;
  tenantIds.push(tenantId);
  const phoneId = newPhoneId();
  const { payload, keyVersion } = encryptSecret(TOKEN, `wa:${tenantId}:${phoneId}`);
  await owner.query("INSERT INTO tenant_integrations (tenant_id, provider, external_id, secret_enc, key_version) VALUES ($1,'whatsapp',$2,$3,$4)", [tenantId, phoneId, payload, keyVersion]);
  if (opts.agent) {
    await withTenant(tenantId, (db) => db.query("INSERT INTO tenant_agents (tenant_id, enabled, assistant_name, instructions) VALUES ($1, true, 'Ana', 'Abrimos de 8am a 5pm.')", [tenantId]));
  }
  return { tenantId, phoneId, cookie };
}
type T = Awaited<ReturnType<typeof register>>;

let t0 = Math.floor(Date.now() / 1000) - 3600;
/** Un cliente escribe (como lo haría el webhook). Devuelve los ids de su conversación y contacto. */
async function customer(t: T, body: string | null = "hola", opts: { name?: string; waId?: string; type?: string } = {}) {
  const waId = opts.waId ?? newWaId();
  const r = await ingestBatch({ phoneNumberId: t.phoneId, statuses: [], messages: [{ waId, name: opts.name ?? "Cliente", waMessageId: `wamid.${RUN}.${seq++}`, at: new Date(++t0 * 1000), type: opts.type ?? "text", body }] });
  const row = await withTenant(t.tenantId, async (db) =>
    (await db.query("SELECT c.id AS conv, c.contact_id AS contact FROM conversations c JOIN contacts ct ON ct.id = c.contact_id AND ct.tenant_id = c.tenant_id WHERE ct.wa_id = $1 AND c.status <> 'closed'", [waId])).rows[0],
  );
  return { waId, conv: row.conv as string, contact: row.contact as string, messageId: r.inbound[0]!.messageId };
}
const handoff = (t: T, conv: string, reason: string | null) =>
  withTenant(t.tenantId, (db) => db.query("UPDATE conversations SET status = 'human', handoff_reason = $2 WHERE id = $1 AND status = 'bot'", [conv, reason]));
const setStatus = (t: T, conv: string, status: string) => withTenant(t.tenantId, (db) => db.query("UPDATE conversations SET status = $2 WHERE id = $1", [conv, status]));
const items = (t: T, where = "true", params: unknown[] = []) =>
  withTenant(t.tenantId, async (db) => (await db.query(`SELECT * FROM work_items WHERE ${where} ORDER BY created_at, id`, params)).rows);
const events = (t: T, itemId: string) =>
  withTenant(t.tenantId, async (db) => (await db.query("SELECT kind, from_status, to_status, actor_user_id FROM work_item_events WHERE work_item_id = $1 ORDER BY created_at, id", [itemId])).rows);
const code = async (p: Promise<unknown>) => { try { await p; return undefined; } catch (e) { return (e as { code?: string }).code; } };

beforeAll(async () => { await getPool().query("SELECT 1"); });

afterAll(async () => {
  await closeLockClient();
  await owner.query("DELETE FROM users WHERE email LIKE $1", [`wk-${RUN}-%`]);
  for (const id of tenantIds) {
    const c = await owner.connect();
    try {
      await c.query("BEGIN");
      await c.query("SELECT set_config('app.tenant_id', $1, true)", [id]);
      await c.query("ALTER TABLE audit_log DISABLE TRIGGER audit_log_sin_cambios");
      await c.query("DELETE FROM audit_log WHERE tenant_id = $1", [id]);
      await c.query("ALTER TABLE audit_log ENABLE TRIGGER audit_log_sin_cambios");
      const del = await c.query("DELETE FROM tenants WHERE id = $1", [id]);
      if (del.rowCount !== 1) throw new Error("La limpieza no borró el negocio de prueba " + id);
      await c.query("COMMIT");
    } catch (e) {
      await c.query("ROLLBACK");
      throw e;
    } finally {
      c.release();
    }
  }
  await owner.end();
  await getPool().end();
});

describe("tareas: se crean y se cierran solas con la conversación (base de datos)", () => {
  it("el traspaso a una persona crea UNA tarea de alta prioridad con nombre y motivo", async () => {
    const t = await register("auto1");
    const c = await customer(t, "quiero hablar con alguien", { name: "María Pérez" });
    await handoff(t, c.conv, "pedido_de_persona");
    const rows = await items(t);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      type: "atencion_humana", status: "abierto", priority: 1, source: "agente",
      title: "Atender a María Pérez", conversation_id: c.conv, contact_id: c.contact,
    });
    expect(rows[0].detail).toContain("pidió hablar con una persona");
    expect(await events(t, rows[0].id)).toEqual([{ kind: "creado", from_status: null, to_status: "abierto", actor_user_id: null }]);
  });

  it("sin nombre se usa el número; un motivo desconocido o vacío da un texto genérico", async () => {
    const t = await register("auto2");
    const a = await customer(t, "hola", { name: "" });
    await handoff(t, a.conv, "motivo_que_no_existe");
    const b = await customer(t);
    await handoff(t, b.conv, null);
    const rows = await items(t);
    expect(rows.find((r) => r.conversation_id === a.conv)!.title).toBe(`Atender a +${a.waId}`);
    for (const r of rows) expect(r.detail).toBe("El asistente pasó esta conversación a una persona.");
  });

  it("cada motivo del asistente tiene su explicación", async () => {
    const t = await register("auto3");
    const want: Record<string, string> = {
      limite_diario: "límite diario", limite_contacto: "escribió muchísimo", intentos_de_manipulacion: "manipular",
      envio_rechazado: "rechazó", envio_incierto: "confirmar si la respuesta llegó", fuga_de_instrucciones: "revelar sus instrucciones",
      salida_bloqueada: "bloqueó", respuesta_vacia: "no pudo generar", agente_fallo: "fallo",
    };
    for (const [reason, text] of Object.entries(want)) {
      const c = await customer(t);
      await handoff(t, c.conv, reason);
      const [row] = await items(t, "conversation_id = $1", [c.conv]);
      expect(row.detail, reason).toContain(text);
    }
  });

  it("si una persona la toma a propósito (tomada_por_persona) no se crea tarea", async () => {
    const t = await register("auto4");
    const c = await customer(t);
    await handoff(t, c.conv, "tomada_por_persona");
    expect(await items(t)).toHaveLength(0);
  });

  it("devolver la conversación al asistente resuelve la tarea sola y queda en el historial; otro traspaso crea otra", async () => {
    const t = await register("auto5");
    const c = await customer(t);
    await handoff(t, c.conv, "pedido_de_persona");
    const [first] = await items(t);
    await setStatus(t, c.conv, "bot");
    const [after] = await items(t);
    expect(after).toMatchObject({ status: "resuelto" });
    expect(after.resolved_at).not.toBeNull();
    expect(await events(t, first.id)).toEqual([
      { kind: "creado", from_status: null, to_status: "abierto", actor_user_id: null },
      { kind: "estado", from_status: "abierto", to_status: "resuelto", actor_user_id: null },
    ]);
    await handoff(t, c.conv, "limite_diario");
    const all = await items(t);
    expect(all).toHaveLength(2);
    expect(all.filter((r) => r.status === "abierto")).toHaveLength(1);
  });

  it("cerrar la conversación resuelve la tarea de atención", async () => {
    const t = await register("auto6");
    const c = await customer(t);
    await handoff(t, c.conv, "pedido_de_persona");
    await setStatus(t, c.conv, "closed");
    expect((await items(t))[0]).toMatchObject({ status: "resuelto" });
  });

  it("solo toca las tareas de atención de ESA conversación (no otras tareas ni otras conversaciones)", async () => {
    const t = await register("auto7");
    const a = await customer(t);
    const b = await customer(t);
    await handoff(t, a.conv, "pedido_de_persona");
    await handoff(t, b.conv, "pedido_de_persona");
    await withTenant(t.tenantId, (db) => db.query("INSERT INTO work_items (tenant_id, type, title, source, conversation_id, contact_id) VALUES ($1,'seguimiento','Llamar mañana','manual',$2,$3)", [t.tenantId, a.conv, a.contact]));
    await setStatus(t, a.conv, "closed");
    const rows = await items(t);
    expect(rows.find((r) => r.type === "atencion_humana" && r.conversation_id === a.conv)!.status).toBe("resuelto");
    expect(rows.find((r) => r.type === "atencion_humana" && r.conversation_id === b.conv)!.status).toBe("abierto");
    expect(rows.find((r) => r.type === "seguimiento")!.status).toBe("abierto");
  });

  it("no hay dos tareas de atención abiertas para la misma conversación", async () => {
    const t = await register("auto8");
    const c = await customer(t);
    await handoff(t, c.conv, "pedido_de_persona");
    const dup = await code(withTenant(t.tenantId, (db) =>
      db.query("INSERT INTO work_items (tenant_id, type, title, source, conversation_id, contact_id) VALUES ($1,'atencion_humana','otra','manual',$2,$3)", [t.tenantId, c.conv, c.contact])));
    expect(dup).toBe("23505");
  });
});

describe("tareas: historial, aislamiento y reglas de la base", () => {
  it("cada cambio de estado o de responsable queda registrado con quien lo hizo", async () => {
    const t = await register("log1");
    const userId = (await owner.query("SELECT id FROM users WHERE email = $1", [`wk-${RUN}-log1@example.test`])).rows[0].id as string;
    await withTenant(t.tenantId, async (db) => {
      await db.query("SELECT set_config('app.actor', $1, true)", [userId]);
      const r = await db.query("INSERT INTO work_items (tenant_id, type, title, source, created_by) VALUES ($1,'tarea','Revisar caja','manual',$2) RETURNING id", [t.tenantId, userId]);
      await db.query("UPDATE work_items SET status = 'en_proceso', assigned_to = $2 WHERE id = $1", [r.rows[0].id, userId]);
      await db.query("UPDATE work_items SET status = 'resuelto', resolved_at = now(), resolved_by = $2 WHERE id = $1", [r.rows[0].id, userId]);
    });
    const [row] = await items(t);
    expect(await events(t, row.id)).toEqual([
      { kind: "creado", from_status: null, to_status: "abierto", actor_user_id: userId },
      { kind: "estado", from_status: "abierto", to_status: "en_proceso", actor_user_id: userId },
      { kind: "asignado", from_status: null, to_status: null, actor_user_id: userId },
      { kind: "estado", from_status: "en_proceso", to_status: "resuelto", actor_user_id: userId },
    ]);
    expect(row.updated_at.getTime()).toBeGreaterThanOrEqual(row.created_at.getTime());
  });

  it("el historial es de solo agregar: la aplicación no puede editarlo ni borrarlo", async () => {
    const t = await register("log2");
    const c = await customer(t);
    await handoff(t, c.conv, "pedido_de_persona");
    expect(await code(withTenant(t.tenantId, (db) => db.query("UPDATE work_item_events SET kind = 'estado'")))).toBe("42501");
    expect(await code(withTenant(t.tenantId, (db) => db.query("DELETE FROM work_item_events")))).toBe("42501");
  });

  it("un negocio no ve las tareas ni el historial de otro, ni puede apuntar a sus conversaciones", async () => {
    const a = await register("iso-a");
    const b = await register("iso-b");
    const ca = await customer(a);
    await handoff(a, ca.conv, "pedido_de_persona");
    expect(await items(a)).toHaveLength(1);
    expect(await items(b)).toHaveLength(0);
    const evB = await withTenant(b.tenantId, async (db) => (await db.query("SELECT count(*)::int AS n FROM work_item_events")).rows[0].n);
    expect(evB).toBe(0);
    // Intentar crear una tarea de B colgada de una conversación de A: lo impide la llave foránea compuesta.
    expect(await code(withTenant(b.tenantId, (db) =>
      db.query("INSERT INTO work_items (tenant_id, type, title, source, conversation_id) VALUES ($1,'tarea','x','manual',$2)", [b.tenantId, ca.conv])))).toBe("23503");
    // Y B no puede escribir con el negocio de A.
    expect(await code(withTenant(b.tenantId, (db) =>
      db.query("INSERT INTO work_items (tenant_id, type, title, source) VALUES ($1,'tarea','x','manual')", [a.tenantId])))).toBe("42501");
  });

  it("restricciones: tipo y estado válidos, resuelta ⇔ con fecha de resolución, clave anti-duplicado por negocio", async () => {
    const a = await register("chk-a");
    const b = await register("chk-b");
    const ins = (t: T, extra = "", vals: unknown[] = []) =>
      withTenant(t.tenantId, (db) => db.query(`INSERT INTO work_items (tenant_id, type, title, source${extra ? ", " + extra.split("|")[0] : ""}) VALUES ($1,'tarea','x','manual'${extra ? ", " + extra.split("|")[1] : ""})`, [t.tenantId, ...vals]));
    expect(await code(withTenant(a.tenantId, (db) => db.query("INSERT INTO work_items (tenant_id, type, title, source) VALUES ($1,'inventado','x','manual')", [a.tenantId])))).toBe("23514");
    expect(await code(withTenant(a.tenantId, (db) => db.query("INSERT INTO work_items (tenant_id, type, title, source, priority) VALUES ($1,'tarea','x','manual', 9)", [a.tenantId])))).toBe("23514");
    expect(await code(withTenant(a.tenantId, (db) => db.query("INSERT INTO work_items (tenant_id, type, title, source) VALUES ($1,'tarea','','manual')", [a.tenantId])))).toBe("23514");
    expect(await code(ins(a, "status|'resuelto'"))).toBe("23514"); // resuelta sin fecha
    expect(await code(ins(a, "resolved_at|now()"))).toBe("23514"); // fecha sin estar resuelta
    expect(await code(ins(a, "dedupe_key|$2", ["cita:1"]))).toBeUndefined();
    expect(await code(ins(a, "dedupe_key|$2", ["cita:1"]))).toBe("23505");
    expect(await code(ins(b, "dedupe_key|$2", ["cita:1"]))).toBeUndefined(); // otro negocio: sin problema
  });
});

describe("tareas: API", () => {
  it("sin sesión 401; datos inválidos 400; no se puede crear 'atención personal' a mano", async () => {
    const t = await register("api0");
    expect((await listWork(api("GET", "/api/work"))).status).toBe(401);
    expect((await createWork(api("POST", "/api/work", undefined, { type: "tarea", title: "x" }))).status).toBe(401);
    for (const bad of [{ type: "tarea", title: "" }, { type: "tarea", title: "  " }, { type: "atencion_humana", title: "x" }, { type: "tarea", title: "x", priority: 7 }, { type: "tarea", title: "x", dueAt: "mañana" }, { type: "tarea", title: "x", conversationId: "no-uuid" }, { type: "tarea", title: "x".repeat(201) }]) {
      expect((await createWork(api("POST", "/api/work", t.cookie, bad))).status, JSON.stringify(bad)).toBe(400);
    }
    // Origen distinto: bloqueado (CSRF).
    const evil = new Request(`${ORIGIN}/api/work`, { method: "POST", headers: { origin: "https://malo.example", "content-type": "application/json", cookie: t.cookie }, body: JSON.stringify({ type: "tarea", title: "x" }) });
    expect((await createWork(evil)).status).toBe(403);
    expect((await updateWork(api("POST", "/api/work/update", undefined, { id: randomUUID(), action: "resolve" }))).status).toBe(401);
  });

  it("crear a mano: queda 'manual', con quien la creó, con conversación y contacto si se indica", async () => {
    const t = await register("api1");
    const c = await customer(t, "hola", { name: "Luis" });
    const res = await createWork(api("POST", "/api/work", t.cookie, { type: "pago_por_verificar", title: "Pago de Luis", detail: "Ref 123", priority: 1, dueAt: "2026-12-01T15:00:00Z", conversationId: c.conv }));
    expect(res.status).toBe(201);
    const [row] = await items(t);
    expect(row).toMatchObject({ type: "pago_por_verificar", source: "manual", priority: 1, detail: "Ref 123", conversation_id: c.conv, contact_id: c.contact });
    expect(row.created_by).toBeTruthy();
    expect(row.due_at.toISOString()).toBe("2026-12-01T15:00:00.000Z");
    expect((await events(t, row.id))[0]).toMatchObject({ kind: "creado", actor_user_id: row.created_by });
  });

  it("una conversación de otro negocio -> 404 y no se crea nada", async () => {
    const a = await register("api2a");
    const b = await register("api2b");
    const ca = await customer(a);
    expect((await createWork(api("POST", "/api/work", b.cookie, { type: "tarea", title: "x", conversationId: ca.conv }))).status).toBe(404);
    expect(await items(b)).toHaveLength(0);
  });

  it("tope de 500 tareas manuales pendientes", async () => {
    const t = await register("api3");
    await withTenant(t.tenantId, (db) => db.query("INSERT INTO work_items (tenant_id, type, title, source) SELECT $1, 'tarea', 't' || g, 'manual' FROM generate_series(1, 500) g", [t.tenantId]));
    const res = await createWork(api("POST", "/api/work", t.cookie, { type: "tarea", title: "una más" }));
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("limite_tareas");
    // Resolver una libera cupo.
    await withTenant(t.tenantId, (db) => db.query("UPDATE work_items SET status = 'resuelto', resolved_at = now() WHERE id = (SELECT id FROM work_items LIMIT 1)"));
    expect((await createWork(api("POST", "/api/work", t.cookie, { type: "tarea", title: "una más" }))).status).toBe(201);
  });

  it("la lista va por urgencia: prioridad, luego fecha límite (las sin fecha al final) y cuenta por tipo", async () => {
    const t = await register("api4");
    const mk = (title: string, priority: number, due?: string, type = "tarea") => createWork(api("POST", "/api/work", t.cookie, { type, title, priority, ...(due ? { dueAt: due } : {}) }));
    await mk("D baja", 3);
    await mk("A normal sin fecha", 2);
    await mk("C normal con fecha", 2, "2026-11-01T10:00:00Z");
    await mk("B alta", 1, undefined, "seguimiento");
    await mk("B2 alta con fecha", 1, "2026-10-20T10:00:00Z", "seguimiento");
    const res = await (await listWork(api("GET", "/api/work", t.cookie))).json();
    expect(res.items.map((i: { title: string }) => i.title)).toEqual(["B2 alta con fecha", "B alta", "C normal con fecha", "A normal sin fecha", "D baja"]);
    expect(res.counts).toEqual({ tarea: 3, seguimiento: 2 });
    expect(res.items[0]).toMatchObject({ type: "seguimiento", priority: 1, assignedToMe: false, assigned: false });
  });

  it("empezar → resolver → reabrir, con responsable e historial", async () => {
    const t = await register("api5");
    await createWork(api("POST", "/api/work", t.cookie, { type: "tarea", title: "Cobrar" }));
    const id = (await items(t))[0].id as string;
    const act = (action: string) => updateWork(api("POST", "/api/work/update", t.cookie, { id, action }));

    expect((await act("start")).status).toBe(200);
    let list = await (await listWork(api("GET", "/api/work", t.cookie))).json();
    expect(list.items[0]).toMatchObject({ status: "en_proceso", assignedToMe: true });
    expect((await act("start")).status).toBe(409); // ya está en proceso
    expect((await act("reopen")).status).toBe(409); // no está cerrada

    expect((await act("resolve")).status).toBe(200);
    expect((await items(t))[0].resolved_by).toBeTruthy();
    expect((await act("resolve")).status).toBe(409);
    expect((await act("dismiss")).status).toBe(409);
    expect((await act("take")).status).toBe(409);
    list = await (await listWork(api("GET", "/api/work", t.cookie))).json();
    expect(list.items).toHaveLength(0);
    const done = await (await listWork(api("GET", "/api/work?scope=done", t.cookie))).json();
    expect(done.items).toHaveLength(1);
    expect(done.items[0].status).toBe("resuelto");

    expect((await act("reopen")).status).toBe(200);
    const [row] = await items(t);
    expect(row).toMatchObject({ status: "abierto", resolved_at: null, resolved_by: null });
    expect((await act("dismiss")).status).toBe(200);
    expect((await items(t))[0].status).toBe("descartado");

    const hist = (await events(t, id)).map((e) => `${e.kind}:${e.from_status ?? ""}>${e.to_status ?? ""}`);
    expect(hist).toEqual(["creado:>abierto", "estado:abierto>en_proceso", "asignado:>", "estado:en_proceso>resuelto", "estado:resuelto>abierto", "estado:abierto>descartado"]);
  });

  it("tomar y soltar una tarea", async () => {
    const t = await register("api6");
    await createWork(api("POST", "/api/work", t.cookie, { type: "tarea", title: "Llamar" }));
    const id = (await items(t))[0].id as string;
    expect((await updateWork(api("POST", "/api/work/update", t.cookie, { id, action: "take" }))).status).toBe(200);
    expect((await (await listWork(api("GET", "/api/work", t.cookie))).json()).items[0].assignedToMe).toBe(true);
    expect((await updateWork(api("POST", "/api/work/update", t.cookie, { id, action: "release" }))).status).toBe(200);
    expect((await (await listWork(api("GET", "/api/work", t.cookie))).json()).items[0].assigned).toBe(false);
  });

  it("no se puede tocar la tarea de otro negocio (404) ni con id inventado; acciones raras -> 400", async () => {
    const a = await register("api7a");
    const b = await register("api7b");
    await createWork(api("POST", "/api/work", a.cookie, { type: "tarea", title: "Mía" }));
    const id = (await items(a))[0].id as string;
    for (const action of ["start", "resolve", "dismiss", "take"]) {
      expect((await updateWork(api("POST", "/api/work/update", b.cookie, { id, action }))).status, action).toBe(404);
    }
    expect((await updateWork(api("POST", "/api/work/update", b.cookie, { id: randomUUID(), action: "resolve" }))).status).toBe(404);
    expect((await items(a))[0].status).toBe("abierto");
    expect((await updateWork(api("POST", "/api/work/update", a.cookie, { id, action: "borrar" }))).status).toBe(400);
    expect((await updateWork(api("POST", "/api/work/update", a.cookie, { id: "no-uuid", action: "resolve" }))).status).toBe(400);
    expect((await (await listWork(api("GET", "/api/work", b.cookie))).json()).items).toHaveLength(0);
  });

  it("reabrir una atención personal cuando ya hay otra abierta -> 409 sin romper nada", async () => {
    const t = await register("api8");
    const c = await customer(t);
    await handoff(t, c.conv, "pedido_de_persona");
    await setStatus(t, c.conv, "bot"); // resuelve la 1.ª
    await handoff(t, c.conv, "limite_diario"); // crea la 2.ª
    const first = (await items(t))[0].id as string;
    const res = await updateWork(api("POST", "/api/work/update", t.cookie, { id: first, action: "reopen" }));
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("tarea_duplicada");
    expect((await items(t)).map((r) => r.status)).toEqual(["resuelto", "abierto"]);
  });
});

describe("bandeja de conversaciones: API", () => {
  it("lista con vista previa, etiqueta y aviso de atención; los filtros separan por estado", async () => {
    const t = await register("inb1");
    const a = await customer(t, "Hola, ¿tienen disponibilidad?", { name: "Ana" });
    const b = await customer(t, "Quiero un humano", { name: "Beto" });
    const c = await customer(t, "gracias", { name: "Carla" });
    await handoff(t, b.conv, "pedido_de_persona");
    await setStatus(t, c.conv, "closed");
    const get = async (qs = "") => (await (await listConversations(api("GET", `/api/conversations${qs}`, t.cookie))).json()).conversations as { id: string; contact: { name: string; label: string }; lastPreview: string; needsAttention: boolean; status: string; lastDirection: string }[];

    const activas = await get();
    expect(activas.map((x) => x.contact.name).sort()).toEqual(["Ana", "Beto"]);
    expect(activas.find((x) => x.contact.name === "Ana")).toMatchObject({ lastPreview: "Hola, ¿tienen disponibilidad?", needsAttention: false, status: "bot", lastDirection: "in", contact: { label: "sin_clasificar" } });
    expect(activas.find((x) => x.contact.name === "Beto")).toMatchObject({ needsAttention: true, status: "human" });
    expect((await get("?filter=persona")).map((x) => x.contact.name)).toEqual(["Beto"]);
    expect((await get("?filter=asistente")).map((x) => x.contact.name)).toEqual(["Ana"]);
    expect((await get("?filter=cerradas")).map((x) => x.contact.name)).toEqual(["Carla"]);
    await updateConversation(api("POST", "/api/conversations/update", t.cookie, { id: a.conv, action: "label", label: "cliente" }));
    expect((await get("?label=cliente")).map((x) => x.contact.name)).toEqual(["Ana"]);
    expect((await get("?label=personal"))).toEqual([]);
    expect((await listConversations(api("GET", "/api/conversations?filter=otra", t.cookie))).status).toBe(400);
    expect((await listConversations(api("GET", "/api/conversations?label=rara", t.cookie))).status).toBe(400);
    expect((await listConversations(api("GET", "/api/conversations"))).status).toBe(401);
  });

  it("los mensajes que no son texto se muestran con su tipo; el orden es el más reciente primero", async () => {
    const t = await register("inb2");
    const a = await customer(t, "primero", { name: "Ana" });
    await customer(t, null, { name: "Beto", type: "image" });
    const list = (await (await listConversations(api("GET", "/api/conversations", t.cookie))).json()).conversations;
    expect(list.map((x: { contact: { name: string } }) => x.contact.name)).toEqual(["Beto", "Ana"]);
    expect(list[0].lastPreview).toBe("[Imagen]");
    expect(a.conv).toBeTruthy();
  });

  it("páginas de 40: 'before' trae las siguientes y no repite", async () => {
    const t = await register("inb3");
    for (let i = 0; i < 42; i++) await customer(t, `msg ${i}`, { name: `C${i}` });
    const p1 = await (await listConversations(api("GET", "/api/conversations", t.cookie))).json();
    expect(p1.conversations).toHaveLength(40);
    expect(p1.nextBefore).toBeTruthy();
    const p2 = await (await listConversations(api("GET", `/api/conversations?before=${encodeURIComponent(p1.nextBefore)}`, t.cookie))).json();
    expect(p2.conversations).toHaveLength(2);
    expect(p2.nextBefore).toBeNull();
    const ids = new Set([...p1.conversations, ...p2.conversations].map((x: { id: string }) => x.id));
    expect(ids.size).toBe(42);
  });

  it("aislamiento: cada negocio ve solo sus conversaciones", async () => {
    const a = await register("inb4a");
    const b = await register("inb4b");
    const ca = await customer(a, "secreto de A");
    expect((await (await listConversations(api("GET", "/api/conversations", b.cookie))).json()).conversations).toEqual([]);
    expect((await conversationDetail(api("GET", `/api/conversations/messages?id=${ca.conv}`, b.cookie))).status).toBe(404);
    expect((await updateConversation(api("POST", "/api/conversations/update", b.cookie, { id: ca.conv, action: "close" }))).status).toBe(404);
    expect((await updateConversation(api("POST", "/api/conversations/update", b.cookie, { id: ca.conv, action: "label", label: "personal" }))).status).toBe(404);
    expect((await items(a, "true"))).toHaveLength(0);
    const still = await withTenant(a.tenantId, async (db) => (await db.query("SELECT c.status, ct.label FROM conversations c JOIN contacts ct ON ct.id = c.contact_id")).rows[0]);
    expect(still).toEqual({ status: "bot", label: "sin_clasificar" });
  });

  it("detalle: mensajes en orden, tareas abiertas, estado y quién la tiene", async () => {
    const t = await register("det1");
    const c = await customer(t, "uno", { name: "Ana" });
    await customer(t, "dos", { name: "Ana", waId: c.waId });
    await customer(t, "tres", { name: "Ana", waId: c.waId });
    await withTenant(t.tenantId, (db) => db.query("INSERT INTO messages (tenant_id, conversation_id, direction, body, send_state, wa_message_id) VALUES ($1,$2,'out','respuesta del asistente','sent',$3)", [t.tenantId, c.conv, `wamid.out.${randomUUID()}`]));
    await handoff(t, c.conv, "pedido_de_persona");
    const d = await (await conversationDetail(api("GET", `/api/conversations/messages?id=${c.conv}`, t.cookie))).json();
    expect(d.conversation).toMatchObject({ id: c.conv, status: "human", handoffReason: "pedido_de_persona", assignedToMe: false, contact: { name: "Ana", label: "sin_clasificar", waId: c.waId } });
    expect(d.messages.map((m: { body: string }) => m.body)).toEqual(["uno", "dos", "tres", "respuesta del asistente"]);
    expect(d.messages[3]).toMatchObject({ direction: "out", sendState: "sent" });
    expect(d.work).toHaveLength(1);
    expect(d.work[0]).toMatchObject({ type: "atencion_humana", status: "abierto" });
    expect((await conversationDetail(api("GET", "/api/conversations/messages?id=no-uuid", t.cookie))).status).toBe(400);
    expect((await conversationDetail(api("GET", `/api/conversations/messages?id=${randomUUID()}`, t.cookie))).status).toBe(404);
    expect((await conversationDetail(api("GET", `/api/conversations/messages?id=${c.conv}`))).status).toBe(401);
  });

  it("el detalle trae solo los últimos 100 mensajes, en orden", async () => {
    const t = await register("det2");
    const c = await customer(t, "m0");
    await withTenant(t.tenantId, (db) =>
      db.query(`INSERT INTO messages (tenant_id, conversation_id, direction, body, received_at)
                SELECT $1, $2, 'in', 'm' || g, now() + g * interval '1 second' FROM generate_series(1, 120) g`, [t.tenantId, c.conv]));
    const d = await (await conversationDetail(api("GET", `/api/conversations/messages?id=${c.conv}`, t.cookie))).json();
    expect(d.messages).toHaveLength(100);
    expect(d.messages[0].body).toBe("m21");
    expect(d.messages[99].body).toBe("m120");
  });

  it("tomar, devolver y cerrar; no se toma una cerrada; devolver solo si está con una persona", async () => {
    const t = await register("act1");
    const c = await customer(t);
    const act = (body: object) => updateConversation(api("POST", "/api/conversations/update", t.cookie, { id: c.conv, ...body }));
    const state = () => withTenant(t.tenantId, async (db) => (await db.query("SELECT status, handoff_reason, assigned_to FROM conversations WHERE id = $1", [c.conv])).rows[0]);

    expect((await act({ action: "release" })).status).toBe(409); // ya está con el asistente
    expect((await act({ action: "take" })).status).toBe(200);
    expect(await state()).toMatchObject({ status: "human", handoff_reason: "tomada_por_persona" });
    expect((await state()).assigned_to).toBeTruthy();
    expect(await items(t)).toHaveLength(0); // tomarla uno mismo no genera tarea
    expect((await act({ action: "release" })).status).toBe(200);
    expect(await state()).toMatchObject({ status: "bot", handoff_reason: null, assigned_to: null });
    expect((await act({ action: "close" })).status).toBe(200);
    expect((await act({ action: "close" })).status).toBe(200); // idempotente
    expect((await act({ action: "take" })).status).toBe(409);
    expect((await act({ action: "release" })).status).toBe(409);
    expect((await act({ action: "label", label: "inexistente" })).status).toBe(400);
    expect((await act({ action: "otra" })).status).toBe(400);
  });

  it("tomar una conversación que el asistente pasó a una persona la deja asignada, conserva el motivo y mantiene la tarea", async () => {
    const t = await register("act2");
    const c = await customer(t);
    await handoff(t, c.conv, "limite_diario");
    expect((await updateConversation(api("POST", "/api/conversations/update", t.cookie, { id: c.conv, action: "take" }))).status).toBe(200);
    const d = await (await conversationDetail(api("GET", `/api/conversations/messages?id=${c.conv}`, t.cookie))).json();
    expect(d.conversation).toMatchObject({ status: "human", handoffReason: "limite_diario", assignedToMe: true });
    expect(d.work).toHaveLength(1);
    // Devolverla al asistente cierra la tarea de atención.
    await updateConversation(api("POST", "/api/conversations/update", t.cookie, { id: c.conv, action: "release" }));
    expect((await items(t))[0].status).toBe("resuelto");
  });

  it("cerrar una conversación con atención pendiente resuelve la tarea; el cliente que vuelve a escribir abre una nueva", async () => {
    const t = await register("act3");
    const c = await customer(t);
    await handoff(t, c.conv, "pedido_de_persona");
    await updateConversation(api("POST", "/api/conversations/update", t.cookie, { id: c.conv, action: "close" }));
    expect((await items(t))[0].status).toBe("resuelto");
    const again = await customer(t, "hola otra vez", { waId: c.waId });
    expect(again.conv).not.toBe(c.conv);
  });

  it("la etiqueta cambia al contacto (no a la conversación) y vale para todas sus conversaciones", async () => {
    const t = await register("lab1");
    const c = await customer(t);
    await updateConversation(api("POST", "/api/conversations/update", t.cookie, { id: c.conv, action: "label", label: "prospecto" }));
    await updateConversation(api("POST", "/api/conversations/update", t.cookie, { id: c.conv, action: "close" }));
    const again = await customer(t, "hola", { waId: c.waId });
    const d = await (await conversationDetail(api("GET", `/api/conversations/messages?id=${again.conv}`, t.cookie))).json();
    expect(d.conversation.contact.label).toBe("prospecto");
  });
});

describe("agente + centro de trabajo", () => {
  const sent = (): SendResult => ({ kind: "sent", waMessageId: `wamid.out.${randomUUID()}` });
  function deps(text = "Hola, abrimos de 8am a 5pm.") {
    const llm = { name: "stub", generate: vi.fn(async () => ({ text, inputTokens: 1, outputTokens: 1, model: "stub" })) };
    const send = vi.fn(async (...args: unknown[]) => (void args, sent()));
    return { llm, send, raw: { llm: llm as unknown as LlmProvider, send: send as never } };
  }
  const outCount = (t: T) => withTenant(t.tenantId, async (db) => (await db.query("SELECT count(*)::int AS n FROM messages WHERE direction = 'out'")).rows[0].n as number);

  it("a un contacto 'personal' el asistente NO le responde (ni gasta IA); si se reclasifica, vuelve a responder", async () => {
    const t = await register("ag1", { agent: true });
    const c = await customer(t, "hola mami", { name: "Mamá" });
    await updateConversation(api("POST", "/api/conversations/update", t.cookie, { id: c.conv, action: "label", label: "personal" }));
    const d = deps();
    expect(await runAgent({ tenantId: t.tenantId, messageId: c.messageId }, d.raw)).toBe("skipped_personal");
    expect(d.llm.generate).not.toHaveBeenCalled();
    expect(d.send).not.toHaveBeenCalled();
    expect(await outCount(t)).toBe(0);
    expect(await items(t)).toHaveLength(0);

    await updateConversation(api("POST", "/api/conversations/update", t.cookie, { id: c.conv, action: "label", label: "cliente" }));
    expect(await runAgent({ tenantId: t.tenantId, messageId: c.messageId }, d.raw)).toBe("replied");
    expect(d.send).toHaveBeenCalledTimes(1);
  });

  it("si el cliente pide una persona, el asistente la pasa y aparece la tarea en la cola", async () => {
    const t = await register("ag2", { agent: true });
    const c = await customer(t, "quiero hablar con una persona, por favor", { name: "Pedro" });
    const d = deps();
    expect(await runAgent({ tenantId: t.tenantId, messageId: c.messageId }, d.raw)).toBe("handoff");
    const list = await (await listWork(api("GET", "/api/work", t.cookie))).json();
    expect(list.items).toHaveLength(1);
    expect(list.items[0]).toMatchObject({ type: "atencion_humana", priority: 1, title: "Atender a Pedro", conversationId: c.conv, source: "agente" });
    // Mientras una persona la tiene, el asistente calla.
    const m2 = await customer(t, "¿hola?", { waId: c.waId });
    expect(await runAgent({ tenantId: t.tenantId, messageId: m2.messageId }, d.raw)).toBe("skipped_human");
    // Al devolverla al asistente, la tarea se cierra y el asistente vuelve a responder.
    await updateConversation(api("POST", "/api/conversations/update", t.cookie, { id: c.conv, action: "release" }));
    expect((await (await listWork(api("GET", "/api/work", t.cookie))).json()).items).toHaveLength(0);
    const m3 = await customer(t, "¿a qué hora abren?", { waId: c.waId });
    expect(await runAgent({ tenantId: t.tenantId, messageId: m3.messageId }, d.raw)).toBe("replied");
  });
});
EOF_TESTS_WORK_TEST_TS
echo "✔ tests/work.test.ts"
mkdir -p tests
cat > tests/work-time.test.ts <<'EOF_TESTS_WORK-TIME_TEST_TS'
import { describe, expect, it } from "vitest";
import { dueInfo, messageTime, relativeTime } from "@/lib/work/time";

// 11 de octubre de 2026, 12:00 (hora local de quien corre la prueba).
const NOW = new Date(2026, 9, 11, 12, 0, 0).getTime();
const ago = (ms: number) => new Date(NOW - ms).toISOString();
const MIN = 60_000, HOUR = 60 * MIN, DAY = 24 * HOUR;

describe("relativeTime", () => {
  it("escala: ahora, minutos, horas, días y fecha", () => {
    expect(relativeTime(ago(10_000), NOW)).toBe("ahora");
    expect(relativeTime(ago(MIN), NOW)).toBe("hace 1 min");
    expect(relativeTime(ago(59 * MIN), NOW)).toBe("hace 59 min");
    expect(relativeTime(ago(HOUR), NOW)).toBe("hace 1 h");
    expect(relativeTime(ago(23 * HOUR), NOW)).toBe("hace 23 h");
    expect(relativeTime(ago(DAY), NOW)).toBe("hace 1 día");
    expect(relativeTime(ago(3 * DAY), NOW)).toBe("hace 3 días");
    expect(relativeTime(ago(30 * DAY), NOW)).toMatch(/\d/); // una fecha, p. ej. "11 sept"
    expect(relativeTime(ago(30 * DAY), NOW)).not.toContain("hace");
  });
  it("tolera vacío, basura y fechas del futuro", () => {
    expect(relativeTime(null, NOW)).toBe("");
    expect(relativeTime(undefined, NOW)).toBe("");
    expect(relativeTime("no es fecha", NOW)).toBe("");
    expect(relativeTime(new Date(NOW + 10 * MIN), NOW)).toBe("en el futuro");
    expect(relativeTime(new Date(NOW + 10_000), NOW)).toBe("ahora"); // reloj desfasado unos segundos
  });
});

describe("dueInfo", () => {
  it("atrasada: lo dice y la marca", () => {
    expect(dueInfo(ago(2 * HOUR), NOW)).toEqual({ text: "Venció hace 2 h", overdue: true });
  });
  it("hoy o más adelante: no está atrasada", () => {
    const today = dueInfo(new Date(2026, 9, 11, 15, 0).toISOString(), NOW)!;
    expect(today.overdue).toBe(false);
    expect(today.text.startsWith("Vence hoy, ")).toBe(true);
    const later = dueInfo(new Date(2026, 9, 14, 10, 0).toISOString(), NOW)!;
    expect(later.overdue).toBe(false);
    expect(later.text.startsWith("Vence el ")).toBe(true);
  });
  it("sin fecha o inválida -> nada", () => {
    expect(dueInfo(null, NOW)).toBeNull();
    expect(dueInfo("x", NOW)).toBeNull();
  });
});

describe("messageTime", () => {
  it("hoy solo la hora; otro día, fecha y hora", () => {
    const today = messageTime(new Date(2026, 9, 11, 9, 5).toISOString(), NOW);
    const other = messageTime(new Date(2026, 9, 5, 9, 5).toISOString(), NOW);
    expect(today).not.toContain(",");
    expect(other).toContain(",");
    expect(messageTime("x", NOW)).toBe("");
  });
});
EOF_TESTS_WORK-TIME_TEST_TS
echo "✔ tests/work-time.test.ts"

cat <<'FIN'

══════════════════════════════════════════════════════════
 Paso 11A aplicado. Ahora, en este orden:

   1) Abre Docker Desktop y:   npm run db:up
   2) npm run db:migrate       # aplica 0010 (tareas, historial, tipo de contacto)
   3) npm run typecheck && npm run lint && npm test
   4) npm run dev:all          # reinícialo
   5) Prueba:
        - Entra a «Conversaciones» y «Hoy» (están en el menú de arriba).
        - En /simulador escribe «quiero hablar con una persona»: debe aparecer una tarea
          «Atender a …» en Hoy y la conversación con el aviso «Necesita atención».
        - En la conversación: «Tomar la conversación», cambiar el «Tipo de contacto» a Personal
          (el asistente deja de responderle) y «Devolver al asistente» (la tarea se cierra sola).

   Importante: todavía NO se puede responder al cliente desde aquí; eso es el Paso 11B.
══════════════════════════════════════════════════════════
FIN