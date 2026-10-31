import { requireTenant } from "@/lib/auth/guard";
import { errorResponse, route } from "@/lib/auth/http";
import { withTenant } from "@/lib/db";
import { csvDownload, phoneCell, type CsvFormat } from "@/lib/csv/write";
import type { Permission } from "@/lib/auth/permissions";
import { CONSENT_SOURCE_TEXT, type ConsentSource } from "@/lib/customers/tags";
import { CONTACT_LABEL_TEXT as LABEL, type ContactLabel } from "@/lib/work/labels";

const MAX_ROWS = 50_000;
const KINDS = { clientes: "contacts:manage", pedidos: "orders:read", citas: "agenda:read", productos: "catalog:manage" } as const satisfies Record<string, Permission>;
type Kind = keyof typeof KINDS;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

const ORDER_STATUS: Record<string, string> = { pendiente: "Pendiente", confirmado: "Confirmado", entregado: "Entregado", cancelado: "Cancelado" };
const APPT_STATUS: Record<string, string> = { pendiente: "Pendiente", confirmada: "Confirmada", cancelada: "Cancelada", completada: "Completada", no_asistio: "No asistió" };
const SOURCE: Record<string, string> = { manual: "Manual", agente: "Asistente" };

/**
 * Descarga de datos del negocio en CSV. ?que=clientes|pedidos|citas|productos  &formato=excel|csv  (pedidos y citas: &desde=AAAA-MM-DD&hasta=AAAA-MM-DD).
 * «excel» usa punto y coma (para que Excel en español separe las columnas); «csv» usa coma. Quedan registrados en la auditoría.
 */
