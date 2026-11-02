import { z } from "zod";
import { requireTenant } from "@/lib/auth/guard";
import { errorResponse, jsonResponse, route } from "@/lib/auth/http";
import { withTenant } from "@/lib/db";

const HISTORY = 20;

/** La ficha: datos del cliente y su historial (conversaciones, pedidos y citas). */
export const GET = route(async (req) => {
  const auth = await requireTenant(req, "contacts:read");
  if (!auth.ok) return auth.response;
  const id = z.uuid().safeParse(new URL(req.url).searchParams.get("id"));
  if (!id.success) return errorResponse(400, "datos_invalidos", "Cliente inválido.");
  const { tenantId } = auth.ctx;

  const data = await withTenant(tenantId, async (db) => {
    const c = await db.query(
      "SELECT id, wa_id, display_name, label, tags, notes, notifications_off, promo_consent_at, promo_consent_source, created_at, updated_at, origin_type, origin_url, origin_headline FROM contacts WHERE tenant_id = $1 AND id = $2",
      [tenantId, id.data],
    );
    if (c.rowCount !== 1) return null;
    const contact = c.rows[0]!;
    const convs = await db.query(
      `SELECT v.id, v.status, v.last_message_at, v.created_at,
              (SELECT left(m.body, 140) FROM messages m WHERE m.tenant_id = v.tenant_id AND m.conversation_id = v.id AND m.body IS NOT NULL ORDER BY m.received_at DESC, m.id DESC LIMIT 1) AS last_body
         FROM conversations v WHERE v.tenant_id = $1 AND v.contact_id = $2 ORDER BY v.last_message_at DESC NULLS LAST LIMIT $3`,
      [tenantId, id.data, HISTORY],
    );
    // Pedidos y citas hechos a mano sin vincular al contacto se reconocen por el teléfono.
    const orders = await db.query(
      `SELECT o.id, o.number, o.status, o.currency, o.total_minor, o.created_at,
              (SELECT string_agg(i.quantity || ' x ' || i.name, ', ' ORDER BY i.position) FROM order_items i WHERE i.tenant_id = o.tenant_id AND i.order_id = o.id) AS items
         FROM orders o WHERE o.tenant_id = $1 AND (o.contact_id = $2 OR (o.contact_id IS NULL AND regexp_replace(COALESCE(o.customer_phone, ''), '\\D', '', 'g') = $3))
        ORDER BY o.number DESC LIMIT $4`,
      [tenantId, id.data, contact.wa_id, HISTORY],
    );
    const spent = await db.query(
      `SELECT currency, sum(total_minor)::bigint AS total, count(*)::int AS n FROM orders
        WHERE tenant_id = $1 AND status IN ('confirmado', 'entregado') AND (contact_id = $2 OR (contact_id IS NULL AND regexp_replace(COALESCE(customer_phone, ''), '\\D', '', 'g') = $3))
        GROUP BY currency ORDER BY currency`,
      [tenantId, id.data, contact.wa_id],
    );
    const appts = await db.query(
      `SELECT a.id, a.starts_at, a.status, s.name AS service
         FROM appointments a JOIN agenda_services s ON s.tenant_id = a.tenant_id AND s.id = a.service_id
        WHERE a.tenant_id = $1 AND (a.contact_id = $2 OR (a.contact_id IS NULL AND regexp_replace(COALESCE(a.customer_phone, ''), '\\D', '', 'g') = $3))
        ORDER BY a.starts_at DESC LIMIT $4`,
      [tenantId, id.data, contact.wa_id, HISTORY],
    );
    const msgs = await db.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM messages m JOIN conversations v ON v.tenant_id = m.tenant_id AND v.id = m.conversation_id WHERE m.tenant_id = $1 AND v.contact_id = $2 AND m.direction = 'in'",
      [tenantId, id.data],
    );
    return { contact, convs: convs.rows, orders: orders.rows, spent: spent.rows, appts: appts.rows, inbound: msgs.rows[0]!.n };
  });
  if (!data) return errorResponse(404, "no_encontrado", "No encontrado.");

  const c = data.contact;
  return jsonResponse({
    customer: {
      id: c.id, name: (c.display_name as string | null) || null, waId: c.wa_id, label: c.label, tags: c.tags as string[], notes: (c.notes as string | null) ?? "",
      optedOut: c.notifications_off, consentAt: c.promo_consent_at, consentSource: c.promo_consent_source, createdAt: c.created_at, updatedAt: c.updated_at, messagesReceived: data.inbound,
      origin: c.origin_type ? { type: c.origin_type as "anuncio" | "publicacion", url: (c.origin_url as string | null) ?? null, headline: (c.origin_headline as string | null) ?? null } : null,
    },
    spent: data.spent.map((s) => ({ currency: s.currency, totalMinor: Number(s.total), orders: s.n })),
    conversations: data.convs.map((v) => ({ id: v.id, status: v.status, lastMessageAt: v.last_message_at, createdAt: v.created_at, lastBody: v.last_body })),
    orders: data.orders.map((o) => ({ id: o.id, number: o.number, status: o.status, currency: o.currency, totalMinor: Number(o.total_minor), createdAt: o.created_at, items: o.items })),
    appointments: data.appts.map((a) => ({ id: a.id, startsAt: a.starts_at, status: a.status, service: a.service })),
  });
});
