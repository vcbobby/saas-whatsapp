import { z } from "zod";
import { requireTenant } from "@/lib/auth/guard";
import { checkOrigin, jsonResponse, readJson, route } from "@/lib/auth/http";
import { withTenant } from "@/lib/db";
import { MAX_RECIPIENTS, audienceSchema, previewAudience } from "@/lib/broadcasts/audience";

/** A cuántas personas llegaría y a quiénes se deja fuera (y por qué). No envía nada. */
export const POST = route(async (req) => {
  const blocked = checkOrigin(req);
  if (blocked) return blocked;
  const auth = await requireTenant(req, "broadcasts:manage");
  if (!auth.ok) return auth.response;
  const body = await readJson(req, z.object({ audience: audienceSchema }));
  if (!body.ok) return body.response;
  const { tenantId } = auth.ctx;
  const p = await withTenant(tenantId, (db) => previewAudience(db, tenantId, body.data.audience));
  return jsonResponse({ ...p, max: MAX_RECIPIENTS });
});
