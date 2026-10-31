import { z } from "zod";

/** Tope de destinatarios por difusión (más grande se parte en varias, para no quemar el número). */
export const MAX_RECIPIENTS = 2000;
/** No se le escribe a quien ya recibió una difusión en estos días. */
export const RECENT_DAYS = 3;

export const audienceSchema = z.object({
  tag: z.string().trim().min(1).max(30).optional(),
  label: z.enum(["sin_clasificar", "cliente", "prospecto"]).optional(),
  /** Reenviar a quienes recibieron otra difusión y no la leyeron / no respondieron. */
  from: z.object({ broadcastId: z.uuid(), who: z.enum(["no_leyeron", "no_respondieron"]) }).optional(),
}).strict();
export type Audience = z.infer<typeof audienceSchema>;

export const WHY_TEXT: Record<string, string> = {
  sin_permiso: "no tienen permiso para promociones registrado",
  baja: "pidieron no recibir avisos",
  personal: "están marcados como «personal»",
  con_persona: "los está atendiendo una persona ahora",
  reciente: `recibieron otra difusión en los últimos ${RECENT_DAYS} días`,
  numero: "tienen un número inválido",
};

interface Db { query: <R extends Record<string, unknown> = Record<string, unknown>>(sql: string, params?: unknown[]) => Promise<{ rows: R[] }> }

/** SQL común: `k` trae cada contacto que cumple los filtros y `why` (NULL = se le puede escribir; si no, el motivo de exclusión). */
function buildSql(tenantId: string, a: Audience): { cte: string; params: unknown[] } {
  const params: unknown[] = [tenantId, RECENT_DAYS];
  let where = "c.tenant_id = $1";
  if (a.tag) { params.push(a.tag); where += ` AND EXISTS (SELECT 1 FROM unnest(c.tags) t WHERE lower(t) = lower($${params.length}))`; }
  if (a.label) { params.push(a.label); where += ` AND c.label = $${params.length}`; }
  let recentSkip = "";
  if (a.from) {
    params.push(a.from.broadcastId);
    const b = `$${params.length}`;
    const who = a.from.who === "no_leyeron"
      ? "fm.delivery_status IS DISTINCT FROM 'read'"
      : "NOT EXISTS (SELECT 1 FROM messages im WHERE im.tenant_id = fr.tenant_id AND im.conversation_id = fm.conversation_id AND im.direction = 'in' AND im.created_at > fr.sent_at)";
    where += ` AND EXISTS (SELECT 1 FROM broadcast_recipients fr LEFT JOIN messages fm ON fm.tenant_id = fr.tenant_id AND fm.id = fr.message_id
                            WHERE fr.tenant_id = $1 AND fr.broadcast_id = ${b} AND fr.contact_id = c.id AND fr.status = 'enviado' AND ${who})`;
    recentSkip = ` AND r.broadcast_id <> ${b}`;
  }
  const cte = `WITH k AS (
    SELECT c.id, c.display_name, c.wa_id,
      CASE WHEN c.promo_consent_at IS NULL THEN 'sin_permiso'
           WHEN c.notifications_off THEN 'baja'
           WHEN c.label = 'personal' THEN 'personal'
           WHEN c.wa_id !~ '^[0-9]{5,32}$' THEN 'numero'
           WHEN EXISTS (SELECT 1 FROM conversations v WHERE v.tenant_id = c.tenant_id AND v.contact_id = c.id AND v.status = 'human') THEN 'con_persona'
           WHEN EXISTS (SELECT 1 FROM broadcast_recipients r WHERE r.tenant_id = c.tenant_id AND r.contact_id = c.id AND r.status = 'enviado'
                          AND r.sent_at > now() - make_interval(days => $2)${recentSkip}) THEN 'reciente'
      END AS why
    FROM contacts c WHERE ${where})`;
  return { cte, params };
}

export interface Preview {
  matched: number;
  eligible: number;
  excluded: Record<string, number>;
  sample: string[];
}

/** Cuántas personas cumplen el filtro, cuántas recibirían la difusión y por qué se excluye al resto. */
export async function previewAudience(db: Db, tenantId: string, a: Audience): Promise<Preview> {
  const { cte, params } = buildSql(tenantId, a);
  const c = await db.query<Record<string, number>>(
    `${cte} SELECT count(*)::int AS matched, count(*) FILTER (WHERE why IS NULL)::int AS eligible,
            count(*) FILTER (WHERE why = 'sin_permiso')::int AS sin_permiso, count(*) FILTER (WHERE why = 'baja')::int AS baja,
            count(*) FILTER (WHERE why = 'personal')::int AS personal, count(*) FILTER (WHERE why = 'con_persona')::int AS con_persona,
            count(*) FILTER (WHERE why = 'reciente')::int AS reciente, count(*) FILTER (WHERE why = 'numero')::int AS numero FROM k`, params);
  const s = await db.query<{ n: string }>(`${cte} SELECT COALESCE(NULLIF(display_name, ''), '+' || wa_id) AS n FROM k WHERE why IS NULL ORDER BY id LIMIT 5`, params);
  const r = c.rows[0]!;
  const excluded: Record<string, number> = {};
  for (const key of Object.keys(WHY_TEXT)) if (r[key]) excluded[key] = r[key]!;
  return { matched: r.matched!, eligible: r.eligible!, excluded, sample: s.rows.map((x) => x.n) };
}

/** Ids de las personas a las que se les puede escribir (hasta MAX_RECIPIENTS). */
export async function eligibleIds(db: Db, tenantId: string, a: Audience): Promise<string[]> {
  const { cte, params } = buildSql(tenantId, a);
  const r = await db.query<{ id: string }>(`${cte} SELECT id FROM k WHERE why IS NULL ORDER BY id LIMIT ${MAX_RECIPIENTS + 1}`, params);
  return r.rows.map((x) => x.id);
}
