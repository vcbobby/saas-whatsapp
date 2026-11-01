// Recorridos de punta a punta en un navegador real (Chromium). Requisitos: servidor encendido en E2E_BASE_URL con base de datos y Redis.
// Cada prueba crea su propio negocio, así que pueden repetirse sin limpiar nada.
import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { captura, cerrarNavegador, nuevaPersona, registrarse, BASE } from "./ayudas.mjs";

const T = { timeout: 240_000 };
after(cerrarNavegador);

/** Falla si la pantalla escribió errores en la consola del navegador. */
const sinErrores = (errores) => assert.deepEqual(errores, [], `Errores en el navegador:\n${errores.join("\n")}`);

/** Cuenta nueva que salta la bienvenida y llega al panel. */
async function conNegocio(nombre, opciones) {
  const p = await nuevaPersona(opciones);
  p.correo = await registrarse(p.page, nombre);
  if (p.page.url().includes("/bienvenida")) {
    await p.page.getByRole("button", { name: /lo haré después/i }).click();
    await p.page.waitForURL(/\/panel/, { timeout: 60_000 });
  }
  await p.page.locator("h1").first().waitFor();
  return p;
}
const ir = async (page, ruta, titulo) => {
  await page.goto(ruta);
  await page.getByRole("heading", { level: 1, name: titulo }).waitFor({ timeout: 60_000 });
};

describe("cuenta y panel", () => {
  it("se registra, salta la bienvenida y ve su panel con el menú", T, async () => {
    const { page, errores } = await conNegocio("Panadería E2E");
    assert.match(page.url(), /\/panel$/);
    await captura(page, "01-panel");
    for (const nombre of ["Conversaciones", "Clientes", "Mi asistente", "Reportes", "Horario de atención"]) {
      assert.ok(await page.getByRole("link", { name: nombre }).first().isVisible(), `falta «${nombre}» en el menú`);
    }
    sinErrores(errores);
  });

  it("cierra sesión y vuelve a entrar con su contraseña", T, async () => {
    const { page, errores, correo } = await conNegocio("Negocio Entrar");
    await page.getByRole("button", { name: /salir|cerrar sesión/i }).first().click();
    await page.waitForURL(/\/(entrar|$)/, { timeout: 30_000 });
    await page.goto("/panel");
    await page.waitForURL(/\/entrar/, { timeout: 30_000 }); // sin sesión no entra
    await page.getByLabel("Correo electrónico").fill(correo);
    await page.getByLabel("Contraseña").first().fill("contraseña-de-prueba-123");
    await page.getByRole("button", { name: /entrar/i }).last().click();
    await page.waitForURL(/\/(panel|bienvenida)/, { timeout: 60_000 });
    sinErrores(errores);
  });
});

