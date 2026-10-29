import { requireTenant } from "@/lib/auth/guard";
import { route } from "@/lib/auth/http";
import { csvDownload, type CsvFormat } from "@/lib/csv/write";
import { TEMPLATE_HEADER, TEMPLATE_ROWS } from "@/lib/csv/products";

/** Plantilla de ejemplo para importar productos. ?formato=csv (coma) o excel (punto y coma, para Excel en español). */
export const GET = route(async (req) => {
  const auth = await requireTenant(req, "catalog:manage");
  if (!auth.ok) return auth.response;
  const f: CsvFormat = new URL(req.url).searchParams.get("formato") === "csv" ? "csv" : "excel";
  return csvDownload("plantilla-productos.csv", TEMPLATE_HEADER, TEMPLATE_ROWS, f);
}, { limit: "dataTransfer" });
