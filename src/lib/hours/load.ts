import type { PoolClient } from "pg";
import { loadSettings } from "@/lib/agenda/load";
import type { Range } from "./pure";

type Db = Pick<PoolClient, "query">;
export interface BusinessHours { enabled: boolean; ranges: Range[]; timezone: string; closedNote: string | null }

export async function loadBusinessHours(db: Db, tenantId: string): Promise<BusinessHours> {
  const s = await db.query<{ enabled: boolean; closed_note: string | null }>("SELECT enabled, closed_note FROM business_hours_settings WHERE tenant_id = $1", [tenantId]);
  const h = await db.query<{ weekday: number; start_min: number; end_min: number }>("SELECT weekday, start_min, end_min FROM business_hours WHERE tenant_id = $1 ORDER BY weekday, start_min", [tenantId]);
  const { timezone } = await loadSettings(db, tenantId);
  return { enabled: s.rows[0]?.enabled ?? false, closedNote: s.rows[0]?.closed_note ?? null, timezone, ranges: h.rows.map((r) => ({ weekday: r.weekday, startMin: r.start_min, endMin: r.end_min })) };
}
