import { z } from "zod";
import { getPool } from "@/lib/db";

/** Estados de un negocio, con el texto que ve el súper admin. */
export const TENANT_STATUS_LABEL: Record<string, string> = {
  trial: "Prueba",
  active: "Activa",
  past_due: "Pago pendiente",
  suspended: "Suspendida",
};

const overviewSchema = z.object({
  tz: z.string(),
  today: z.string(),
  tenants: z.object({
    total: z.number(), trial: z.number(), trialExpired: z.number(), active: z.number(),
    expiringSoon: z.number(), pastDue: z.number(), suspended: z.number(),
  }),
  signups: z.object({ last7: z.number(), prev7: z.number(), last30: z.number() }),
  users: z.number(),
  paymentsToReview: z.number(),
  daily: z.array(z.object({ day: z.string(), n: z.number() })),
  recent: z.array(z.object({ name: z.string(), status: z.string(), createdAt: z.string() })),
});
export type AdminOverview = z.infer<typeof overviewSchema>;

/** Resumen de la plataforma. La función de la base de datos exige súper admin con 2FA; aquí solo se lee y valida. */
export async function getAdminOverview(tokenHash: Buffer): Promise<AdminOverview> {
  const r = await getPool().query("SELECT admin_overview($1) AS o", [tokenHash]);
  return overviewSchema.parse(r.rows[0].o);
}
