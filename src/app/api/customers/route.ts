import { z } from "zod";
import { requireTenant } from "@/lib/auth/guard";
import { errorResponse, jsonResponse, route } from "@/lib/auth/http";
import { withTenant } from "@/lib/db";
import { likeEscape } from "@/lib/customers/tags";
import { CONTACT_LABELS } from "@/lib/work/labels";

const PAGE = 30;

const querySchema = z.object({
  q: z.string().trim().max(60).optional(),
  tag: z.string().trim().max(30).optional(),
  label: z.enum(CONTACT_LABELS).optional(),
  baja: z.enum(["1"]).optional(),
  permiso: z.enum(["si", "no"]).optional(),
  page: z.coerce.number().int().min(1).max(1000).default(1),
});

/** Lista de clientes: los que escribieron más recientemente primero. Filtra por texto, etiqueta, tipo o «dieron de baja». */
export const GET = route(async (req) => {
  const auth = await requireTenant(req, "contacts:read");
  if (!auth.ok) return auth.response;
  const sp = new URL(req.url).searchParams;
  const q = querySchema.safeParse(Object.fromEntries(["q", "tag", "label", "baja", "permiso", "page"].map((k) => [k, sp.get(k) ?? undefined])));
  if (!q.success) return errorResponse(400, "datos_invalidos", "Filtro inválido.");
  const { tenantId } = auth.ctx;
  const f = q.data;

  const data = await withTenant(tenantId, async (db) => {
    const params: unknown[] = [tenantId];
    let where = "c.tenant_id = $1";
    if (f.q) {
      params.push(`%${likeEscape(f.q)}%`);
      const digits = f.q.replace(/\D/g, "");
      params.push(digits.length >= 3 ? `%${digits}%` : null);
      where += ` AND (c.display_name ILIKE $${params.length - 1} ESCAPE '\\' OR ($${params.length}::text IS NOT NULL AND c.wa_id LIKE $${params.length}))`;
    }
    if (f.tag) { params.push(f.tag); where += ` AND EXISTS (SELECT 1 FROM unnest(c.tags) t WHERE lower(t) = lower($${params.length}))`; }
    if (f.label) { params.push(f.label); where += ` AND c.label = $${params.length}`; }
    if (f.baja) where += " AND c.notifications_off";
    if (f.permiso) where += f.permiso === "si" ? " AND c.promo_consent_at IS NOT NULL" : " AND c.promo_consent_at IS NULL";
    const total = await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM contacts c WHERE ${where}`, params);
    params.push(PAGE + 1, (f.page - 1) * PAGE);
    const rows = await db.query(
      `SELECT c.id, c.wa_id, c.display_name, c.label, c.tags, c.notifications_off, c.promo_consent_at, c.created_at,
              (SELECT max(v.last_message_at) FROM conversations v WHERE v.tenant_id = c.tenant_id AND v.contact_id = c.id) AS last_message_at
         FROM contacts c WHERE ${where}
        ORDER BY COALESCE((SELECT max(v.last_message_at) FROM conversations v WHERE v.tenant_id = c.tenant_id AND v.contact_id = c.id), c.created_at) DESC, c.id
        LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    );
    // Pedidos y citas de solo estas filas. Los hechos a mano sin vincular se reconocen por el teléfono (igual que en la ficha).
    const page = rows.rows.slice(0, PAGE);
    const ids = page.map((c) => c.id as string);
    const wa = page.map((c) => c.wa_id as string);
    const counts = async (table: "orders" | "appointments", active: string) => {
      const r = await db.query<{ id: string; n: number }>(
        `SELECT p.id, count(*)::int AS n FROM unnest($2::uuid[], $3::text[]) AS p(id, wa)
           JOIN ${table} x ON x.tenant_id = $1 AND x.status IN (${active})
            AND (x.contact_id = p.id OR (x.contact_id IS NULL AND regexp_replace(COALESCE(x.customer_phone, ''), '\\D', '', 'g') = p.wa))
          GROUP BY p.id`,
        [tenantId, ids, wa],
      );
      return new Map(r.rows.map((x) => [x.id, x.n]));
    };
    const orderCount = ids.length ? await counts("orders", "'pendiente', 'confirmado', 'entregado'") : new Map<string, number>();
    const apptCount = ids.length ? await counts("appointments", "'pendiente', 'confirmada', 'completada'") : new Map<string, number>();
    const tags = await db.query<{ t: string; n: number }>(
      "SELECT min(t) AS t, count(*)::int AS n FROM contacts c, unnest(c.tags) t WHERE c.tenant_id = $1 GROUP BY lower(t) ORDER BY n DESC, lower(t) LIMIT 40",
      [tenantId],
    );
    return { total: total.rows[0]!.n, rows: rows.rows, tags: tags.rows, orderCount, apptCount };
  });

  return jsonResponse({
    total: data.total,
    more: data.rows.length > PAGE,
    page: f.page,
    tags: data.tags.map((t) => ({ tag: t.t, count: t.n })),
    customers: data.rows.slice(0, PAGE).map((c) => ({
      id: c.id, name: (c.display_name as string | null) || null, waId: c.wa_id, label: c.label, tags: c.tags as string[],
      optedOut: c.notifications_off, consent: c.promo_consent_at !== null, createdAt: c.created_at, lastMessageAt: c.last_message_at,
      orders: data.orderCount.get(c.id as string) ?? 0, appointments: data.apptCount.get(c.id as string) ?? 0,
    })),
  });
});
