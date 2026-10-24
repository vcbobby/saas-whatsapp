import { z } from "zod";
import { getPool } from "@/lib/db";
import { requireSuperAdmin } from "@/lib/auth/guard";
import { checkOrigin, jsonResponse, readJson, route } from "@/lib/auth/http";

/** Modo de la tasa BCV (automático o manual) e historial reciente. Solo súper admin. */
export const GET = route(async (req) => {
  const auth = await requireSuperAdmin(req);
  if (!auth.ok) return auth.response;
  const r = await getPool().query("SELECT * FROM admin_rate_history($1)", [auth.tokenHash]);
  return jsonResponse({ history: r.rows.map((x) => ({ rate: Number(x.h_rate), source: x.h_source, kind: x.h_kind, note: x.h_note, at: x.h_at })) });
});

const schema = z.object({ mode: z.enum(["auto", "manual"]) });

export const POST = route(async (req) => {
  const blocked = checkOrigin(req);
  if (blocked) return blocked;
  const auth = await requireSuperAdmin(req);
  if (!auth.ok) return auth.response;
  const body = await readJson(req, schema);
  if (!body.ok) return body.response;
  await getPool().query("SELECT admin_set_rate_mode($1, $2)", [auth.tokenHash, body.data.mode]);
  return jsonResponse({ ok: true, mode: body.data.mode });
});
