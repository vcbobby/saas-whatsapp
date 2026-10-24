import { jsonResponse, route } from "@/lib/auth/http";
import { getDeletionStatus } from "@/lib/privacy/deletion";
import { requireOwner } from "@/lib/privacy/guard";

export const GET = route(async (req) => {
  const owner = await requireOwner(req);
  if (!owner.ok) return owner.response;
  return jsonResponse(await getDeletionStatus(owner.tenantId));
}, { limit: "api" });
