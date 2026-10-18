import { getPool } from "@/lib/db";
import { requireSuperAdmin } from "@/lib/auth/guard";
import { errorResponse, route } from "@/lib/auth/http";

/** Imagen del comprobante. Solo súper admin. Se sirve como imagen y nada más (sin ejecutar nada). */
export const GET = route(async (req) => {
  const auth = await requireSuperAdmin(req);
  if (!auth.ok) return auth.response;
  const id = new URL(req.url).searchParams.get("id") ?? "";
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) return errorResponse(404, "no_encontrado", "No encontrado.");
  const r = await getPool().query("SELECT * FROM admin_payment_proof($1, $2)", [auth.tokenHash, id]);
  const row = r.rows[0];
  if (!row) return errorResponse(404, "no_encontrado", "No encontrado.");
  return new Response(new Uint8Array(row.o_proof as Buffer), {
    headers: {
      "content-type": row.o_mime as string,
      "x-content-type-options": "nosniff",
      "content-security-policy": "default-src 'none'; sandbox",
      "cache-control": "private, no-store",
      "content-disposition": "inline",
    },
  });
});
