// Utilidades de las pruebas de navegador. Se conectan a un servidor YA encendido (E2E_BASE_URL, por defecto http://localhost:3000).
import { chromium } from "playwright";
import { mkdirSync } from "node:fs";

export const BASE = (process.env.E2E_BASE_URL ?? "http://localhost:3000").replace(/\/$/, "");
export const PASSWORD = "contraseña-de-prueba-123";
export const CAPTURAS = new URL("./capturas/", import.meta.url).pathname;
mkdirSync(CAPTURAS, { recursive: true });

let browser;
export async function abrirNavegador() {
  browser ??= await chromium.launch();
  return browser;
}
export async function cerrarNavegador() {
  await browser?.close();
  browser = undefined;
}

/** Ruido propio de las herramientas de desarrollo de React/Next (solo con `npm run dev`; no existe en producción). No es un fallo de la app. */
const RUIDO_DE_DESARROLLO = /Failed to execute 'measure' on 'Performance'.*negative time stamp/;

/** Una persona nueva: contexto limpio (sin cookies), con vigilancia de errores de la página. */
export async function nuevaPersona({ movil = false } = {}) {
  const b = await abrirNavegador();
  const context = await b.newContext({ baseURL: BASE, locale: "es-VE", viewport: movil ? { width: 390, height: 800 } : { width: 1280, height: 800 } });
  const page = await context.newPage();
  const errores = [];
  page.on("pageerror", (e) => { if (!RUIDO_DE_DESARROLLO.test(e.message)) errores.push(`error de página: ${e.message}`); });
  page.on("console", (m) => {
    if (m.type() !== "error") return;
    const t = m.text();
    if (RUIDO_DE_DESARROLLO.test(t)) return;
    if (/favicon|Failed to load resource.*(40[0-9]|50[0-9])|net::ERR_/.test(t)) return; // respuestas de error esperadas en algunas pruebas
    errores.push(`consola: ${t}`);
  });
  return { context, page, errores };
}

let n = 0;
/** Crea una cuenta de verdad desde la pantalla de registro y espera llegar al panel. */
export async function registrarse(page, negocio = "Negocio de Prueba") {
  const correo = `e2e-${Date.now()}-${n++}@example.test`;
  // En desarrollo la primera visita compila: se reintenta si la página aún no estaba lista (el envío nativo recarga /registro).
  for (let intento = 1; intento <= 3; intento++) {
    await page.goto("/registro", { waitUntil: "networkidle" });
    await page.getByLabel("Nombre de tu negocio").fill(negocio);
    await page.getByLabel("Correo electrónico").fill(correo);
    await page.getByLabel("Contraseña", { exact: false }).first().fill(PASSWORD);
    await page.getByRole("checkbox").check();
    await page.getByRole("button", { name: /crear/i }).click();
    try { await page.waitForURL(/\/(panel|bienvenida)/, { timeout: 25_000 }); break; }
    catch (e) { if (intento === 3) throw e; }
  }
  await page.locator("h1").first().waitFor({ timeout: 60_000 });
  return correo;
}

export async function captura(page, nombre) {
  // Esperar a que la página termine de cargar y a que React se «hidrate»: tomar la foto antes puede alterar el HTML y producir un aviso falso de hidratación.
  await page.waitForLoadState("networkidle", { timeout: 8000 }).catch(() => {});
  await page.addStyleTag({ content: "nextjs-portal { display: none !important; }" }); // la insignia de desarrollo de Next
  // caret: "initial" → Playwright no escribe «caret-color: transparent» en los campos (eso es lo que disparaba el aviso de hidratación).
  await page.screenshot({ path: `${CAPTURAS}${nombre}.png`, fullPage: true, caret: "initial" });
}
