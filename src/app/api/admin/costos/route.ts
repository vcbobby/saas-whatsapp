import { getAdminBudget, budgetInputSchema, setAdminBudget } from "@/lib/admin/costs";
import { checkOrigin, jsonResponse, readJson, route } from "@/lib/auth/http";
import { requireSuperAdmin } from "@/lib/auth/guard";

/** Cambiar el presupuesto global de IA, los precios por millón de tokens y el tope diario. */
export const PUT = route(async (req) => {
  const blocked = checkOrigin(req);
  if (blocked) return blocked;
  const auth = await requireSuperAdmin(req);
  if (!auth.ok) return auth.response;
  const body = await readJson(req, budgetInputSchema);
  if (!body.ok) return body.response;
  await setAdminBudget(auth.tokenHash, body.data);
  return jsonResponse(await getAdminBudget(auth.tokenHash));
});
