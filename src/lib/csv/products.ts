import type { PoolClient } from "pg";
import { MAX_MINOR, MAX_STOCK, parseMoney } from "@/lib/catalog/money";
import { clearStockContext, setStockContext } from "@/lib/inventory/service";
import { normalizeHeader, parseCsv } from "./parse";

type Db = Pick<PoolClient, "query">;

export const MAX_ACTIVE_PRODUCTS = 500;

type Field = "name" | "description" | "unit" | "price" | "stock" | "min";
const ALIASES: Record<Field, string[]> = {
  name: ["nombre", "producto", "articulo", "name", "product"],
  description: ["descripcion", "detalle", "description"],
  unit: ["presentacion", "unidad", "unit"],
  price: ["precio", "price", "precio usd", "precio venta"],
  stock: ["stock", "existencias", "existencia", "cantidad", "inventario"],
  min: ["avisar cuando queden", "avisar", "minimo", "stock minimo", "min stock", "minimo stock"],
};

export type RowAction = "crear" | "actualizar" | "sin_cambios" | "error";
export interface PlannedRow {
  /** Número de línea en el archivo (la 1 son los encabezados). */
  line: number;
  name: string;
  action: RowAction;
  errors: string[];
  changes: string[];
  /** Datos ya validados (solo si no hay error). `undefined` = no tocar. */
  data?: { name: string; description?: string | null; unit?: string | null; priceMinor?: number; stock?: number | null; minStock?: number | null; existingId?: string };
}
export type ImportPlan =
  | { ok: false; error: string }
  | { ok: true; delimiter: string; ignored: string[]; rows: PlannedRow[]; counts: Record<RowAction, number> & { total: number } };

export const TEMPLATE_HEADER = ["Nombre", "Descripción", "Presentación", "Precio", "Stock", "Avisar cuando queden"];
export const TEMPLATE_ROWS = [
  ["Camisa azul", "Algodón, tallas S a XL", "unidad", "12,50", "40", "5"],
  ["Café molido 500 g", "Tostado medio", "bolsa", "6", "", ""],
];

function cleanPrice(raw: string): number | null {
  const s = raw.replace(/^(?:US\$|\$|Bs\.?|€|S\/)\s*/i, "").trim();
  const v = parseMoney(s);
  return v !== null && v <= MAX_MINOR ? v : null;
}

/** Lee el archivo y decide qué pasaría con cada fila. NO escribe nada. */
export async function planProductImport(db: Db, tenantId: string, csv: string): Promise<ImportPlan> {
  const parsed = parseCsv(csv);
  if (!parsed.ok) return { ok: false, error: parsed.error };
  const col: Partial<Record<Field, number>> = {};
  const ignored: string[] = [];
  parsed.headers.forEach((h, i) => {
    const n = normalizeHeader(h);
    const f = (Object.keys(ALIASES) as Field[]).find((k) => ALIASES[k].includes(n));
    if (f && col[f] === undefined) col[f] = i;
    else if (h) ignored.push(h);
  });
  if (col.name === undefined) return { ok: false, error: "No encuentro la columna «Nombre». La primera fila del archivo debe tener los encabezados (descarga la plantilla para verla)." };
  if (col.price === undefined) return { ok: false, error: "No encuentro la columna «Precio». La primera fila del archivo debe tener los encabezados (descarga la plantilla para verla)." };

  const cur = await db.query("SELECT id, name, description, unit, price_minor, stock, min_stock FROM catalog_products WHERE tenant_id = $1 AND active", [tenantId]);
  const byName = new Map<string, (typeof cur.rows)[number]>(cur.rows.map((r) => [String(r.name).toLowerCase(), r]));
  let activeCount = cur.rowCount ?? cur.rows.length;
  const seen = new Set<string>();
  const rows: PlannedRow[] = [];

  parsed.rows.forEach((cells, idx) => {
    const get = (f: Field) => (col[f] === undefined ? undefined : (cells[col[f]!] ?? ""));
    const name = (get("name") ?? "").trim();
    const errors: string[] = [];
    const changes: string[] = [];
    const data: NonNullable<PlannedRow["data"]> = { name };
    const line = parsed.lines[idx]!;

    if (!name) errors.push("Falta el nombre.");
    else if (name.length > 120) errors.push("El nombre pasa de 120 caracteres.");
    const key = name.toLowerCase();
    if (name && seen.has(key)) errors.push("Este nombre ya aparece antes en el archivo.");
    seen.add(key);
    const existing = name ? byName.get(key) : undefined;
    if (existing) data.existingId = existing.id;

    const d = get("description");
    if (d !== undefined && d !== "") { if (d.length > 500) errors.push("La descripción pasa de 500 caracteres."); else data.description = d; }
    const u = get("unit");
    if (u !== undefined && u !== "") { if (u.length > 40) errors.push("La presentación pasa de 40 caracteres."); else data.unit = u; }

    const p = get("price") ?? "";
    if (p === "") { if (!existing) errors.push("Falta el precio."); }
    else {
      const m = cleanPrice(p);
      if (m === null) errors.push(`Precio «${p}» inválido: usa 10 o 10,50 (sin separador de miles).`);
      else data.priceMinor = m;
    }

    const s = get("stock");
    if (s !== undefined && s !== "") {
      if (/^(sin control|no)$/i.test(s)) data.stock = null;
      else if (/^\d{1,7}$/.test(s) && Number(s) <= MAX_STOCK) data.stock = Number(s);
      else errors.push(`Stock «${s}» inválido: debe ser un número entero de 0 a ${MAX_STOCK} (o «sin control»).`);
    }
    const mn = get("min");
    if (mn !== undefined && mn !== "") {
      if (/^\d{1,7}$/.test(mn) && Number(mn) <= MAX_STOCK) data.minStock = Number(mn);
      else errors.push(`«Avisar cuando queden» «${mn}» inválido: debe ser un número entero.`);
    }

    if (errors.length === 0 && existing) {
      if (data.priceMinor !== undefined && Number(existing.price_minor) !== data.priceMinor) changes.push("precio");
      if (data.description !== undefined && data.description !== existing.description) changes.push("descripción");
      if (data.unit !== undefined && data.unit !== existing.unit) changes.push("presentación");
      if (data.stock !== undefined && data.stock !== existing.stock) changes.push("stock");
      if (data.minStock !== undefined && data.minStock !== existing.min_stock) changes.push("avisar cuando queden");
    }
    let action: RowAction;
    if (errors.length) action = "error";
    else if (!existing) {
      if (activeCount >= MAX_ACTIVE_PRODUCTS) { errors.push(`Se superaría el máximo de ${MAX_ACTIVE_PRODUCTS} productos activos.`); action = "error"; }
      else { action = "crear"; activeCount++; }
    } else action = changes.length ? "actualizar" : "sin_cambios";
    rows.push({ line, name, action, errors, changes, data: action === "error" ? undefined : data });
  });

  const counts = { crear: 0, actualizar: 0, sin_cambios: 0, error: 0, total: rows.length };
  for (const r of rows) counts[r.action]++;
  return { ok: true, delimiter: parsed.delimiter, ignored, rows, counts };
}