export const GET = route(async (req) => {
  const u = new URL(req.url);
  const que = u.searchParams.get("que") as Kind | null;
  if (!que || !(que in KINDS)) return errorResponse(400, "datos_invalidos", "Elige qué descargar: clientes, pedidos, citas o productos.");
  const format: CsvFormat = u.searchParams.get("formato") === "csv" ? "csv" : "excel";
  const desde = u.searchParams.get("desde") ?? "";
  const hasta = u.searchParams.get("hasta") ?? "";
  if ((desde && !DAY.test(desde)) || (hasta && !DAY.test(hasta))) return errorResponse(400, "datos_invalidos", "Las fechas deben ser AAAA-MM-DD.");
  const auth = await requireTenant(req, KINDS[que]);
  if (!auth.ok) return auth.response;
  const { tenantId } = auth.ctx;
  /** Dinero entero (unidad menor) → «12.50» (csv) o «12,50» (Excel en español). */
  const money = (minor: unknown) => (Number(minor) / 100).toFixed(2).replace(".", format === "excel" ? "," : ".");
  const stamp = new Date().toISOString().slice(0, 10);

  const { header, rows } = await withTenant(tenantId, async (db) => {
    const tzr = await db.query("SELECT timezone FROM agenda_settings WHERE tenant_id = $1", [tenantId]);
    const tz: string = tzr.rows[0]?.timezone ?? "America/Caracas";
    // Fechas «desde/hasta» en la hora del negocio; «hasta» incluye todo ese día.
    // $1 = negocio, $2 = zona horaria (solo se envía si hay fechas), $3 y $4 = fechas.
    const range = (col: string) => {
      const w: string[] = []; const p: unknown[] = [];
      if (desde) { p.push(desde); w.push(`${col} >= ($${p.length + 2}::date)::timestamp AT TIME ZONE $2`); }
      if (hasta) { p.push(hasta); w.push(`${col} < (($${p.length + 2}::date + 1)::timestamp) AT TIME ZONE $2`); }
      return { sql: w.length ? " AND " + w.join(" AND ") : "", args: w.length ? [tz, ...p] : [] };
    };
    let header: string[]; let rows: unknown[][];
    if (que === "clientes") {
      const r = await db.query(
        `SELECT c.display_name, c.wa_id, c.created_at, c.label, c.tags, c.notes, c.notifications_off, c.promo_consent_at, c.promo_consent_source,
                (SELECT count(*)::int FROM orders o WHERE o.tenant_id = c.tenant_id AND o.contact_id = c.id) AS pedidos,
                (SELECT count(*)::int FROM appointments a WHERE a.tenant_id = c.tenant_id AND a.contact_id = c.id) AS citas
           FROM contacts c WHERE c.tenant_id = $1 ORDER BY c.created_at DESC LIMIT ${MAX_ROWS}`, [tenantId]);
      header = ["Nombre", "Teléfono (WhatsApp)", `Primer contacto (${tz})`, "Tipo", "Etiquetas", "Nota", "No recibir avisos", "Permiso para promociones", "Pedidos", "Citas"];
      rows = r.rows.map((x) => [x.display_name, phoneCell(x.wa_id), new Date(x.created_at).toLocaleString("sv-SE", { timeZone: tz }).slice(0, 16), LABEL[x.label as ContactLabel] ?? x.label, (x.tags as string[]).join("; "), x.notes, x.notifications_off ? "Sí" : "No", x.promo_consent_at ? `Sí (${new Date(x.promo_consent_at).toLocaleDateString("sv-SE", { timeZone: tz })}, ${CONSENT_SOURCE_TEXT[x.promo_consent_source as ConsentSource] ?? x.promo_consent_source})` : "No", x.pedidos, x.citas]);
    } else if (que === "pedidos") {
      const rg = range("o.created_at");
      const r = await db.query(
        `SELECT o.number, o.created_at, o.customer_name, o.customer_phone, o.status, o.source, o.currency, o.total_minor, o.notes, o.delivery_note,
                (SELECT string_agg(i.quantity || ' x ' || i.name, '; ' ORDER BY i.position) FROM order_items i WHERE i.tenant_id = o.tenant_id AND i.order_id = o.id) AS items
           FROM orders o WHERE o.tenant_id = $1${rg.sql} ORDER BY o.number DESC LIMIT ${MAX_ROWS}`, [tenantId, ...rg.args]);
      header = ["Número", `Fecha (${tz})`, "Cliente", "Teléfono", "Estado", "Origen", "Moneda", "Total", "Productos", "Notas", "Entrega"];
      rows = r.rows.map((x) => [x.number, new Date(x.created_at).toLocaleString("sv-SE", { timeZone: tz }).slice(0, 16), x.customer_name, phoneCell(x.customer_phone), ORDER_STATUS[x.status] ?? x.status, SOURCE[x.source] ?? x.source, x.currency, money(x.total_minor), x.items, x.notes, x.delivery_note]);
    } else if (que === "citas") {
      const rg = range("a.starts_at");
      const r = await db.query(
        `SELECT a.starts_at, a.ends_at, s.name AS service, a.customer_name, a.customer_phone, a.status, a.source, a.notes
           FROM appointments a JOIN agenda_services s ON s.tenant_id = a.tenant_id AND s.id = a.service_id
          WHERE a.tenant_id = $1${rg.sql} ORDER BY a.starts_at DESC LIMIT ${MAX_ROWS}`, [tenantId, ...rg.args]);
      const fmt = (d: Date) => new Date(d).toLocaleString("sv-SE", { timeZone: tz }).slice(0, 16);
      header = [`Inicio (${tz})`, `Fin (${tz})`, "Servicio", "Cliente", "Teléfono", "Estado", "Origen", "Notas"];
      rows = r.rows.map((x) => [fmt(x.starts_at), fmt(x.ends_at), x.service, x.customer_name, phoneCell(x.customer_phone), APPT_STATUS[x.status] ?? x.status, SOURCE[x.source] ?? x.source, x.notes]);
    } else {
      const r = await db.query(
        `SELECT p.name, p.description, p.unit, p.price_minor, p.stock, p.min_stock, p.active, (SELECT currency FROM catalog_settings WHERE tenant_id = p.tenant_id) AS currency
           FROM catalog_products p WHERE p.tenant_id = $1 ORDER BY p.active DESC, lower(p.name) LIMIT ${MAX_ROWS}`, [tenantId]);
      // Mismas columnas que la plantilla de importación (+ moneda y estado al final, que la importación ignora): se puede editar y volver a subir.
      header = ["Nombre", "Descripción", "Presentación", "Precio", "Stock", "Avisar cuando queden", "Moneda", "Activo"];
      rows = r.rows.map((x) => [x.name, x.description, x.unit, money(x.price_minor), x.stock, x.min_stock, x.currency ?? "USD", x.active ? "Sí" : "No"]);
    }
    await db.query(
      "INSERT INTO audit_log (tenant_id, actor_id, action, target_type, target_id, metadata) VALUES ($1, $2, 'data.exported', 'export', $3, $4::jsonb)",
      [tenantId, auth.session.userId, que, JSON.stringify({ filas: rows.length, formato: format })],
    );
    return { header, rows };
  });
  return csvDownload(`${que}-${stamp}.csv`, header, rows, format);
}, { limit: "dataTransfer" });