describe("datos de ejemplo y pantallas con movimiento", () => {
  it("carga los datos de ejemplo y se ven en conversaciones, clientes, pedidos y reportes", T, async () => {
    const { page, errores } = await conNegocio("Tienda Ejemplo");
    await ir(page, "/datos", "Importar y exportar");
    await page.getByRole("button", { name: "Cargar datos de ejemplo" }).click();
    await page.getByText(/ya puedes recorrer el panel/i).waitFor({ timeout: 60_000 });
    await captura(page, "02-datos");

    await ir(page, "/conversaciones", "Conversaciones");
    await page.getByText("Ana Pérez (ejemplo)").first().waitFor({ timeout: 60_000 });
    await page.getByText("Ana Pérez (ejemplo)").first().click();
    await page.getByText(/tenemos camisas a \$12/i).waitFor({ timeout: 60_000 });
    await captura(page, "03-conversaciones");

    await ir(page, "/clientes", "Clientes");
    await page.getByText("Marta Rojas (ejemplo)").waitFor({ timeout: 60_000 });
    await captura(page, "04-clientes");
    await page.getByText("Marta Rojas (ejemplo)").click();
    await page.getByRole("heading", { level: 1, name: "Ficha de cliente" }).waitFor({ timeout: 60_000 });
    await captura(page, "05-ficha-cliente");

    await ir(page, "/pedidos", "Pedidos");
    await page.getByText(/Pedido #\d+ · Marta Rojas/).waitFor({ timeout: 60_000 });
    await captura(page, "06-pedidos");

    await ir(page, "/reportes", "Reportes");
    await page.getByText("Mensajes recibidos").waitFor({ timeout: 60_000 });
    await captura(page, "07-reportes");

    await ir(page, "/hoy", "Hoy");
    await captura(page, "08-hoy");
    sinErrores(errores);
  });

  it("cobro: marca un pedido como pagado con su forma de pago y lo deshace", T, async () => {
    const { page, errores } = await conNegocio("Tienda Cobro");
    await ir(page, "/datos", "Importar y exportar");
    await page.getByRole("button", { name: "Cargar datos de ejemplo" }).click();
    await page.getByText(/ya puedes recorrer el panel/i).waitFor({ timeout: 60_000 });
    await ir(page, "/pedidos", "Pedidos");
    await page.getByRole("button", { name: /Por confirmar|Confirmados|Entregados/ }).first().waitFor({ timeout: 60_000 });
    await page.getByRole("button", { name: /^Confirmados/ }).click();
    await page.getByText(/Pedido #\d+ · Ana Pérez/).waitFor({ timeout: 60_000 });
    await page.getByRole("button", { name: "Marcar como pagado" }).first().click();
    await page.getByLabel("Forma de pago").selectOption("Transferencia");
    await page.getByRole("button", { name: "Confirmar pago" }).click();
    await page.getByText("Pagado · Transferencia").waitFor({ timeout: 60_000 });
    await captura(page, "09-pedido-pagado");
    await page.getByRole("button", { name: "Marcado por error" }).click();
    await page.getByText("Sin pagar").first().waitFor({ timeout: 60_000 });
    sinErrores(errores);
  });
});

describe("configuración del negocio", () => {
  it("guarda el horario de atención y lo recuerda al volver", T, async () => {
    const { page, errores } = await conNegocio("Negocio Horario");
    await ir(page, "/horario", "Horario de atención");
    await page.getByRole("button", { name: "Abrir" }).first().click(); // lunes 09:00–17:00
    await page.getByLabel("Avisar a mis clientes", { exact: false }).check();
    await page.getByRole("button", { name: "Guardar horario" }).click();
    await page.getByText("Guardado.").waitFor({ timeout: 60_000 });
    await captura(page, "10-horario");
    await page.reload();
    await page.getByLabel("Lunes, abre").waitFor({ timeout: 60_000 });
    assert.equal(await page.getByLabel("Lunes, abre").inputValue(), "09:00");
    assert.ok(await page.getByLabel("Avisar a mis clientes", { exact: false }).isChecked());
    sinErrores(errores);
  });

  it("envía un comentario desde el botón del menú", T, async () => {
    const { page, errores } = await conNegocio("Negocio Comentarios");
    await page.getByRole("button", { name: "Enviar comentario" }).click();
    await page.getByLabel("Tu comentario").fill("Prueba automática: todo se ve bien");
    await captura(page, "11-comentario");
    await page.getByRole("button", { name: "Enviar", exact: true }).click();
    await page.getByText(/Gracias! Lo leemos todo/).waitFor({ timeout: 60_000 });
    sinErrores(errores);
  });
});

describe("catálogo público", () => {
  it("publica el catálogo y un cliente sin sesión arma su pedido hacia WhatsApp", T, async () => {
    const dueno = await conNegocio("Panadería Pública");
    const { page } = dueno;
    await ir(page, "/datos", "Importar y exportar");
    await page.getByRole("button", { name: "Cargar datos de ejemplo" }).click();
    await page.getByText(/ya puedes recorrer el panel/i).waitFor({ timeout: 60_000 });
    await ir(page, "/tienda", "Catálogo público");
    await page.getByLabel("WhatsApp al que te escriben").fill("58 412 1234567");
    await page.getByLabel("Mostrar mi catálogo", { exact: false }).check();
    await page.getByRole("button", { name: "Guardar", exact: true }).click();
    await page.getByText("Tu enlace y código QR").waitFor({ timeout: 60_000 });
    await captura(page, "12-tienda");
    const enlace = await page.locator("section a[href*='/c/']").first().innerText();
    assert.match(enlace, /\/c\/panaderia-publica/);

    // Un cliente cualquiera, sin cuenta.
    const cliente = await nuevaPersona({ movil: true });
    await cliente.page.goto(new URL(enlace).pathname);
    await cliente.page.getByRole("heading", { level: 1, name: "Panadería Pública" }).waitFor({ timeout: 60_000 });
    await cliente.page.getByText("Camisa (ejemplo)").waitFor();
    await cliente.page.getByRole("button", { name: "Agregar uno de Camisa (ejemplo)" }).click();
    await cliente.page.getByRole("button", { name: "Agregar uno de Camisa (ejemplo)" }).click();
    const pedir = cliente.page.getByRole("link", { name: "Pedir por WhatsApp" });
    await pedir.waitFor();
    const href = await pedir.getAttribute("href");
    assert.ok(href.startsWith("https://wa.me/584121234567?text="));
    assert.match(decodeURIComponent(href), /2 x Camisa \(ejemplo\)/);
    assert.match(decodeURIComponent(href), /Total aproximado: \$24/);
    await captura(cliente.page, "13-catalogo-publico-movil");
    sinErrores(cliente.errores);

    // Apagarlo lo quita al instante.
    await page.getByLabel("Mostrar mi catálogo", { exact: false }).uncheck();
    await page.getByRole("button", { name: "Guardar", exact: true }).click();
    await page.getByText("Guardado.").waitFor({ timeout: 60_000 });
    const gone = await cliente.page.goto(new URL(enlace).pathname);
    assert.equal(gone.status(), 404);
  });
});

describe("pantalla de celular", () => {
  it("el panel y las conversaciones se usan en un celular sin desbordar la pantalla", T, async () => {
    const { page, errores } = await conNegocio("Negocio Móvil", { movil: true });
    for (const ruta of ["/panel", "/conversaciones", "/pedidos"]) {
      await page.goto(ruta);
      await page.locator("h1").first().waitFor({ timeout: 60_000 });
      const ancho = await page.evaluate(() => ({ doc: document.documentElement.scrollWidth, vista: window.innerWidth }));
      assert.ok(ancho.doc <= ancho.vista + 1, `${ruta}: la página se desborda a lo ancho (${ancho.doc} > ${ancho.vista})`);
    }
    await page.goto("/panel");
    await page.locator("h1").first().waitFor();
    await captura(page, "14-panel-movil");
    sinErrores(errores);
  });
});

console.log(`(pruebas de navegador contra ${BASE})`);