export interface ImportResult { created: number; updated: number; unchanged: number; skipped: { line: number; name: string; errors: string[] }[] }

/**
 * Aplica el archivo: vuelve a calcular el plan DENTRO de la transacción (con el negocio bloqueado contra otra importación),
 * así lo que se aplica es lo que hay en ese momento y no lo que se vio en la vista previa. Las filas con error se omiten.
 */
export async function applyProductImport(db: Db, tenantId: string, userId: string, csv: string): Promise<ImportResult | { error: string }> {
  await db.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`import-productos:${tenantId}`]);
  const plan = await planProductImport(db, tenantId, csv);
  if (!plan.ok) return { error: plan.error };
  const res: ImportResult = { created: 0, updated: 0, unchanged: 0, skipped: [] };
  await setStockContext(db, { kind: "edicion", note: "Importación de archivo", userId });
  for (const r of plan.rows) {
    if (r.action === "error") { res.skipped.push({ line: r.line, name: r.name, errors: r.errors }); continue; }
    if (r.action === "sin_cambios") { res.unchanged++; continue; }
    const d = r.data!;
    await db.query("SAVEPOINT fila");
    try {
      if (r.action === "crear") {
        await db.query(
          "INSERT INTO catalog_products (tenant_id, name, description, unit, price_minor, stock, min_stock) VALUES ($1, $2, $3, $4, $5, $6, $7)",
          [tenantId, d.name, d.description ?? null, d.unit ?? null, d.priceMinor, d.stock ?? null, d.minStock ?? null],
        );
        res.created++;
      } else {
        await db.query(
          `UPDATE catalog_products SET
              description = CASE WHEN $3::boolean THEN $4 ELSE description END,
              unit = CASE WHEN $5::boolean THEN $6 ELSE unit END,
              price_minor = COALESCE($7, price_minor),
              stock = CASE WHEN $8::boolean THEN $9 ELSE stock END,
              min_stock = CASE WHEN $10::boolean THEN $11 ELSE min_stock END,
              updated_at = now()
            WHERE tenant_id = $1 AND id = $2`,
          [tenantId, d.existingId, d.description !== undefined, d.description ?? null, d.unit !== undefined, d.unit ?? null, d.priceMinor ?? null, d.stock !== undefined, d.stock ?? null, d.minStock !== undefined, d.minStock ?? null],
        );
        res.updated++;
      }
      await db.query("RELEASE SAVEPOINT fila");
    } catch (e) {
      await db.query("ROLLBACK TO SAVEPOINT fila");
      const code = (e as { code?: string }).code;
      res.skipped.push({ line: r.line, name: r.name, errors: [code === "23505" ? "Ya existe un producto activo con ese nombre." : "No se pudo guardar esta fila."] });
    }
  }
  await clearStockContext(db);
  await db.query(
    "INSERT INTO audit_log (tenant_id, actor_id, action, target_type, metadata) VALUES ($1, $2, 'catalog.imported', 'catalog', $3::jsonb)",
    [tenantId, userId, JSON.stringify({ creados: res.created, actualizados: res.updated, sinCambios: res.unchanged, omitidos: res.skipped.length })],
  );
  return res;
}
