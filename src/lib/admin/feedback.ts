import { z } from "zod";
import { getPool } from "@/lib/db";

const schema = z.array(z.object({
  id: z.string(), kind: z.enum(["idea", "problema", "otro"]), message: z.string(), page: z.string().nullable(),
  created_at: z.string(), business: z.string(), email: z.string().nullable(),
}));
export type AdminFeedback = z.infer<typeof schema>[number];

/** Comentarios de todos los negocios. La función de la base exige súper admin con 2FA. */
export async function getAdminFeedback(tokenHash: Buffer, limit = 200): Promise<AdminFeedback[]> {
  const r = await getPool().query("SELECT admin_feedback($1, $2) AS f", [tokenHash, limit]);
  return schema.parse(r.rows[0].f);
}
