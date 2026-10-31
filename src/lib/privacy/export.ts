import { withTenant } from "@/lib/db";

/** Máximo de filas por tabla en la descarga (evita archivos gigantes); si se corta, el archivo lo dice. */
export const EXPORT_ROW_CAP = 20_000;

interface ExportedTable {
  table: string;
  order: string;
  /** Columnas que NO se descargan (secretos o archivos pesados). */
  omit?: string[];
  /** La aplicación no puede leer la tabla directamente: se entrega con una función de la base. */
  restricted?: boolean;
}

/** Todo lo que el negocio ve o escribió. Las columnas secretas se quitan; el resto sale tal cual. */
export const EXPORTED_TABLES: ExportedTable[] = [
  { table: "contacts", order: "created_at, id" },
  { table: "conversations", order: "created_at, id" },
  { table: "messages", order: "created_at, id" },
  { table: "broadcasts", order: "created_at, id" },
  { table: "broadcast_recipients", order: "id" },
  { table: "conversation_notes", order: "created_at, id" },
  { table: "team_settings", order: "1" },
  { table: "feedback", order: "created_at, id" },
  { table: "agenda_services", order: "created_at, id" },
  { table: "agenda_hours", order: "1" },
  { table: "business_hours", order: "weekday, start_min" },
  { table: "business_hours_settings", order: "1" },
  { table: "agenda_settings", order: "1" },
  { table: "agenda_time_off", order: "1" },
  { table: "appointments", order: "created_at, id" },
  { table: "catalog_products", order: "created_at, id" },
  { table: "catalog_settings", order: "1" },
  { table: "stock_movements", order: "created_at, id" },
  { table: "orders", order: "created_at, id" },
  { table: "order_items", order: "id" },
  { table: "automation_rules", order: "created_at, id" },
  { table: "kb_documents", order: "created_at, id" },
  { table: "tenant_agents", order: "1" },
  { table: "tenant_integrations", order: "created_at, id", omit: ["secret_enc", "key_version"] },
  { table: "webhook_endpoints", order: "created_at, id", omit: ["secret_enc", "key_version"] },
  { table: "work_items", order: "created_at, id" },
  { table: "work_item_events", order: "created_at, id" },
  { table: "support_tickets", order: "created_at, id" },
  { table: "support_messages", order: "created_at, id" },
  { table: "payments", order: "created_at, id", omit: ["proof"], restricted: true },
  { table: "customer_notifications", order: "created_at, id" },
  { table: "whatsapp_templates", order: "created_at, id" },
  { table: "invitations", order: "created_at, id", omit: ["token_hash"], restricted: true },
  { table: "agent_usage_daily", order: "1" },
  { table: "copilot_usage_daily", order: "1" },
  { table: "audit_log", order: "created_at, id" },
];

/** Tablas con tenant_id que NO se descargan, y por qué. Una prueba exige que toda tabla esté en una lista o en la otra. */
export const EXCLUDED_TABLES: Record<string, string> = {
  memberships: "Se entrega como «members» (con el correo de cada persona).",
  kb_chunks: "Fragmentos y vectores calculados a partir de tus documentos; se regeneran solos.",
  agent_events: "Registro técnico interno del agente.",
  automation_time_index: "Índice técnico interno.",
  kb_queue: "Cola técnica interna.",
  notification_queue: "Cola técnica interna.",
  webhook_queue: "Cola técnica interna.",
  webhook_deliveries: "Registro técnico de envíos de webhooks.",
  assignment_rotation: "Turno interno para repartir conversaciones.",
  report_state: "Control interno de qué reportes semanales ya se enviaron.",
  broadcast_index: "Índice técnico interno de difusiones en curso.",
  handoff_alerts: "Cola técnica interna de avisos al equipo.",
  order_counters: "Contador interno de numeración.",
  email_outbox: "Cola de correos que la plataforma envía (verificaciones, invitaciones, avisos). El texto se borra al enviarse.",
};

const SAFE_IDENT = /^[a-z_]+$/;

export interface ExportFile {
  format: "datos-del-negocio";
  version: 1;
  generatedAt: string;
  rowCap: number;
  tenant: Record<string, unknown>;
  members: Array<{ email: string; role: string; since: string; mfa: boolean }>;
  tables: Record<string, { rows: Record<string, unknown>[]; truncated: boolean }>;
  omitted: Record<string, string>;
}

/** Arma el archivo de descarga de un negocio. `userId` debe ser el dueño (la función SQL lo vuelve a comprobar). */
export async function buildExport(tenantId: string, userId: string): Promise<ExportFile> {
  return withTenant(tenantId, async (db) => {
    const tenant = await db.query<{ t: Record<string, unknown> }>("SELECT to_jsonb(t) AS t FROM tenants t WHERE id = $1", [tenantId]);
    const members = await db.query<{ m_email: string; m_role: string; m_since: Date; m_mfa: boolean }>("SELECT * FROM tenant_export_members($1, $2)", [tenantId, userId]);
    const tables: ExportFile["tables"] = {};
    const restricted = (await db.query<{ j: Record<string, Record<string, unknown>[]> }>("SELECT tenant_export_restricted($1, $2, $3) AS j", [tenantId, userId, EXPORT_ROW_CAP])).rows[0]!.j;
    for (const spec of EXPORTED_TABLES) {
      if (spec.restricted) {
        const all = restricted[spec.table] ?? [];
        tables[spec.table] = { rows: all.slice(0, EXPORT_ROW_CAP), truncated: all.length > EXPORT_ROW_CAP };
        continue;
      }
      if (!SAFE_IDENT.test(spec.table)) throw new Error("tabla inválida");
      const order = spec.order === "1" ? "1" : spec.order;
      const cols = (spec.omit ?? []).map((c) => {
        if (!SAFE_IDENT.test(c)) throw new Error("columna inválida");
        return ` - '${c}'`;
      }).join("");
      // order puede contener columnas que no existen en todas las tablas; "1" ordena por la primera columna.
      const r = await db.query<{ j: Record<string, unknown> }>(
        `SELECT to_jsonb(t)${cols} AS j FROM ${spec.table} t ORDER BY ${order === "1" ? "1" : order.split(",").map((c) => `t.${c.trim()}`).join(", ")} LIMIT ${EXPORT_ROW_CAP + 1}`,
      );
      tables[spec.table] = { rows: r.rows.slice(0, EXPORT_ROW_CAP).map((x) => x.j), truncated: r.rows.length > EXPORT_ROW_CAP };
    }
    const omitted: Record<string, string> = { ...EXCLUDED_TABLES };
    omitted["payments.proof"] = "Imágenes de comprobantes de pago: no se incluyen por su tamaño.";
    omitted["secretos"] = "Claves de integraciones y webhooks, y claves de invitaciones: nunca se descargan.";
    return {
      format: "datos-del-negocio",
      version: 1,
      generatedAt: new Date().toISOString(),
      rowCap: EXPORT_ROW_CAP,
      tenant: tenant.rows[0]?.t ?? {},
      members: members.rows.map((m) => ({ email: m.m_email, role: m.m_role, since: m.m_since.toISOString(), mfa: m.m_mfa })),
      tables,
      omitted,
    };
  });
}
