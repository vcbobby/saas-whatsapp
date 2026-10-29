import { z } from "zod";
import { requireTenant } from "@/lib/auth/guard";
import { checkOrigin, errorResponse, jsonResponse, readJson, route } from "@/lib/auth/http";
import { withTenant } from "@/lib/db";
import { MAX_CSV_CHARS } from "@/lib/csv/parse";
import { applyProductImport, planProductImport } from "@/lib/csv/products";

const schema = z.object({
  csv: z.string().min(1, "Elige un archivo").max(MAX_CSV_CHARS, "El archivo es demasiado grande (máximo 1 MB)"),
  // false = solo mostrar qué pasaría (vista previa). true = aplicar.
  aplicar: z.boolean(),
});

const MAX_ROWS_SHOWN = 300;

/** Importar productos desde un CSV (Excel → Guardar como CSV). Primero vista previa (aplicar:false), luego aplicar. */
export const POST = route(async (req) => {
  const blocked = checkOrigin(req);
  if (blocked) return blocked;
  const auth = await requireTenant(req, "catalog:manage");
  if (!auth.ok) return auth.response;
  const body = await readJson(req, schema, { maxChars: MAX_CSV_CHARS + 1_000 });
  if (!body.ok) return body.response;
  const { tenantId } = auth.ctx;

  if (!body.data.aplicar) {
    const plan = await withTenant(tenantId, (db) => planProductImport(db, tenantId, body.data.csv));
    if (!plan.ok) return errorResponse(400, "archivo_invalido", plan.error);
    // Se muestran primero las filas con error: son lo que la persona necesita corregir.
    const ordered = [...plan.rows.filter((r) => r.action === "error"), ...plan.rows.filter((r) => r.action !== "error")];
    return jsonResponse({
      ok: true,
      delimiter: plan.delimiter,
      ignoredColumns: plan.ignored,
      counts: plan.counts,
      rows: ordered.slice(0, MAX_ROWS_SHOWN).map((r) => ({ line: r.line, name: r.name, action: r.action, errors: r.errors, changes: r.changes })),
      truncated: ordered.length > MAX_ROWS_SHOWN,
    });
  }

  const out = await withTenant(tenantId, (db) => applyProductImport(db, tenantId, auth.session.userId, body.data.csv));
  if ("error" in out) return errorResponse(400, "archivo_invalido", out.error);
  return jsonResponse({ ok: true, ...out, skipped: out.skipped.slice(0, MAX_ROWS_SHOWN) });
});
