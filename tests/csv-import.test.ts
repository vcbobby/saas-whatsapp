import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { POST as signup } from "@/app/api/auth/signup/route";
import { GET as me } from "@/app/api/me/route";
import { POST as teamInvite } from "@/app/api/team/invite/route";
import { POST as inviteSignup } from "@/app/api/invitations/signup/route";
import { POST as importProducts } from "@/app/api/import/productos/route";
import { GET as template } from "@/app/api/import/plantilla/route";
import { GET as exportData } from "@/app/api/export/route";
import { getPool, withTenant } from "@/lib/db";
import { MAX_CSV_ROWS, normalizeHeader, parseCsv } from "@/lib/csv/parse";
import { SafeText, csvCell, csvLine, phoneCell } from "@/lib/csv/write";
import { planProductImport } from "@/lib/csv/products";

const RUN = randomUUID().slice(0, 8);
const ORIGIN = new URL(process.env.APP_URL!).origin;
const PASSWORD = "contraseña-de-prueba-123";
const owner = new Pool({ connectionString: process.env.MIGRATION_DATABASE_URL, max: 2 });
const tenantIds: string[] = [];

function api(method: string, path: string, cookie?: string, body?: unknown, origin = ORIGIN) {
  return new Request(`${ORIGIN}${path}`, {
    method,
    headers: { origin, ...(body !== undefined ? { "content-type": "application/json" } : {}), ...(cookie ? { cookie } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}
async function register(name: string) {
  const email = `cv-${RUN}-${name}@example.test`;
  const res = await signup(api("POST", "/api/auth/signup", undefined, { email, password: PASSWORD, businessName: `Negocio ${name}` }));
  expect(res.status).toBe(201);
  const cookie = (res.headers.get("set-cookie") ?? "").split(";")[0]!;
  const info = await (await me(api("GET", "/api/me", cookie))).json();
  tenantIds.push(info.tenant.id);
  return { tenantId: info.tenant.id as string, cookie };
}
type T = Awaited<ReturnType<typeof register>>;
async function member(t: T, role: "admin" | "agent"): Promise<T> {
  const inv = await teamInvite(api("POST", "/api/team/invite", t.cookie, { email: `cv-${RUN}-${role}-${randomUUID().slice(0, 6)}@example.test`, role }));
  expect(inv.status).toBe(201);
  const token = ((await inv.json()).inviteUrl as string).split("/").pop()!;
  const ok = await inviteSignup(api("POST", "/api/invitations/signup", undefined, { token, password: PASSWORD }));
  expect(ok.status).toBe(201);
  return { tenantId: t.tenantId, cookie: (ok.headers.get("set-cookie") ?? "").split(";")[0]! };
}
const preview = (t: T, csv: string) => importProducts(api("POST", "/api/import/productos", t.cookie, { csv, aplicar: false }));
const apply = (t: T, csv: string) => importProducts(api("POST", "/api/import/productos", t.cookie, { csv, aplicar: true }));
const exp = (t: T, q: string) => exportData(api("GET", `/api/export?${q}`, t.cookie));
const products = (t: T) => withTenant(t.tenantId, async (db) => (await db.query("SELECT name, description, unit, price_minor::int AS price, stock, min_stock, active FROM catalog_products WHERE tenant_id = $1 ORDER BY lower(name)", [t.tenantId])).rows);

beforeAll(async () => { await getPool().query("SELECT 1"); });
afterAll(async () => {
  await owner.query("DELETE FROM users WHERE email LIKE $1", [`cv-${RUN}-%`]);
  for (const id of tenantIds) {
    const c = await owner.connect();
    try {
      await c.query("BEGIN");
      await c.query("SELECT set_config('app.tenant_id', $1, true)", [id]);
      await c.query("ALTER TABLE audit_log DISABLE TRIGGER audit_log_sin_cambios");
      await c.query("DELETE FROM audit_log WHERE tenant_id = $1", [id]);
      await c.query("ALTER TABLE audit_log ENABLE TRIGGER audit_log_sin_cambios");
      const del = await c.query("DELETE FROM tenants WHERE id = $1", [id]);
      if (del.rowCount !== 1) throw new Error("La limpieza no borró el negocio de prueba " + id);
      await c.query("COMMIT");
    } catch (e) {
      await c.query("ROLLBACK");
      throw e;
    } finally {
      c.release();
    }
  }
  await owner.end();
  await getPool().end();
});

describe("lector de CSV", () => {
  it("lee comas, comillas con comas y saltos de línea, comillas dobles y finales Windows", () => {
    const r = parseCsv('Nombre,Descripción\r\n"Camisa, azul","Dice ""hola""\ny adiós"\r\n\r\nGorra,\r\n');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.delimiter).toBe(",");
    expect(r.headers).toEqual(["Nombre", "Descripción"]);
    expect(r.rows).toEqual([["Camisa, azul", 'Dice "hola"\ny adiós'], ["Gorra", ""]]);
    expect(r.lines).toEqual([2, 5]);
  });
  it("detecta el punto y coma de Excel en español y la tabulación", () => {
    const a = parseCsv("Nombre;Precio\nTaza;10,50\n");
    expect(a.ok && a.delimiter).toBe(";");
    expect(a.ok && a.rows[0]).toEqual(["Taza", "10,50"]);
    const b = parseCsv("Nombre\tPrecio\nTaza\t10\n");
    expect(b.ok && b.delimiter).toBe("\t");
  });
  it("rechaza archivos vacíos, con comillas sin cerrar o demasiado grandes", () => {
    expect(parseCsv("  \n ").ok).toBe(false);
    expect(parseCsv('a,b\n"x,1\n').ok).toBe(false);
    expect(parseCsv("a,b\n" + "1,2\n".repeat(MAX_CSV_ROWS + 5)).ok).toBe(false);
    expect(parseCsv("x".repeat(1_000_001)).ok).toBe(false);
    const ok = parseCsv("a,b\n" + "1,2\n".repeat(MAX_CSV_ROWS));
    expect(ok.ok && ok.rows.length).toBe(MAX_CSV_ROWS);
  });
  it("normaliza encabezados con acentos y mayúsculas", () => {
    expect(normalizeHeader(" Presentación ")).toBe("presentacion");
    expect(normalizeHeader("Avisar cuando QUEDEN")).toBe("avisar cuando queden");
  });
});

describe("escritura de CSV", () => {
  it("protege contra fórmulas pero no daña números ni teléfonos", () => {
    expect(csvCell("=1+1")).toBe("'=1+1");
    expect(csvCell("-1")).toBe("'-1");
    expect(csvCell(-3)).toBe("-3");
    expect(csvCell(12.5, ";")).toBe("12,5");
    expect(csvCell(phoneCell("+58 412 1234567"))).toBe("+58 412 1234567");
    expect(csvCell(phoneCell("+cmd|' /C calc'!A0"))).toBe("'+cmd|' /C calc'!A0");
    expect(phoneCell("+584121234567")).toBeInstanceOf(SafeText);
  });
  it("con punto y coma, la coma no obliga a entrecomillar y el punto y coma sí", () => {
    expect(csvLine(["a,b", "c;d"], ";")).toBe('a,b;"c;d"');
    expect(csvLine(["a,b", "c;d"], ",")).toBe('"a,b",c;d');
  });
});

describe("importar productos", () => {
  it("la vista previa no cambia nada y avisa de cada error por fila", async () => {
    const t = await register("prev");
    const csv = [
      "Nombre,Descripción,Presentación,Precio,Stock,Avisar cuando queden,Color",
      "Camisa azul,Algodón,unidad,12.50,40,5,azul",
      "Taza,,,\"$ 3,5\",,,",
      ",Sin nombre,,5,,,",
      "Gorra,,,abc,,,",
      "camisa AZUL,,,9,,,",
      "Lápiz,,,1,-4,,",
    ].join("\n");
    const res = await preview(t, csv);
    expect(res.status).toBe(200);
    const j = await res.json();
    expect(j.counts).toEqual({ crear: 2, actualizar: 0, sin_cambios: 0, error: 4, total: 6 });
    expect(j.ignoredColumns).toEqual(["Color"]);
    const byLine = Object.fromEntries(j.rows.map((r: { line: number; errors: string[] }) => [r.line, r.errors.join(" ")]));
    expect(byLine[4]).toMatch(/nombre/i);
    expect(byLine[5]).toMatch(/Precio «abc»/);
    expect(byLine[6]).toMatch(/ya aparece antes/);
    expect(byLine[7]).toMatch(/Stock/);
    expect(j.rows[0].action).toBe("error"); // primero los errores
    expect(await products(t)).toHaveLength(0);
  });

  it("aplica: crea y actualiza; una celda vacía no borra nada; repetirlo no cambia nada", async () => {
    const t = await register("apply");
    const first = ["Nombre;Descripción;Presentación;Precio;Stock;Avisar cuando queden", "Camisa azul;Algodón;unidad;12,50;40;5", "Café;Tostado;bolsa;6;;"].join("\r\n");
    let res = await apply(t, first);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ created: 2, updated: 0, unchanged: 0, skipped: [] });
    expect(await products(t)).toEqual([
      { name: "Café", description: "Tostado", unit: "bolsa", price: 600, stock: null, min_stock: null, active: true },
      { name: "Camisa azul", description: "Algodón", unit: "unidad", price: 1250, stock: 40, min_stock: 5, active: true },
    ]);
    // Segundo archivo: cambia precio y stock de uno; descripción vacía NO borra la descripción.
    res = await apply(t, "nombre,precio,stock,descripcion\ncamisa AZUL,15,12,\nCafé,6,,");
    expect(await res.json()).toMatchObject({ created: 0, updated: 1, unchanged: 1 });
    const rows = await products(t);
    expect(rows.find((r) => r.name === "Camisa azul")).toMatchObject({ price: 1500, stock: 12, description: "Algodón", min_stock: 5 });
    // «sin control» quita el control de stock
    res = await apply(t, "nombre,precio,stock\nCamisa azul,15,sin control");
    expect(await res.json()).toMatchObject({ updated: 1 });
    expect((await products(t)).find((r) => r.name === "Camisa azul")?.stock).toBeNull();
    // idéntico → sin cambios
    res = await apply(t, "nombre,precio\nCamisa azul,15");
    expect(await res.json()).toMatchObject({ created: 0, updated: 0, unchanged: 1 });
    const audit = await withTenant(t.tenantId, async (db) => (await db.query("SELECT metadata FROM audit_log WHERE tenant_id = $1 AND action = 'catalog.imported' ORDER BY created_at", [t.tenantId])).rows);
    expect(audit.length).toBe(4);
    expect(audit[0]!.metadata).toMatchObject({ creados: 2 });
  });

  it("las filas con error se omiten y el resto se importa; nunca se crean productos inactivos ni se borran", async () => {
    const t = await register("mixto");
    const res = await apply(t, "Nombre,Precio\nBueno,5\nMalo,xx\nOtro,7");
    const j = await res.json();
    expect(j).toMatchObject({ created: 2, skipped: [{ line: 3, name: "Malo" }] });
    await apply(t, "Nombre,Precio\nSolo uno,1");
    expect((await products(t)).map((p) => p.name)).toEqual(["Bueno", "Otro", "Solo uno"]);
  });

  it("máximo 500 productos activos", async () => {
    const t = await register("limite");
    await withTenant(t.tenantId, (db) => db.query("INSERT INTO catalog_products (tenant_id, name, price_minor) SELECT $1, 'P' || g, 100 FROM generate_series(1, 499) g", [t.tenantId]));
    const res = await apply(t, "Nombre,Precio\nNuevo 1,1\nNuevo 2,1\nP1,2");
    const j = await res.json();
    expect(j).toMatchObject({ created: 1, updated: 1 });
    expect(j.skipped).toHaveLength(1);
    expect(j.skipped[0].errors.join(" ")).toMatch(/500/);
  });

  it("errores de archivo: sin columna Nombre o Precio, vacío, y la plantilla se puede importar tal cual", async () => {
    const t = await register("arch");
    for (const bad of ["Producto\nTaza", "Nombre\nTaza", "  "]) {
      const res = await preview(t, bad);
      expect([400]).toContain(res.status);
    }
    const plan = await withTenant(t.tenantId, async (db) => planProductImport(db, t.tenantId, await (await template(api("GET", "/api/import/plantilla", t.cookie))).text()));
    expect(plan.ok && plan.counts).toMatchObject({ crear: 2, error: 0 });
  });

  it("permisos, origen y tipo de contenido", async () => {
    const t = await register("perm");
    const agent = await member(t, "agent");
    const admin = await member(t, "admin");
    expect((await preview(agent, "Nombre,Precio\nA,1")).status).toBe(403);
    expect((await apply(agent, "Nombre,Precio\nA,1")).status).toBe(403);
    expect((await preview(admin, "Nombre,Precio\nA,1")).status).toBe(200);
    expect((await importProducts(api("POST", "/api/import/productos", t.cookie, { csv: "Nombre,Precio\nA,1", aplicar: true }, "https://malo.example"))).status).toBe(403);
    expect((await importProducts(api("POST", "/api/import/productos", undefined, { csv: "Nombre,Precio\nA,1", aplicar: true }))).status).toBe(401);
    expect((await importProducts(new Request(`${ORIGIN}/api/import/productos`, { method: "POST", headers: { origin: ORIGIN, cookie: t.cookie, "content-type": "text/plain" }, body: "x" }))).status).toBe(415);
    expect((await importProducts(api("POST", "/api/import/productos", t.cookie, { csv: "x".repeat(1_000_100), aplicar: false }))).status).toBeGreaterThanOrEqual(400);
    expect(await products(t)).toHaveLength(0);
  });

  it("un negocio no ve ni toca los productos de otro", async () => {
    const a = await register("aisl-a");
    const b = await register("aisl-b");
    await apply(a, "Nombre,Precio\nSecreto A,5");
    const res = await apply(b, "Nombre,Precio\nSecreto A,9");
    expect(await res.json()).toMatchObject({ created: 1, updated: 0 });
    expect((await products(a))[0]).toMatchObject({ name: "Secreto A", price: 500 });
    const csvB = await (await exp(b, "que=productos&formato=csv")).text();
    expect(csvB).toContain("Secreto A,,,9.00");
    expect(csvB).not.toContain("5.00");
  });
});

describe("exportar", () => {
  it("productos: mismas columnas que la plantilla, formato Excel con punto y coma y coma decimal; se puede volver a importar", async () => {
    const t = await register("exp-prod");
    await apply(t, "Nombre,Descripción,Presentación,Precio,Stock,Avisar cuando queden\nCamisa azul,\"Algodón, S a XL\",unidad,12.5,40,5\n=HYPERLINK(\"x\"),,,1,,");
    const res = await exp(t, "que=productos");
    expect(res.status).toBe(200);
    const bytes = new Uint8Array(await res.clone().arrayBuffer());
    expect([...bytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]); // BOM para que Excel respete los acentos
    expect(res.headers.get("content-type")).toContain("text/csv");
    expect(res.headers.get("content-disposition")).toMatch(/productos-\d{4}-\d{2}-\d{2}\.csv/);
    const text = await res.text();
    expect(text.startsWith("Nombre;Descripción;Presentación;Precio;Stock;Avisar cuando queden;Moneda;Activo")).toBe(true);
    expect(text).toContain("Camisa azul;Algodón, S a XL;unidad;12,50;40;5;USD;Sí");
    expect(text).toContain("\"'=HYPERLINK(\"\"x\"\")\""); // fórmulas neutralizadas
    const csv = await (await exp(t, "que=productos&formato=csv")).text();
    expect(csv).toContain('Camisa azul,"Algodón, S a XL",unidad,12.50,40,5,USD,Sí');
    // volver a subir lo descargado: el producto normal queda «sin cambios»
    const j = await (await preview(t, text)).json();
    expect(j.rows.find((r: { name: string }) => r.name === "Camisa azul").action).toBe("sin_cambios");
    expect(j.ignoredColumns).toEqual(["Moneda", "Activo"]);
  });

  it("clientes, pedidos (con productos y filtro de fechas) y citas", async () => {
    const t = await register("exp-todo");
    const { tenantId } = t;
    const p = await apply(t, "Nombre,Precio\nCamisa,10");
    expect(p.status).toBe(200);
    const ids = await withTenant(tenantId, async (db) => {
      const c = await db.query("INSERT INTO contacts (tenant_id, wa_id, display_name) VALUES ($1, '584121234567', 'Ana Pérez') RETURNING id", [tenantId]);
      const prod = (await db.query("SELECT id FROM catalog_products WHERE tenant_id = $1", [tenantId])).rows[0]!.id;
      const o1 = await db.query("INSERT INTO orders (tenant_id, number, contact_id, customer_name, customer_phone, status, source, currency, total_minor, notes, created_at) VALUES ($1, 1, $2, 'Ana Pérez', '+58 412 1234567', 'pendiente', 'manual', 'USD', 2000, '=SUMA(1)', '2026-01-10T15:00:00Z') RETURNING id", [tenantId, c.rows[0].id]);
      const o2 = await db.query("INSERT INTO orders (tenant_id, number, customer_name, status, source, currency, total_minor, created_at) VALUES ($1, 2, 'Luis', 'pendiente', 'manual', 'USD', 100, '2026-03-10T15:00:00Z') RETURNING id", [tenantId]);
      await db.query("INSERT INTO order_items (tenant_id, order_id, product_id, position, name, unit_price_minor, quantity, line_total_minor) VALUES ($1, $2, $3, 1, 'Camisa', 1000, 2, 2000), ($1, $4, $3, 1, 'Gorra', 100, 1, 100)", [tenantId, o1.rows[0].id, prod, o2.rows[0].id]);
      const s = await db.query("INSERT INTO agenda_services (tenant_id, name, duration_minutes) VALUES ($1, 'Corte', 30) RETURNING id", [tenantId]);
      await db.query("INSERT INTO appointments (tenant_id, service_id, contact_id, customer_name, customer_phone, starts_at, ends_at, status, source) VALUES ($1, $2, $3, 'Ana Pérez', '+584121234567', '2026-02-05T14:00:00Z', '2026-02-05T14:30:00Z', 'confirmada', 'manual')", [tenantId, s.rows[0].id, c.rows[0].id]);
      return c.rows[0].id as string;
    });
    expect(ids).toBeTruthy();

    const clientes = await (await exp(t, "que=clientes&formato=csv")).text();
    expect(clientes).toMatch(/^Nombre,Teléfono \(WhatsApp\),Primer contacto \(America\/Caracas\),Pedidos,Citas\r\n/);
    expect(clientes).toMatch(/Ana Pérez,584121234567,\d{4}-\d{2}-\d{2} \d{2}:\d{2},1,1\r\n/);

    const pedidos = await (await exp(t, "que=pedidos&formato=excel")).text();
    expect(pedidos).toContain("2;2026-03-10 11:00;Luis;;Pendiente;Manual;USD;1,00;1 x Gorra;;");
    expect(pedidos).toContain("1;2026-01-10 11:00;Ana Pérez;+58 412 1234567;Pendiente;Manual;USD;20,00;2 x Camisa;'=SUMA(1);");
    const feb = await (await exp(t, "que=pedidos&formato=csv&desde=2026-03-01&hasta=2026-03-31")).text();
    expect(feb).toContain("Luis");
    expect(feb).not.toContain("Ana Pérez");
    const dia = await (await exp(t, "que=pedidos&formato=csv&desde=2026-03-10&hasta=2026-03-10")).text();
    expect(dia).toContain("Luis");

    const citas = await (await exp(t, "que=citas&formato=csv")).text();
    expect(citas).toContain("2026-02-05 10:00,2026-02-05 10:30,Corte,Ana Pérez,+584121234567,Confirmada,Manual,");
    expect(await (await exp(t, "que=citas&desde=2026-03-01")).text()).not.toContain("Corte");

    const audit = await withTenant(tenantId, async (db) => (await db.query("SELECT target_id, metadata FROM audit_log WHERE tenant_id = $1 AND action = 'data.exported' ORDER BY created_at", [tenantId])).rows);
    expect(audit.map((a) => a.target_id)).toEqual(expect.arrayContaining(["clientes", "pedidos", "citas"]));
    expect(audit.find((a) => a.target_id === "pedidos")!.metadata).toMatchObject({ filas: 2 });
  });

  it("permisos y validación", async () => {
    const t = await register("exp-perm");
    const agent = await member(t, "agent");
    expect((await exp(agent, "que=clientes")).status).toBe(403);
    expect((await exp(agent, "que=productos")).status).toBe(403);
    expect((await exp(agent, "que=pedidos")).status).toBe(200);
    expect((await exp(agent, "que=citas")).status).toBe(200);
    expect((await exp(t, "que=otra")).status).toBe(400);
    expect((await exp(t, "")).status).toBe(400);
    expect((await exp(t, "que=pedidos&desde=ayer")).status).toBe(400);
    expect((await exportData(api("GET", "/api/export?que=clientes"))).status).toBe(401);
    expect((await template(api("GET", "/api/import/plantilla", agent.cookie))).status).toBe(403);
    const tpl = await template(api("GET", "/api/import/plantilla?formato=csv", t.cookie));
    expect(await tpl.text()).toContain("Nombre,Descripción,Presentación,Precio,Stock,Avisar cuando queden");
  });
});
