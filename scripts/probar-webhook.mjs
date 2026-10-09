// Envía al webhook un mensaje FALSO pero firmado como lo haría Meta.
// Sirve para separar problemas: si esto funciona, tu app está bien y lo que falla
// es la entrega de Meta (URL del túnel, suscripción, etc.).
//
//   node --env-file=.env.local scripts/probar-webhook.mjs [URL_BASE] [ID_DEL_NUMERO]
//   URL_BASE por defecto: http://localhost:3000   (o la de tu túnel, https://xxxx.trycloudflare.com)
import { createHmac } from "node:crypto";
import pg from "pg";

const base = (process.argv[2] ?? "http://localhost:3000").replace(/\/$/, "");
const secret = process.env.WHATSAPP_APP_SECRET;
if (!secret || secret.length < 16 || secret.startsWith("EAA") || secret.includes("pega-aqui")) {
  console.error("✖ WHATSAPP_APP_SECRET no es válido. Debe ser la 'Clave secreta de la app' (32 caracteres hex), no el token de acceso.");
  process.exit(1);
}

let phoneId = process.argv[3];
if (!phoneId) {
  const c = new pg.Client({ connectionString: process.env.MIGRATION_DATABASE_URL });
  await c.connect();
  // Con app_owner no hay FORCE RLS en tenant_integrations, así que se puede leer.
  const r = await c.query("SELECT external_id FROM tenant_integrations WHERE provider = 'whatsapp' LIMIT 1");
  await c.end();
  phoneId = r.rows[0]?.external_id;
}
if (!phoneId) {
  console.error("✖ No hay ningún número conectado. Conéctalo primero en /whatsapp.");
  process.exit(1);
}

const now = Math.floor(Date.now() / 1000);
const body = JSON.stringify({
  object: "whatsapp_business_account",
  entry: [{ id: "0", changes: [{ field: "messages", value: {
    messaging_product: "whatsapp",
    metadata: { display_phone_number: "0", phone_number_id: phoneId },
    contacts: [{ wa_id: "584140000000", profile: { name: "Prueba local" } }],
    messages: [{ from: "584140000000", id: `wamid.PRUEBA${now}`, timestamp: String(now), type: "text", text: { body: "mensaje de prueba local" } }],
  } }] }],
});
const sig = "sha256=" + createHmac("sha256", secret).update(body).digest("hex");

const url = `${base}/api/webhooks/whatsapp`;
try {
  const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json", "x-hub-signature-256": sig }, body });
  console.log(`POST ${url}\n→ ${res.status} ${(await res.text()).slice(0, 200)}`);
  if (res.status === 200) console.log("✔ Tu app lo aceptó. Revisa la tabla messages: debe aparecer 'mensaje de prueba local'.");
  if (res.status === 401) console.log("✖ Firma rechazada: el WHATSAPP_APP_SECRET del servidor no coincide con el de este script (¿reiniciaste npm run dev?).");
} catch (e) {
  console.log(`✖ No se pudo llegar a ${url}: ${e.message}`);
}
